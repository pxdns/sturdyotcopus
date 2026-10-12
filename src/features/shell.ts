import type * as vscode from 'vscode'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { PyWorker } from '../python/client'
import { LineTerminalProcess, PROFILE_SHELL, registerTerminalKind } from '../terminal/backend'

type Vscode = typeof vscode

// A small bash-like shell that runs inside the page, on the workspace files. It is NOT real bash: there are no processes,
// no package managers and no native programs. For a real bash, JDK, Gradle and git use the Remote runner.

interface Result { out: string; err: string; code: number }
class ShellError extends Error {}
const fail = (m: string): never => { throw new ShellError(m) }

const dec = new TextDecoder()
const enc = new TextEncoder()

export function activateShell(vs: Vscode): void {
  registerTerminalKind(PROFILE_SHELL, () => new ShellProcess(vs))
  vs.commands.registerCommand('luma.shell.open', () => {
    void vs.commands.executeCommand('workbench.action.terminal.newWithProfile', { profileName: 'Shell' })
  })
}

class ShellProcess extends LineTerminalProcess {
  private dir = '/'
  private readonly env = new Map<string, string>([['HOME', '/'], ['USER', 'luma'], ['SHELL', '/bin/luma-sh']])
  private py?: PyWorker
  private running = false

  constructor(private readonly vs: Vscode) {
    super(new Emitter<string>())
  }

  protected banner(): string {
    return 'Luma shell: a bash-like shell for the files in your workspace. Type "help" for commands.\nThis is not full bash. For real bash, a JDK, Gradle and git, use "Remote Runner: Open Terminal".\n'
  }
  protected prompt(): string {
    return `\u001b[32mluma\u001b[0m:\u001b[34m${this.dir === '/' ? '~' : '~' + this.dir}\u001b[0m$ `
  }
  protected override interrupt(): void {
    if (this.py) { this.py.terminate('interrupted'); this.py = undefined }
    this.write('^C\n')
  }

  // ---- paths
  private norm(p: string): string {
    const base = p.startsWith('/') ? [] : this.dir.split('/').filter(Boolean)
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') base.pop()
      else base.push(seg)
    }
    return '/' + base.join('/')
  }
  private uri(p: string): vscode.Uri {
    const root = this.vs.workspace.workspaceFolders?.[0]?.uri
    if (!root) return fail('no workspace folder is open')
    const n = this.norm(p)
    return n === '/' ? root : this.vs.Uri.joinPath(root, n.slice(1))
  }
  private async stat(p: string): Promise<vscode.FileStat | undefined> {
    try { return await this.vs.workspace.fs.stat(this.uri(p)) } catch { return undefined }
  }
  private async readText(p: string): Promise<string> {
    try { return dec.decode(await this.vs.workspace.fs.readFile(this.uri(p))) } catch { return fail(`${p}: No such file or directory`) }
  }
  private async ls(p: string): Promise<[string, vscode.FileType][]> {
    try { return (await this.vs.workspace.fs.readDirectory(this.uri(p))).sort((a, b) => a[0].localeCompare(b[0])) } catch { return fail(`${p}: No such file or directory`) }
  }
  private refresh(): void { void this.vs.commands.executeCommand('workbench.files.action.refreshFilesExplorer') }

  /** Expands * and ? in an argument against the directory contents. */
  private async glob(arg: string): Promise<string[]> {
    if (!/[*?]/.test(arg)) return [arg]
    const slash = arg.lastIndexOf('/')
    const dir = slash >= 0 ? arg.slice(0, slash + 1) : ''
    const pat = arg.slice(slash + 1)
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    let entries: [string, vscode.FileType][] = []
    try { entries = await this.ls(dir || '.') } catch { return [arg] }
    const hits = entries.filter(([n]) => re.test(n) && (pat.startsWith('.') || !n.startsWith('.'))).map(([n]) => dir + n)
    return hits.length ? hits : [arg]
  }

  // ---- parsing
  private tokenize(line: string): { words: string[]; ops: string[] } | undefined {
    const words: string[] = []
    const ops: string[] = []
    let cur = ''
    let has = false
    let quote = ''
    const push = (): void => { if (has) { words.push(cur); cur = ''; has = false } }
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quote) {
        if (c === quote) quote = ''
        else if (c === '$' && quote === '"') {
          const m = /^\$\{?(\w+|\?)\}?/.exec(line.slice(i))
          if (m) { cur += this.env.get(m[1]!) ?? ''; i += m[0].length - 1 } else cur += c
        } else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
        else cur += c
        continue
      }
      if (c === '"' || c === "'") { quote = c; has = true }
      else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true }
      else if (c === ' ' || c === '\t') push()
      else if (c === '#' && !has) break
      else if (c === '|' || c === ';' || c === '&' || c === '>' || c === '<') {
        push()
        let op = c
        if ((c === '&' || c === '|' || c === '>') && line[i + 1] === c) { op += c; i++ }
        ops.push(op); words.push('\u0000' + op)
      } else if (c === '$') {
        const m = /^\$\{?(\w+|\?)\}?/.exec(line.slice(i))
        if (m) { cur += this.env.get(m[1]!) ?? ''; i += m[0].length - 1 } else cur += c
        has = true
      } else if (c === '~' && !has && (i + 1 >= line.length || /[\s/]/.test(line[i + 1]!))) { cur += this.env.get('HOME') ?? '/'; has = true }
      else { cur += c; has = true }
    }
    if (quote) { this.write("bash: unexpected EOF while looking for matching quote\n"); return undefined }
    push()
    return { words, ops }
  }

  protected async onLine(line: string): Promise<void> {
    if (!line.trim()) return
    this.running = true
    try {
      const t = this.tokenize(line)
      if (!t) return
      // split into commands joined by ; && ||
      const seq: { words: string[]; join: string }[] = []
      let cur: string[] = []
      let join = ';'
      for (const w of t.words) {
        if (w === '\u0000;' || w === '\u0000&&' || w === '\u0000||') { seq.push({ words: cur, join }); cur = []; join = w.slice(1) } else cur.push(w)
      }
      seq.push({ words: cur, join })
      let code = 0
      for (const part of seq) {
        if (part.join === '&&' && code !== 0) continue
        if (part.join === '||' && code === 0) continue
        if (!part.words.length) continue
        code = await this.pipeline(part.words)
        this.env.set('?', String(code))
      }
    } catch (e) {
      this.write(`bash: ${e instanceof Error ? e.message : String(e)}\n`)
    } finally {
      this.running = false
    }
  }

  private async pipeline(words: string[]): Promise<number> {
    // stages split by |, redirections on the last stage
    const stages: string[][] = [[]]
    for (const w of words) { if (w === '\u0000|') stages.push([]); else stages[stages.length - 1]!.push(w) }
    let input = ''
    let result: Result = { out: '', err: '', code: 0 }
    for (let i = 0; i < stages.length; i++) {
      let args = stages[i]!
      let redirect: { file: string; append: boolean } | undefined
      let inFile: string | undefined
      const clean: string[] = []
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!
        if (a === '\u0000>' || a === '\u0000>>') redirect = { file: args[++k] ?? fail('syntax error near unexpected token `newline\''), append: a === '\u0000>>' }
        else if (a === '\u0000<') inFile = args[++k] ?? fail('syntax error near unexpected token `newline\'')
        else if (a.startsWith('\u0000')) fail(`syntax error near unexpected token \`${a.slice(1)}'`)
        else clean.push(a)
      }
      args = clean
      if (inFile) input = await this.readText(inFile)
      const expanded: string[] = [args[0] ?? '']
      for (const a of args.slice(1)) expanded.push(...(await this.glob(a)))
      result = await this.run(expanded, input)
      if (result.err) this.write(result.err)
      input = result.out
      if (redirect) {
        const prior = redirect.append ? await this.readText(redirect.file).catch(() => '') : ''
        await this.vs.workspace.fs.writeFile(this.uri(redirect.file), enc.encode(prior + result.out))
        this.refresh()
        result = { ...result, out: '' }
      }
    }
    if (result.out) this.write(result.out)
    return result.code
  }

  private async run(argv: string[], stdin: string): Promise<Result> {
    const [cmd, ...a] = argv
    if (!cmd) return { out: '', err: '', code: 0 }
    try {
      const out = await this.exec(cmd, a, stdin)
      return { out, err: '', code: 0 }
    } catch (e) {
      if (e instanceof ShellError) return { out: '', err: `${cmd}: ${e.message}\n`, code: 1 }
      return { out: '', err: `${cmd}: ${e instanceof Error ? e.message : String(e)}\n`, code: 1 }
    }
  }

  private flags(a: string[]): { flags: Set<string>; rest: string[] } {
    const flags = new Set<string>()
    const rest: string[] = []
    for (const x of a) { if (/^-[a-zA-Z]+$/.test(x)) for (const ch of x.slice(1)) flags.add(ch); else rest.push(x) }
    return { flags, rest }
  }

  private async walk(p: string, depth = 0, acc: string[] = []): Promise<string[]> {
    for (const [name, type] of await this.ls(p)) {
      if (name === '.git' || name === 'node_modules') continue
      const child = (p === '/' ? '' : p.replace(/\/$/, '')) + '/' + name
      acc.push(child)
      if (type === this.vs.FileType.Directory && depth < 12) await this.walk(child, depth + 1, acc)
    }
    return acc
  }

  private async exec(cmd: string, a: string[], stdin: string): Promise<string> {
    const fs = this.vs.workspace.fs
    const { flags, rest } = this.flags(a)
    switch (cmd) {
      case 'help':
        return 'Commands: cd pwd ls cat echo mkdir touch rm cp mv head tail wc grep find tree sort uniq tee date env export clear history which open python help\n' +
          'Pipes (|), redirects (> >> <), && || ;, quotes, $VARS and * globs work.\n' +
          'Not available here: git, npm, java, gradle and other native programs. Use the Remote runner for those.\n'
      case 'pwd': return this.dir + '\n'
      case 'cd': {
        const target = this.norm(rest[0] ?? '/')
        const s = await this.stat(target)
        if (!s) return fail(`${rest[0]}: No such file or directory`)
        if (s.type !== this.vs.FileType.Directory) return fail(`${rest[0]}: Not a directory`)
        this.dir = target
        return ''
      }
      case 'ls': {
        const targets = rest.length ? rest : ['.']
        let out = ''
        for (const t of targets) {
          const s = await this.stat(t)
          if (!s) return fail(`cannot access '${t}': No such file or directory`)
          const entries: [string, vscode.FileType][] = s.type === this.vs.FileType.Directory ? await this.ls(t) : [[t.split('/').pop()!, s.type]]
          const shown = entries.filter(([n]) => flags.has('a') || !n.startsWith('.'))
          if (targets.length > 1) out += `${t}:\n`
          if (flags.has('l')) {
            for (const [n, ty] of shown) {
              const full = (s.type === this.vs.FileType.Directory ? t.replace(/\/$/, '') + '/' : '') + (s.type === this.vs.FileType.Directory ? n : '')
              const st = await this.stat(s.type === this.vs.FileType.Directory ? full : t)
              const isDir = ty === this.vs.FileType.Directory
              out += `${isDir ? 'd' : '-'}rw-r--r-- ${String(st?.size ?? 0).padStart(8)} ${n}${isDir ? '/' : ''}\n`
            }
          } else out += shown.map(([n, ty]) => (ty === this.vs.FileType.Directory ? `\u001b[34m${n}/\u001b[0m` : n)).join('  ') + (shown.length ? '\n' : '')
        }
        return out
      }
      case 'cat': {
        if (!rest.length) return stdin
        let out = ''
        for (const f of rest) out += await this.readText(f)
        return out
      }
      case 'echo': {
        const text = a.filter((x) => x !== '-n').join(' ')
        return a[0] === '-n' ? text : text + '\n'
      }
      case 'mkdir': {
        if (!rest.length) return fail('missing operand')
        for (const d of rest) {
          if (!flags.has('p') && (await this.stat(d))) return fail(`cannot create directory '${d}': File exists`)
          if (!flags.has('p') && !(await this.stat(this.norm(d + '/..')))) return fail(`cannot create directory '${d}': No such file or directory`)
          await fs.createDirectory(this.uri(d))
        }
        this.refresh()
        return ''
      }
      case 'touch': {
        for (const f of rest) if (!(await this.stat(f))) await fs.writeFile(this.uri(f), new Uint8Array())
        this.refresh()
        return ''
      }
      case 'rm': {
        if (!rest.length) return fail('missing operand')
        for (const f of rest) {
          const s = await this.stat(f)
          if (!s) { if (flags.has('f')) continue; return fail(`cannot remove '${f}': No such file or directory`) }
          if (s.type === this.vs.FileType.Directory && !flags.has('r') && !flags.has('R')) return fail(`cannot remove '${f}': Is a directory`)
          if (this.norm(f) === '/') return fail('refusing to remove the workspace root')
          await fs.delete(this.uri(f), { recursive: true, useTrash: false })
        }
        this.refresh()
        return ''
      }
      case 'cp':
      case 'mv': {
        if (rest.length < 2) return fail('missing destination file operand')
        const dest = rest[rest.length - 1]!
        const destStat = await this.stat(dest)
        const srcs = rest.slice(0, -1)
        if (srcs.length > 1 && destStat?.type !== this.vs.FileType.Directory) return fail(`target '${dest}' is not a directory`)
        for (const s of srcs) {
          if (!(await this.stat(s))) return fail(`cannot stat '${s}': No such file or directory`)
          const to = destStat?.type === this.vs.FileType.Directory ? dest.replace(/\/$/, '') + '/' + s.split('/').filter(Boolean).pop() : dest
          if (cmd === 'cp') await fs.copy(this.uri(s), this.uri(to), { overwrite: true })
          else await fs.rename(this.uri(s), this.uri(to), { overwrite: true })
        }
        this.refresh()
        return ''
      }
      case 'head':
      case 'tail': {
        const nIdx = a.indexOf('-n')
        const n = nIdx >= 0 ? Number(a[nIdx + 1]) : 10
        const files = rest.filter((x) => x !== String(n))
        const text = files.length ? await this.readText(files[0]!) : stdin
        const lines = text.split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        return (cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') + '\n'
      }
      case 'wc': {
        const text = rest.length ? await this.readText(rest[0]!) : stdin
        const l = (text.match(/\n/g) ?? []).length, w = text.split(/\s+/).filter(Boolean).length
        if (flags.has('l')) return `${l}\n`
        if (flags.has('w')) return `${w}\n`
        if (flags.has('c')) return `${enc.encode(text).length}\n`
        return `${l} ${w} ${enc.encode(text).length}${rest[0] ? ' ' + rest[0] : ''}\n`
      }
      case 'grep': {
        const pat = rest[0]
        if (pat === undefined) return fail('missing pattern')
        let re: RegExp
        try { re = new RegExp(pat, flags.has('i') ? 'i' : '') } catch { return fail('invalid pattern') }
        const files = rest.slice(1)
        const sources = files.length ? await Promise.all(files.map(async (f) => ({ f, text: await this.readText(f) }))) : [{ f: '', text: stdin }]
        let out = ''
        for (const { f, text } of sources) {
          text.split('\n').forEach((ln, i) => {
            if (re.test(ln) !== flags.has('v')) out += `${files.length > 1 ? f + ':' : ''}${flags.has('n') ? i + 1 + ':' : ''}${ln}\n`
          })
        }
        return out
      }
      case 'find': {
        const start = rest[0] && !rest[0].startsWith('-') ? rest[0] : '.'
        const nameIdx = a.indexOf('-name')
        const name = nameIdx >= 0 ? a[nameIdx + 1] : undefined
        const re = name ? new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : undefined
        const base = this.norm(start)
        const found = await this.walk(base)
        const rel = (p: string): string => (start === '.' ? '.' + p.slice(base === '/' ? 0 : base.length) : start.replace(/\/$/, '') + p.slice(base === '/' ? 0 : base.length))
        return found.filter((p) => !re || re.test(p.split('/').pop()!)).map((p) => rel(p) + '\n').join('')
      }
      case 'tree': {
        const base = this.norm(rest[0] ?? '.')
        const build = async (p: string, prefix: string): Promise<string> => {
          const entries = (await this.ls(p)).filter(([n]) => n !== '.git' && n !== 'node_modules')
          let out = ''
          for (let i = 0; i < entries.length; i++) {
            const [n, ty] = entries[i]!
            const last = i === entries.length - 1
            out += `${prefix}${last ? '└── ' : '├── '}${n}\n`
            if (ty === this.vs.FileType.Directory) out += await build((p === '/' ? '' : p) + '/' + n, prefix + (last ? '    ' : '│   '))
          }
          return out
        }
        return `${rest[0] ?? '.'}\n${await build(base, '')}`
      }
      case 'sort': {
        const text = rest.length ? await this.readText(rest[0]!) : stdin
        const lines = text.split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1)
        lines.sort((x, y) => (flags.has('n') ? parseFloat(x) - parseFloat(y) : x.localeCompare(y)))
        if (flags.has('r')) lines.reverse()
        return lines.join('\n') + '\n'
      }
      case 'uniq': {
        const lines = (rest.length ? await this.readText(rest[0]!) : stdin).split('\n')
        return lines.filter((l, i) => l !== lines[i - 1]).join('\n')
      }
      case 'tee': {
        for (const f of rest) await fs.writeFile(this.uri(f), enc.encode(stdin))
        this.refresh()
        return stdin
      }
      case 'date': return new Date().toString() + '\n'
      case 'whoami': return 'luma\n'
      case 'clear': return '\u001b[2J\u001b[H'
      case 'env': return [...this.env].filter(([k]) => k !== '?').map(([k, v]) => `${k}=${v}\n`).join('')
      case 'export': {
        for (const x of a) { const m = /^(\w+)=(.*)$/.exec(x); if (m) this.env.set(m[1]!, m[2]!) }
        return ''
      }
      case 'history': return ''
      case 'which': return rest.map((c) => `${c}: shell built-in\n`).join('')
      case 'open':
      case 'code': {
        if (!rest.length) return fail('missing file')
        for (const f of rest) await this.vs.window.showTextDocument(this.uri(f))
        return ''
      }
      case 'python':
      case 'python3': return this.python(a)
      case 'exit': return 'Close this terminal with the trash icon or Ctrl+D.\n'
      case 'node': case 'git': case 'npm': case 'npx': case 'yarn': case 'pnpm': case 'java': case 'javac': case 'gradle': case 'gradlew': case './gradlew': case 'mvn': case 'pip': case 'apt': case 'sudo': case 'curl': case 'wget':
        return fail('not available in the in-browser shell. Open "Remote Runner: Open Terminal" for a real bash with these tools.')
      default:
        return fail('command not found (this is the in-browser Luma shell, not full bash. Type "help".)')
    }
  }

  private async python(a: string[]): Promise<string> {
    if (!a.length) {
      void this.vs.commands.executeCommand('workbench.action.terminal.newWithProfile', { profileName: 'Python' })
      return 'Opened a Python terminal.\n'
    }
    const py = (this.py ??= new PyWorker('runtime'))
    py.onStdout = (d) => this.write(d)
    py.onStderr = (d) => this.write(d)
    py.onStdinRequest = async () => { py.provideInput(await this.readLine()) }
    let code: string
    let filename = '<string>'
    if (a[0] === '-c') code = a[1] ?? ''
    else { code = await this.readText(a[0]!); filename = a[0]!.split('/').pop()! }
    try {
      const status = await py.call<number>('run', { code, filename })
      if (status) this.write(`[exit code ${status}]\n`)
    } catch (e) {
      this.write(`${e instanceof Error ? e.message : String(e)}\n`)
      this.py = undefined
    }
    return ''
  }
}
