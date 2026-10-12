import type * as vscode from 'vscode'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { PyWorker } from '../python/client'
import { LineTerminalProcess, PROFILE_PYTHON, registerTerminalKind } from '../terminal/backend'

type Vscode = typeof vscode

const KEYWORDS = ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']

/** Python REPL terminal: a Pyodide console behind a line editor. */
class PythonReplProcess extends LineTerminalProcess {
  private worker = new PyWorker('repl')
  private more = false
  private started?: Promise<void>

  constructor() {
    super(new Emitter<string>())
    this.worker.onStdout = (d) => this.write(d)
    this.worker.onStderr = (d) => this.write(d)
  }

  protected banner(): string {
    return 'Python (Pyodide) - type Python code. Ctrl+L clears the screen.\n'
  }
  protected prompt(): string {
    return this.more ? '... ' : '>>> '
  }
  protected override interrupt(): void {
    this.worker.terminate('interrupted')
    this.started = undefined
    this.more = false
    this.write('\nKeyboardInterrupt (the interpreter was restarted)\n')
  }
  protected async onLine(line: string): Promise<void> {
    try {
      this.started ??= this.worker.call('repl-init').then(() => undefined)
      await this.started
      const r = await this.worker.call<{ status: string; shown?: string }>('repl-push', { line })
      this.more = r.status === 'incomplete'
      if (r.shown !== undefined) this.write(r.shown + '\n')
    } catch (e) {
      this.more = false
      this.write(`${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
}

export function activatePython(vs: Vscode): void {
  const runtime = new PyWorker('runtime')
  const lint = new PyWorker('lint')
  const out = vs.window.createOutputChannel('Python')
  const diagnostics = vs.languages.createDiagnosticCollection('python')
  let running = false
  const setRunning = (v: boolean): void => {
    running = v
    void vs.commands.executeCommand('setContext', 'luma.python.running', v)
  }
  const isPython = (d: vscode.TextDocument): boolean => d.languageId === 'python'

  registerTerminalKind(PROFILE_PYTHON, () => new PythonReplProcess())

  // ----- run / stop / REPL
  runtime.onStdout = (d) => out.append(d)
  runtime.onStderr = (d) => out.append(d)
  runtime.onStdinRequest = async () => {
    const value = await vs.window.showInputBox({ prompt: 'Python input()', placeHolder: 'Type a line and press Enter (Esc to cancel)', ignoreFocusOut: true })
    runtime.provideInput(value)
  }

  const run = async (): Promise<void> => {
    const editor = vs.window.activeTextEditor
    if (!editor || !isPython(editor.document)) {
      void vs.window.showInformationMessage('Open a Python file to run it.')
      return
    }
    if (running) return
    const name = editor.document.fileName.split('/').pop() ?? 'main.py'
    out.clear()
    out.show(true)
    out.appendLine(`> python ${name}`)
    setRunning(true)
    try {
      const code = await runtime.call<number>('run', { code: editor.document.getText(), filename: name })
      out.appendLine(`\n[Process finished with exit code ${code}]`)
    } catch (e) {
      out.appendLine(`\n[${e instanceof Error ? e.message : String(e)}]`)
    } finally {
      setRunning(false)
    }
  }

  const reg = vs.commands.registerCommand
  const disposables: vscode.Disposable[] = [
    reg('luma.python.run', run),
    reg('luma.python.stop', () => {
      if (running) runtime.terminate('Stopped by user')
    }),
    reg('luma.python.restart', () => {
      runtime.terminate('Interpreter restarted')
      void vs.window.showInformationMessage('Python interpreter restarted.')
    }),
    reg('luma.python.repl', () => {
      void vs.commands.executeCommand('workbench.action.terminal.newWithProfile', { profileName: 'Python' })
    })
  ]

  // ----- diagnostics (syntax errors from Python's own parser)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const check = async (doc: vscode.TextDocument): Promise<void> => {
    if (!isPython(doc)) return
    try {
      const raw = await lint.call<string | null>('check', { code: doc.getText() })
      if (!raw) return void diagnostics.set(doc.uri, [])
      const [line, col, msg, endLine, endCol] = JSON.parse(raw) as [number, number, string, number, number]
      const range = new vs.Range(Math.max(0, line - 1), Math.max(0, col - 1), Math.max(0, endLine - 1), Math.max(col, endCol - 1))
      const d = new vs.Diagnostic(range, msg, vs.DiagnosticSeverity.Error)
      d.source = 'Python'
      diagnostics.set(doc.uri, [d])
    } catch {
      /* worker restarting; try again on the next change */
    }
  }
  const schedule = (doc: vscode.TextDocument): void => {
    if (!isPython(doc)) return
    const key = doc.uri.toString()
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => void check(doc), 400))
  }
  disposables.push(
    vs.workspace.onDidOpenTextDocument(schedule),
    vs.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vs.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri))
  )
  vs.workspace.textDocuments.forEach(schedule)

  // ----- outline
  const kinds: Record<string, vscode.SymbolKind> = {
    class: vs.SymbolKind.Class,
    function: vs.SymbolKind.Function,
    method: vs.SymbolKind.Method,
    variable: vs.SymbolKind.Variable
  }
  disposables.push(
    vs.languages.registerDocumentSymbolProvider('python', {
      async provideDocumentSymbols(doc) {
        const raw = JSON.parse(await lint.call<string>('symbols', { code: doc.getText() })) as [string, string, number, number, number, number, string][]
        const roots: vscode.DocumentSymbol[] = []
        const stack: vscode.DocumentSymbol[] = []
        for (const [kind, name, l1, c1, l2, c2] of raw.sort((a, b) => a[2] - b[2] || a[3] - b[3])) {
          const range = new vs.Range(l1 - 1, c1, l2 - 1, c2)
          const sym = new vs.DocumentSymbol(name, '', kinds[kind] ?? vs.SymbolKind.Variable, range, new vs.Range(l1 - 1, c1, l1 - 1, c1 + name.length))
          while (stack.length && !stack[stack.length - 1]!.range.contains(range)) stack.pop()
          if (stack.length) stack[stack.length - 1]!.children.push(sym)
          else roots.push(sym)
          if (kind === 'class' || kind === 'function' || kind === 'method') stack.push(sym)
        }
        return roots
      }
    })
  )

  // ----- completion and hover (names from the file, built-ins, real stdlib members)
  let builtinNames: string[] | undefined
  const builtins = async (): Promise<string[]> => (builtinNames ??= JSON.parse(await lint.call<string>('builtins')) as string[])
  const importMap = (text: string): Map<string, string> => {
    const map = new Map<string, string>()
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) map.set(m[2] ?? m[1]!.split('.')[0]!, m[2] ? m[1]! : m[1]!.split('.')[0]!)
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(\w+)(?:\s+as\s+(\w+))?/gm)) map.set(m[3] ?? m[2]!, `${m[1]}.${m[2]}`)
    return map
  }
  disposables.push(
    vs.languages.registerCompletionItemProvider(
      'python',
      {
        async provideCompletionItems(doc, pos) {
          const prefix = doc.lineAt(pos).text.slice(0, pos.character)
          const dotted = /([A-Za-z_][\w.]*)\.(\w*)$/.exec(prefix)
          if (dotted) {
            const base = dotted[1]!
            const mod = importMap(doc.getText()).get(base.split('.')[0]!)
            if (!mod) return []
            const target = base.includes('.') ? `${mod}.${base.split('.').slice(1).join('.')}` : mod
            const members = JSON.parse(await lint.call<string>('members', { module: target })) as [string, string][]
            return members.map(([n, k]) => {
              const item = new vs.CompletionItem(n, k === 'f' ? vs.CompletionItemKind.Function : vs.CompletionItemKind.Variable)
              item.detail = `${target}.${n}`
              return item
            })
          }
          const items: vscode.CompletionItem[] = []
          for (const k of KEYWORDS) items.push(new vs.CompletionItem(k, vs.CompletionItemKind.Keyword))
          for (const n of await builtins()) items.push(new vs.CompletionItem(n, /^[A-Z]/.test(n) ? vs.CompletionItemKind.Class : vs.CompletionItemKind.Function))
          for (const n of JSON.parse(await lint.call<string>('names', { code: doc.getText() })) as string[]) items.push(new vs.CompletionItem(n, vs.CompletionItemKind.Variable))
          return items
        }
      },
      '.'
    ),
    vs.languages.registerHoverProvider('python', {
      async provideHover(doc, pos) {
        const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_][\w.]*/)
        if (!range) return undefined
        const word = doc.getText(range)
        const head = word.split('.')[0]!
        const mod = importMap(doc.getText()).get(head)
        const path = word.includes('.') ? (mod ? `${mod}.${word.split('.').slice(1).join('.')}` : undefined) : mod ?? ((await builtins()).includes(word) ? word : undefined)
        if (!path) return undefined
        const raw = await lint.call<string | null>('doc', { path })
        if (!raw) return undefined
        const [sig, text] = JSON.parse(raw) as [string, string]
        const md = new vs.MarkdownString()
        md.appendCodeblock(`${path}${sig}`, 'python')
        if (text) md.appendText(text.split('\n\n')[0]!)
        return new vs.Hover(md, range)
      }
    })
  )

  void disposables
}
