// Main-thread wrapper around a Pyodide worker (see worker.ts).

export type PyKind = 'runtime' | 'lint' | 'repl'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class PyWorker {
  private worker?: Worker
  private ready?: Promise<void>
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stdin?: { state: Int32Array; bytes: Uint8Array }
  onStdout: (data: string) => void = () => {}
  onStderr: (data: string) => void = () => {}
  /** Asked for a line of input; answer with provideInput(). */
  onStdinRequest: () => void = () => {}
  version = ''

  constructor(readonly kind: PyKind) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker = worker
      let buffer: SharedArrayBuffer | undefined
      if (typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated && this.kind !== 'lint') {
        buffer = new SharedArrayBuffer(8 + 64 * 1024)
        this.stdin = { state: new Int32Array(buffer, 0, 2), bytes: new Uint8Array(buffer, 8) }
      }
      worker.onmessage = (event: MessageEvent) => {
        const m = event.data as { type: string; id?: number; ok?: boolean; value?: unknown; error?: string; data?: string; version?: string }
        switch (m.type) {
          case 'ready': this.version = m.version ?? ''; resolve(); break
          case 'init-error': reject(new Error(m.error)); break
          case 'stdout': this.onStdout(m.data ?? ''); break
          case 'stderr': this.onStderr(m.data ?? ''); break
          case 'stdin-request': this.onStdinRequest(); break
          case 'result': {
            const p = this.pending.get(m.id!)
            if (!p) break
            this.pending.delete(m.id!)
            if (m.ok) p.resolve(m.value)
            else p.reject(new Error(m.error))
            break
          }
        }
      }
      worker.onerror = (e) => reject(new Error(e.message || 'Python worker failed to start'))
      worker.postMessage({ type: 'init', buffer })
    })
    return this.ready
  }

  async call<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    await this.start()
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker!.postMessage({ type, id, ...payload })
    })
  }

  /** Answers a stdin request. `undefined` signals cancel / end of input. */
  provideInput(text: string | undefined): void {
    const s = this.stdin
    if (!s) return
    if (text === undefined) {
      Atomics.store(s.state, 1, -1)
      Atomics.store(s.state, 0, 3)
    } else {
      const bytes = new TextEncoder().encode(text)
      const n = Math.min(bytes.length, s.bytes.length)
      s.bytes.set(bytes.subarray(0, n))
      Atomics.store(s.state, 1, n)
      Atomics.store(s.state, 0, 2)
    }
    Atomics.notify(s.state, 0)
  }

  get hasStdin(): boolean {
    return this.stdin !== undefined
  }

  /** Kills the worker (used for Stop). A new one is started on the next call. */
  terminate(reason = 'terminated'): void {
    this.worker?.terminate()
    this.worker = undefined
    this.ready = undefined
    this.stdin = undefined
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
}
