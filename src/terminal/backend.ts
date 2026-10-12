import {
  SimpleTerminalBackend,
  SimpleTerminalProcess,
  type ITerminalChildProcess
} from '@codingame/monaco-vscode-terminal-service-override'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'

/** A terminal process that the IDE itself implements (a Python REPL, a remote runner connection, ...). */
export interface ProcessInfo { cols: number; rows: number }
export type ProcessFactory = (info: ProcessInfo) => ITerminalChildProcess

const factories = new Map<string, ProcessFactory>()

/** Registers what `shellPath` / profile `path` = `kind` should launch. */
export function registerTerminalKind(kind: string, factory: ProcessFactory): void {
  factories.set(kind, factory)
}

export const PROFILE_PYTHON = 'luma-python'
export const PROFILE_RUNNER = 'luma-runner'

let nextProcessId = 1

/**
 * Base class for terminals that edit one line locally and hand complete lines to `onLine`.
 * Supports backspace, left/right/home/end, history (up/down), Ctrl+C, Ctrl+L and Ctrl+U.
 */
export abstract class LineTerminalProcess extends SimpleTerminalProcess {
  protected readonly data: Emitter<string>
  private line = ''
  private cursor = 0
  private readonly history: string[] = []
  private historyIndex = 0
  private busy = false

  constructor(data: Emitter<string>) {
    super(nextProcessId++, nextProcessId, '/', data.event)
    this.data = data
  }

  protected abstract prompt(): string
  protected abstract onLine(line: string): Promise<void>
  protected abstract banner(): string
  protected interrupt(): void {}

  protected write(text: string): void {
    this.data.fire(text.replace(/\r?\n/g, '\r\n'))
  }

  protected showPrompt(): void {
    this.data.fire(this.prompt())
  }

  async start(): Promise<undefined> {
    setTimeout(() => {
      this.write(this.banner())
      this.showPrompt()
    }, 0)
    return undefined
  }

  /** The workbench asks processes for their working directory; terminals here have none, so report the root. */
  override refreshProperty = (async (type?: string) => (type === 'cwd' ? '/' : undefined)) as never

  override shutdown(): void {}
  override sendSignal(): void {}
  override clearBuffer(): void {}
  resize(): void {}

  private redraw(): void {
    // erase the current line and draw it again, keeping the cursor in place
    this.data.fire(`\r\u001b[2K${this.prompt()}${this.line}`)
    const back = this.line.length - this.cursor
    if (back > 0) this.data.fire(`\u001b[${back}D`)
  }

  override input(chunk: string): void {
    // Escape sequences (arrows, home, end, delete) arrive as one chunk.
    if (chunk.startsWith('\u001b')) {
      switch (chunk) {
        case '\u001b[A': if (this.historyIndex > 0) { this.line = this.history[--this.historyIndex]!; this.cursor = this.line.length; this.redraw() } break
        case '\u001b[B':
          if (this.historyIndex < this.history.length) {
            this.historyIndex++
            this.line = this.history[this.historyIndex] ?? ''
            this.cursor = this.line.length
            this.redraw()
          }
          break
        case '\u001b[C': if (this.cursor < this.line.length) { this.cursor++; this.data.fire(chunk) } break
        case '\u001b[D': if (this.cursor > 0) { this.cursor--; this.data.fire(chunk) } break
        case '\u001b[H': case '\u001b[1~': this.cursor = 0; this.redraw(); break
        case '\u001b[F': case '\u001b[4~': this.cursor = this.line.length; this.redraw(); break
        case '\u001b[3~': if (this.cursor < this.line.length) { this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1); this.redraw() } break
      }
      return
    }
    for (const ch of chunk) {
      const code = ch.charCodeAt(0)
      if (code === 13) {
        this.data.fire('\r\n')
        const entered = this.line
        this.line = ''
        this.cursor = 0
        if (entered.trim() && this.history[this.history.length - 1] !== entered) this.history.push(entered)
        this.historyIndex = this.history.length
        this.busy = true
        void this.onLine(entered).finally(() => {
          this.busy = false
          this.showPrompt()
        })
      } else if (this.busy) {
        if (code === 3) this.interrupt()
      } else if (code === 127 || code === 8) {
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
          this.cursor--
          this.redraw()
        }
      } else if (code === 3) {
        this.data.fire('^C\r\n')
        this.line = ''
        this.cursor = 0
        this.showPrompt()
      } else if (code === 12) {
        this.data.fire('\u001b[2J\u001b[H')
        this.redraw()
      } else if (code === 21) {
        this.line = ''
        this.cursor = 0
        this.redraw()
      } else if (code >= 32) {
        this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor)
        this.cursor++
        if (this.cursor === this.line.length) this.data.fire(ch)
        else this.redraw()
      }
    }
  }
}

/** The terminal backend of the workbench: every terminal is a process implemented inside the IDE. */
export class LumaTerminalBackend extends SimpleTerminalBackend {
  override getDefaultSystemShell = async (): Promise<string> => PROFILE_PYTHON

  override getProfiles = async () => [
    { profileName: 'Python', path: PROFILE_PYTHON, isDefault: true, isAutoDetected: false },
    { profileName: 'Remote runner', path: PROFILE_RUNNER, isDefault: false, isAutoDetected: false }
  ]

  override createProcess = async (shellLaunchConfig: { executable?: string }, _cwd?: unknown, cols = 80, rows = 24): Promise<ITerminalChildProcess> => {
    const factory = factories.get(shellLaunchConfig.executable ?? '') ?? factories.get(PROFILE_PYTHON)
    if (!factory) throw new Error('No terminal available')
    return factory({ cols, rows })
  }
}
