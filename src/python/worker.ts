/// <reference lib="webworker" />
// Runs Pyodide (CPython on WebAssembly) off the main thread. Used for three jobs, each in its own worker:
//   "runtime": execute files, "repl": the interactive terminal, "lint": syntax checks and introspection.

interface PyodideApi {
  runPython(code: string, options?: unknown): unknown
  globals: { get(name: string): unknown; set(name: string, value: unknown): void }
  setStdin(options: { stdin: () => string | undefined }): void
  setStdout(options: { write: (buf: Uint8Array) => number }): void
  setStderr(options: { write: (buf: Uint8Array) => number }): void
  version: string
}

const ctx = self as unknown as DedicatedWorkerGlobalScope
const post = (message: unknown): void => ctx.postMessage(message)

let pyodide: PyodideApi
let stdinState: Int32Array | undefined
let stdinBytes: Uint8Array | undefined

const HELPERS = `
import ast, builtins, importlib, inspect, json, sys, traceback

def __luma_run(src, fn):
    ns = {'__name__': '__main__', '__file__': fn}
    try:
        exec(compile(src, fn, 'exec'), ns)
        return 0
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        et, ev, tb = sys.exc_info()
        traceback.print_exception(et, ev, tb.tb_next if tb else None)
        return 1

def __luma_check(src):
    try:
        ast.parse(src)
        return None
    except SyntaxError as e:
        return json.dumps([e.lineno or 1, e.offset or 1, e.msg, e.end_lineno or e.lineno or 1, e.end_offset or e.offset or 1])

def __luma_symbols(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return '[]'
    out = []
    def visit(node, parent):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kind = 'class' if isinstance(child, ast.ClassDef) else ('method' if parent == 'class' else 'function')
                out.append([kind, child.name, child.lineno, child.col_offset, child.end_lineno, child.end_col_offset, parent])
                visit(child, 'class' if isinstance(child, ast.ClassDef) else 'function')
            elif isinstance(child, ast.Assign) and parent == 'module':
                for t in child.targets:
                    if isinstance(t, ast.Name):
                        out.append(['variable', t.id, child.lineno, child.col_offset, child.end_lineno, child.end_col_offset, parent])
                visit(child, parent)
            else:
                visit(child, parent)
    visit(tree, 'module')
    return json.dumps(out)

def __luma_names(src):
    names = set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return '[]'
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
            if not isinstance(n, ast.ClassDef):
                for a in n.args.args + n.args.kwonlyargs:
                    names.add(a.arg)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            names.add(n.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                names.add((a.asname or a.name).split('.')[0])
    return json.dumps(sorted(names))

def __luma_members(mod):
    try:
        m = importlib.import_module(mod)
    except Exception:
        return '[]'
    out = []
    for n in dir(m):
        if n.startswith('__'):
            continue
        try:
            out.append([n, 'f' if callable(getattr(m, n)) else 'v'])
        except Exception:
            out.append([n, 'v'])
    return json.dumps(out)

def __luma_doc(path):
    parts = path.split('.')
    try:
        if len(parts) == 1:
            obj = getattr(builtins, parts[0])
        else:
            obj = getattr(importlib.import_module('.'.join(parts[:-1])), parts[-1])
    except Exception:
        return None
    try:
        sig = str(inspect.signature(obj))
    except Exception:
        sig = ''
    return json.dumps([sig, inspect.getdoc(obj) or ''])

def __luma_builtins():
    return json.dumps(sorted(n for n in dir(builtins) if not n.startswith('_')))
`

function decoder(kind: 'stdout' | 'stderr'): (buf: Uint8Array) => number {
  const dec = new TextDecoder()
  return (buf) => {
    post({ type: kind, data: dec.decode(buf, { stream: true }) })
    return buf.length
  }
}

async function init(buffer?: SharedArrayBuffer): Promise<void> {
  if (buffer) {
    stdinState = new Int32Array(buffer, 0, 2)
    stdinBytes = new Uint8Array(buffer, 8)
  }
  const url = '/pyodide/pyodide.mjs' // served from our own origin (scripts/copy-pyodide.mjs)
  const mod = (await import(/* @vite-ignore */ url)) as { loadPyodide: (o: unknown) => Promise<PyodideApi> }
  pyodide = await mod.loadPyodide({ indexURL: '/pyodide/' })
  pyodide.setStdout({ write: decoder('stdout') })
  pyodide.setStderr({ write: decoder('stderr') })
  pyodide.setStdin({
    stdin: () => {
      if (!stdinState || !stdinBytes) return undefined // no SharedArrayBuffer: behave as end of input
      Atomics.store(stdinState, 0, 1)
      post({ type: 'stdin-request' })
      Atomics.wait(stdinState, 0, 1)
      const length = Atomics.load(stdinState, 1)
      const state = Atomics.load(stdinState, 0)
      Atomics.store(stdinState, 0, 0)
      if (state === 3 || length < 0) return undefined // cancelled
      return new TextDecoder().decode(stdinBytes.slice(0, length))
    }
  })
  pyodide.runPython(HELPERS)
}

/** Drops Pyodide's own debugging hint from error text. */
const clean = (text: string): string => String(text).replace(/\n?For more information about the cause of this error, use `pyodide\.setDebug\(true\)`\n?/g, '\n')

const call = (fn: string, ...args: unknown[]): unknown => {
  args.forEach((a, i) => pyodide.globals.set(`__arg${i}`, a))
  return pyodide.runPython(`${fn}(${args.map((_, i) => `__arg${i}`).join(', ')})`)
}

interface ReplConsole {
  push(line: string): { syntax_check: string; formatted_error?: string } & PromiseLike<unknown>
  stdout_callback: unknown
}
let repl: ReplConsole | undefined

ctx.onmessage = async (event: MessageEvent) => {
  const m = event.data as { type: string; id?: number; [k: string]: unknown }
  const reply = (ok: boolean, value?: unknown, error?: string): void => post({ type: 'result', id: m.id, ok, value, error })
  try {
    switch (m.type) {
      case 'init':
        await init(m.buffer as SharedArrayBuffer | undefined)
        post({ type: 'ready', version: pyodide.version })
        break
      case 'run':
        reply(true, call('__luma_run', m.code, m.filename))
        break
      case 'check':
      case 'symbols':
      case 'names':
      case 'members':
      case 'doc': {
        const fn = { check: '__luma_check', symbols: '__luma_symbols', names: '__luma_names', members: '__luma_members', doc: '__luma_doc' }[m.type]
        const arg = m.type === 'members' ? m.module : m.type === 'doc' ? m.path : m.code
        const out = call(fn!, arg)
        reply(true, out ?? null)
        break
      }
      case 'builtins':
        reply(true, call('__luma_builtins'))
        break
      case 'repl-init': {
        pyodide.runPython(`from pyodide.console import PyodideConsole
import __main__
__luma_repl = PyodideConsole(__main__.__dict__)`)
        repl = pyodide.globals.get('__luma_repl') as ReplConsole
        reply(true)
        break
      }
      case 'repl-push': {
        if (!repl) throw new Error('REPL not initialised')
        const future = repl.push(String(m.line))
        const status = future.syntax_check
        if (status === 'complete') {
          let shown: string | undefined
          try {
            const value = await future
            if (value !== undefined) {
              pyodide.globals.set('__arg0', value)
              shown = String(pyodide.runPython('repr(__arg0)'))
            }
          } catch (error) {
            // Keep only the part of the traceback that belongs to the user's code.
            const lines = String((error as Error).message ?? error).split('\n')
            const i = lines.findIndex((l) => l.includes('File "<console>"'))
            post({ type: 'stderr', data: clean(i >= 0 ? ['Traceback (most recent call last):', ...lines.slice(i)].join('\n') : lines.join('\n')) })
          }
          reply(true, { status, shown })
        } else {
          if (status === 'syntax-error') post({ type: 'stderr', data: clean(future.formatted_error ?? 'SyntaxError') })
          reply(true, { status })
        }
        break
      }
      default:
        reply(false, undefined, `unknown message ${m.type}`)
    }
  } catch (error) {
    if (m.type === 'init') post({ type: 'init-error', error: String(error) })
    else reply(false, undefined, String(error))
  }
}
