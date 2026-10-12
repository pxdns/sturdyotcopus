import type * as vscode from 'vscode'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { SimpleTerminalProcess } from '@codingame/monaco-vscode-terminal-service-override'
import { getSession } from '../github/auth'
import { PROFILE_RUNNER, registerTerminalKind, type ProcessInfo } from '../terminal/backend'

type Vscode = typeof vscode
let nextId = 1000

/** A terminal connected to a remote runner (see runner/server.mjs) over a WebSocket. */
class RunnerProcess extends SimpleTerminalProcess {
  private readonly data: Emitter<string>
  private ws?: WebSocket
  private size: ProcessInfo

  constructor(
    data: Emitter<string>,
    size: ProcessInfo,
    private readonly url: () => string,
    private readonly target: () => { repo?: string; ref?: string }
  ) {
    super(nextId++, nextId, '/', data.event)
    this.data = data
    this.size = size
  }

  override refreshProperty = (async (type?: string) => (type === 'cwd' ? '/' : undefined)) as never

  private say(text: string): void {
    this.data.fire(text.replace(/\r?\n/g, '\r\n'))
  }

  async start(): Promise<undefined> {
    setTimeout(() => this.connect(), 0)
    return undefined
  }

  private connect(): void {
    const url = this.url().trim()
    if (!url) {
      this.say('Remote runner is not configured.\nSet "luma.runner.url" (for example wss://runner.example.com/ws) in Settings,\nor run "Remote Runner: Set Server URL". See /runner/ on the project site.\n')
      return
    }
    const session = getSession()
    if (!session) {
      this.say('Sign in with GitHub first: run "GitHub: Sign In" from the command palette.\n')
      return
    }
    this.say(`Connecting to ${url} ...\n`)
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      this.say(`Invalid runner URL: ${e instanceof Error ? e.message : String(e)}\n`)
      return
    }
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: session.token, cols: this.size.cols, rows: this.size.rows, ...this.target() }))
    ws.onmessage = (event) => {
      let m: { type: string; data?: string; message?: string; code?: number; login?: string }
      try { m = JSON.parse(String(event.data)) } catch { return }
      if (m.type === 'output') this.data.fire(m.data ?? '')
      else if (m.type === 'ready') this.say(`Connected as ${m.login}.\n`)
      else if (m.type === 'error') this.say(`\n[Runner: ${m.message}]\n`)
      else if (m.type === 'exit') this.say(`\n[Shell exited with code ${m.code}]\n`)
    }
    ws.onerror = () => this.say('\n[Could not reach the runner. Check the URL, and that the server allows this site as an origin.]\n')
    ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005) this.say(`\n[Disconnected (${e.code})]\n`) }
  }

  override input(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'input', data }))
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  override shutdown(): void {
    this.ws?.close(1000)
  }
  override sendSignal(): void {}
  override clearBuffer(): void {}
}

export function activateRunner(vs: Vscode, target: () => { repo?: string; ref?: string }): void {
  const url = (): string => vs.workspace.getConfiguration('luma.runner').get<string>('url', '')
  registerTerminalKind(PROFILE_RUNNER, (info) => new RunnerProcess(new Emitter<string>(), info, url, target))
  vs.commands.registerCommand('luma.runner.open', () => {
    void vs.commands.executeCommand('workbench.action.terminal.newWithProfile', { profileName: 'Remote runner' })
  })
  vs.commands.registerCommand('luma.runner.configure', async () => {
    const value = await vs.window.showInputBox({ prompt: 'Remote runner WebSocket URL', placeHolder: 'wss://runner.example.com/ws', value: url(), ignoreFocusOut: true })
    if (value !== undefined) await vs.workspace.getConfiguration('luma.runner').update('url', value.trim(), vs.ConfigurationTarget.Global)
  })
}
