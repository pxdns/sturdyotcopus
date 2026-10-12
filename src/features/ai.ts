import type * as vscode from 'vscode'
import { getSession } from '../github/auth'
import { chatHtml } from '../ai/view'
import { complete, streamTurn, type Msg, type ProviderConfig, type ToolDef } from '../ai/providers'

type Vscode = typeof vscode

const KEY_PREFIX = 'luma.ai.key.'
const MAX_STEPS = 12
const MAX_READ = 60_000

const getKey = (p: string): string => { try { return localStorage.getItem(KEY_PREFIX + p) ?? '' } catch { return '' } }
const setKey = (p: string, v: string): void => { try { v ? localStorage.setItem(KEY_PREFIX + p, v) : localStorage.removeItem(KEY_PREFIX + p) } catch { /* storage blocked */ } }

const TOOLS: ToolDef[] = [
  { name: 'list_dir', description: 'List the entries of a directory in the workspace. Use "." for the root.', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'read_file', description: 'Read a text file from the workspace.', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'find_files', description: 'Find files by glob pattern, for example "**/*.java".', schema: { type: 'object', properties: { glob: { type: 'string' } }, required: ['glob'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the full new content. The user must approve each write.', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }
]

const SYSTEM = (agent: boolean): string => `You are the assistant inside Luma IDE, a code editor that runs in a browser tab. Be concise and concrete. Use fenced code blocks with a language tag for code.${agent ? `
You can inspect and change the open workspace with tools. Read the relevant files before changing them. Prefer small, targeted edits, and write whole files with write_file only after reading the current version. The user approves every write. When you are done, say briefly what you changed.
The browser cannot run a JVM or native toolchains. Do not claim to have run or tested code; suggest the commands for the user's terminal instead.` : `
You cannot see the workspace except for the file and selection the user shares in the message.`}`

/** The stored key for a provider choice; GitHub Models falls back to the GitHub sign-in token. */
const keyFor = (choice: string): string => getKey(choice) || (choice === 'github-models' ? (getSession()?.token ?? '') : '')

export function activateAi(vs: Vscode): void {
  const cfg = (): vscode.WorkspaceConfiguration => vs.workspace.getConfiguration('luma.ai')
  const provider = (): ProviderConfig => {
    const choice = cfg().get<string>('provider', 'github-models')
    const p = choice === 'anthropic' ? 'anthropic' : 'openai'
    const gh = choice === 'github-models'
    return {
      provider: p,
      apiKey: keyFor(choice),
      model: cfg().get<string>('model', '').trim() || (p === 'anthropic' ? 'claude-sonnet-5-5' : gh ? 'openai/gpt-4.1' : ''),
      baseUrl: cfg().get<string>('baseUrl', '').trim() || (gh ? 'https://models.github.ai/inference' : p === 'openai' ? 'https://api.openai.com/v1' : '')
    }
  }
  const askKey = async (): Promise<boolean> => {
    const p = cfg().get<string>('provider', 'github-models')
    const v = await vs.window.showInputBox({
      title: `API key for ${p === 'anthropic' ? 'Anthropic' : p === 'github-models' ? 'GitHub Models (a token with the models:read permission)' : 'the OpenAI-compatible endpoint'}`,
      prompt: 'Stored in this browser only (localStorage). It is sent to the provider you configured and nowhere else. Leave empty to remove it.',
      password: true, ignoreFocusOut: true
    })
    if (v === undefined) return false
    setKey(p, v.trim())
    return !!v.trim()
  }

  let view: vscode.WebviewView | undefined
  let history: Msg[] = []
  let abort: AbortController | undefined
  const approvals = new Map<string, (ok: boolean) => void>()
  const post = (m: unknown): void => { void view?.webview.postMessage(m) }

  const root = (): vscode.Uri | undefined => vs.workspace.workspaceFolders?.[0]?.uri
  const resolve = (p: string): vscode.Uri => {
    const base = root()
    if (!base) throw new Error('No workspace folder is open.')
    const clean = p.replace(/^\/+/, '').replace(/^\.\/?/, '')
    if (clean.split('/').includes('..')) throw new Error('Paths must stay inside the workspace.')
    return clean ? vs.Uri.joinPath(base, clean) : base
  }
  const decode = (b: Uint8Array): string => new TextDecoder().decode(b)

  async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const path = String(args.path ?? '')
    if (name === 'list_dir') {
      const entries = await vs.workspace.fs.readDirectory(resolve(path))
      return entries.map(([n, t]) => (t === vs.FileType.Directory ? n + '/' : n)).sort().join('\n') || '(empty)'
    }
    if (name === 'read_file') {
      const text = decode(await vs.workspace.fs.readFile(resolve(path)))
      return text.length > MAX_READ ? text.slice(0, MAX_READ) + '\n[truncated]' : text
    }
    if (name === 'find_files') {
      const found = await vs.workspace.findFiles(String(args.glob ?? '**/*'), '**/{node_modules,.git}/**', 100)
      return found.map((u) => vs.workspace.asRelativePath(u)).join('\n') || '(no matches)'
    }
    if (name === 'write_file') {
      const uri = resolve(path)
      await vs.workspace.fs.writeFile(uri, new TextEncoder().encode(String(args.content ?? '')))
      void vs.commands.executeCommand('workbench.files.action.refreshFilesExplorer')
      void vs.window.showTextDocument(uri, { preview: true, preserveFocus: true })
      return `Wrote ${path}`
    }
    throw new Error(`Unknown tool ${name}`)
  }
  const summary = (name: string, a: Record<string, unknown>): string => name === 'find_files' ? String(a.glob ?? '') : String(a.path ?? '')

  const ask = (name: string, a: Record<string, unknown>): Promise<boolean> =>
    new Promise((res) => {
      const id = Math.random().toString(36).slice(2)
      approvals.set(id, res)
      post({ type: 'approve', id, name, summary: `write ${summary(name, a)} (${String(a.content ?? '').length} characters)` })
    })

  async function context(withFile: boolean): Promise<string> {
    const ed = vs.window.activeTextEditor
    if (!withFile || !ed) return ''
    const sel = ed.selection.isEmpty ? '' : ed.document.getText(ed.selection)
    const rel = vs.workspace.asRelativePath(ed.document.uri)
    const body = ed.document.getText()
    return `\n\n[Open file: ${rel}, language: ${ed.document.languageId}]\n${sel ? `[Selected text]\n${sel}\n` : ''}${sel ? '' : '```\n' + (body.length > 20000 ? body.slice(0, 20000) + '\n[truncated]' : body) + '\n```'}`
  }

  async function handle(text: string, mode: 'chat' | 'agent', withFile: boolean): Promise<void> {
    const c = provider()
    const choice = cfg().get<string>('provider', 'github-models')
    if (!c.apiKey && !(await askKey())) { post({ type: 'note', text: 'Set an API key to start. Use the Key button, or run "AI: Set API Key".' }); post({ type: 'done' }); return }
    c.apiKey = keyFor(choice)
    if (!c.model) { post({ type: 'error', text: 'Set "luma.ai.model" in settings for this provider.' }); post({ type: 'done' }); return }
    post({ type: 'user', text })
    history.push({ role: 'user', text: text + (await context(withFile)) })
    abort = new AbortController()
    const agent = mode === 'agent'
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        post({ type: 'start' })
        const turn = await streamTurn(c, SYSTEM(agent), history, agent ? TOOLS : [], { onText: (t) => post({ type: 'text', text: t }) }, abort.signal)
        history.push({ role: 'assistant', text: turn.text, calls: turn.calls })
        post({ type: 'turn-end' })
        if (!turn.calls.length) break
        const results: { id: string; name: string; content: string }[] = []
        for (const call of turn.calls) {
          let out: string
          try {
            if (call.name === 'write_file' && !(await ask(call.name, call.args))) out = 'The user denied this write.'
            else { out = await runTool(call.name, call.args); post({ type: 'tool', name: call.name, summary: summary(call.name, call.args) }) }
          } catch (e) { out = `Error: ${e instanceof Error ? e.message : String(e)}` }
          results.push({ id: call.id, name: call.name, content: out })
        }
        history.push({ role: 'tool', results })
        if (step === MAX_STEPS - 1) post({ type: 'note', text: 'Stopped after the step limit.' })
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') post({ type: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      for (const r of approvals.values()) r(false)
      approvals.clear()
      abort = undefined
      post({ type: 'done' })
    }
  }

  const empty = `<h3>Assistant</h3>Chat about your code, or switch to <b>Agent</b> mode to let it read files and propose edits (you approve every write).<br><br>It uses <b>your own account or API key</b>, stored in this browser, and calls the provider directly. Nothing goes through our servers. The default provider is <b>GitHub Models</b> (uses your GitHub sign-in); change it with the <code>luma.ai.provider</code> setting. This is not GitHub Copilot.`

  vs.window.registerWebviewViewProvider('luma.ai.chat', {
    resolveWebviewView(v) {
      view = v
      v.webview.options = { enableScripts: true }
      const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
      v.webview.html = chatHtml(nonce, `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`)
      v.webview.onDidReceiveMessage((m: { type: string; text?: string; mode?: 'chat' | 'agent'; withFile?: boolean; id?: string; ok?: boolean }) => {
        if (m.type === 'ready') post({ type: 'init', empty, mode: 'chat' })
        else if (m.type === 'send') void handle(m.text ?? '', m.mode ?? 'chat', m.withFile ?? true)
        else if (m.type === 'stop') abort?.abort()
        else if (m.type === 'clear') { abort?.abort(); history = []; post({ type: 'cleared' }) }
        else if (m.type === 'setKey') void askKey()
        else if (m.type === 'copy') void vs.env.clipboard.writeText(m.text ?? '')
        else if (m.type === 'approval' && m.id) { approvals.get(m.id)?.(!!m.ok); approvals.delete(m.id) }
      })
    }
  }, { webviewOptions: { retainContextWhenHidden: true } })

  const focusWith = async (prompt: string): Promise<void> => {
    await vs.commands.executeCommand('luma.ai.chat.focus')
    setTimeout(() => post({ type: 'prefill', text: prompt }), 400)
  }
  // Like Copilot Chat, the assistant lives on the right. Show it once on the first visit.
  try {
    if (!localStorage.getItem('luma.ai.shown')) {
      localStorage.setItem('luma.ai.shown', '1')
      setTimeout(() => void vs.commands.executeCommand('luma.ai.chat.focus'), 1500)
    }
  } catch { /* storage blocked */ }
  vs.commands.registerCommand('luma.ai.open', () => vs.commands.executeCommand('luma.ai.chat.focus'))
  vs.commands.registerCommand('luma.ai.setApiKey', () => askKey())
  vs.commands.registerCommand('luma.ai.explain', () => focusWith('Explain this code.'))
  vs.commands.registerCommand('luma.ai.fix', () => focusWith('Find and fix the problems in this code.'))
  vs.commands.registerCommand('luma.ai.newChat', () => { abort?.abort(); history = []; post({ type: 'cleared' }) })

  // Inline suggestions: off by default, because every pause in typing would send code to the provider.
  vs.languages.registerInlineCompletionItemProvider({ pattern: '**' }, {
    async provideInlineCompletionItems(doc, pos, _ctx, token) {
      if (!cfg().get<boolean>('inlineCompletions', false)) return
      const c = provider()
      c.apiKey = keyFor(cfg().get<string>('provider', 'github-models'))
      c.model = cfg().get<string>('completionModel', '').trim() || c.model
      if (!c.apiKey || !c.model) return
      await new Promise((r) => setTimeout(r, 450))
      if (token.isCancellationRequested) return
      const before = doc.getText(new vs.Range(Math.max(0, pos.line - 60), 0, pos.line, pos.character))
      const after = doc.getText(new vs.Range(pos.line, pos.character, Math.min(doc.lineCount - 1, pos.line + 20), 1000))
      const ac = new AbortController()
      token.onCancellationRequested(() => ac.abort())
      try {
        const out = await complete(c, 'You complete code. Reply with only the text to insert at <CURSOR>, with no explanation and no code fences. If nothing sensible fits, reply with nothing.',
          `File: ${vs.workspace.asRelativePath(doc.uri)} (${doc.languageId})\n${before}<CURSOR>${after}`, ac.signal)
        const text = out.replace(/^```[^\n]*\n?|\n?```$/g, '')
        if (!text.trim()) return
        return [new vs.InlineCompletionItem(text, new vs.Range(pos, pos))]
      } catch { return }
    }
  })
}
