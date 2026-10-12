// A GitHub repository checked out into the browser: file tree + local edits + automatic commits.
//
//  * Reads come from the local overlay first, then from downloaded blobs, then from GitHub (and are cached).
//  * Writes only touch the overlay (instant) and schedule a sync.
//  * A sync is ONE atomic commit (GraphQL createCommitOnBranch). On tab hide/close the same single request is sent with
//    `keepalive`, which browsers allow to finish after the page is gone.
//  * On the next load we reconcile: edits already on GitHub (the unload commit) are dropped, edits that conflict with
//    newer remote changes go to a side branch. Nothing is overwritten.
import {
  GitHubError, changedPaths, commitBody, createBranch, createCommit, getBlob, getHead, getTree, gitBlobSha, graphqlUrl, toBase64,
  type CommitInput, type TreeEntry
} from './api'
import { getSession } from './auth'
import { loadBlob, loadCheckout, saveBlob, saveCheckout, type CheckoutRecord } from './store'

export type SyncState = 'synced' | 'pending' | 'syncing' | 'error'
export interface SyncStatus { state: SyncState; pending: number; message?: string }

const splitPath = (p: string): string[] => p.split('/').filter(Boolean)
const dirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export class Checkout {
  baseOid = ''
  private tree = new Map<string, TreeEntry>()
  private overlay = new Map<string, Uint8Array | null>()
  private explicitDirs = new Set<string>()
  private index = new Map<string, Map<string, 'file' | 'dir'>>()
  private blobs = new Map<string, Uint8Array>()
  private shas = new Map<string, string>() // overlay path -> git blob sha (filled in the background)
  private persistTimer?: ReturnType<typeof setTimeout>
  private syncTimer?: ReturnType<typeof setTimeout>
  private syncing = false
  private again = false
  private paused = false
  private errorMessage?: string
  truncated = false

  onDidChange: (changedPaths: { path: string; kind: 'changed' | 'created' | 'deleted' }[]) => void = () => {}
  onStatus: (status: SyncStatus) => void = () => {}
  onNotice: (message: string, level: 'info' | 'warn') => void = () => {}
  syncDelayMs: () => number = () => 10_000

  constructor(readonly owner: string, readonly repo: string, public ref: string) {}

  get key(): string { return `${this.owner}/${this.repo}@${this.ref}` }
  get pending(): number { return this.overlay.size }
  get hasPending(): boolean { return this.overlay.size > 0 || this.syncing }

  // ---------------------------------------------------------------- loading
  async init(): Promise<void> {
    const saved = await loadCheckout(this.key).catch(() => undefined)
    if (saved) {
      this.baseOid = saved.baseOid
      this.tree = new Map(saved.tree.map((e) => [e.path, e]))
      this.overlay = new Map(saved.overlay)
      this.explicitDirs = new Set(saved.dirs)
      this.buildIndex()
      this.emitStatus()
      return
    }
    await this.loadRemote(await getHead(this.owner, this.repo, this.ref))
  }

  private async loadRemote(oid: string): Promise<void> {
    const { entries, truncated } = await getTree(this.owner, this.repo, oid)
    this.truncated = truncated
    this.tree = new Map(entries.map((e) => [e.path, e]))
    this.baseOid = oid
    this.buildIndex()
    this.persistSoon(0)
    this.emitStatus()
  }

  private buildIndex(): void {
    this.index = new Map([['', new Map()]])
    for (const p of this.tree.keys()) if (this.overlay.get(p) !== null) this.indexAdd(p)
    for (const [p, c] of this.overlay) if (c !== null) this.indexAdd(p)
    for (const d of this.explicitDirs) this.indexDir(d)
  }

  private indexDir(dir: string): void {
    const parts = splitPath(dir)
    let cur = ''
    for (const part of parts) {
      const next = cur ? `${cur}/${part}` : part
      if (!this.index.has(cur)) this.index.set(cur, new Map())
      this.index.get(cur)!.set(part, 'dir')
      if (!this.index.has(next)) this.index.set(next, new Map())
      cur = next
    }
  }

  private indexAdd(path: string): void {
    this.indexDir(dirname(path))
    this.index.get(dirname(path))!.set(basename(path), 'file')
  }

  private indexRemove(path: string): void {
    let dir = dirname(path)
    this.index.get(dir)?.delete(basename(path))
    while (dir && !this.explicitDirs.has(dir) && (this.index.get(dir)?.size ?? 0) === 0) {
      this.index.delete(dir)
      this.index.get(dirname(dir))?.delete(basename(dir))
      dir = dirname(dir)
    }
  }

  // ---------------------------------------------------------------- file system operations
  stat(path: string): { kind: 'file' | 'dir'; size: number } | undefined {
    if (path === '' || this.index.has(path)) return { kind: 'dir', size: 0 }
    const o = this.overlay.get(path)
    if (o) return { kind: 'file', size: o.length }
    if (o === null) return undefined
    const e = this.tree.get(path)
    return e ? { kind: 'file', size: e.size } : undefined
  }

  readdir(path: string): [string, 'file' | 'dir'][] | undefined {
    const d = this.index.get(path)
    return d ? [...d.entries()] : undefined
  }

  async read(path: string): Promise<Uint8Array> {
    const o = this.overlay.get(path)
    if (o) return o
    const e = o === null ? undefined : this.tree.get(path)
    if (!e) throw new Error('File not found')
    const mem = this.blobs.get(e.sha)
    if (mem) return mem
    const stored = await loadBlob(e.sha).catch(() => undefined)
    if (stored) { this.blobs.set(e.sha, stored); return stored }
    const bytes = await getBlob(this.owner, this.repo, e.sha)
    this.blobs.set(e.sha, bytes)
    void saveBlob(e.sha, bytes).catch(() => {})
    return bytes
  }

  write(path: string, content: Uint8Array): void {
    const existed = this.stat(path) !== undefined
    this.overlay.set(path, content)
    this.shas.delete(path)
    void gitBlobSha(content).then((s) => { if (this.overlay.get(path) === content) this.shas.set(path, s) })
    this.indexAdd(path)
    this.changed([{ path, kind: existed ? 'changed' : 'created' }])
  }

  remove(path: string): void {
    const st = this.stat(path)
    if (!st) return
    if (st.kind === 'dir') {
      const prefix = path + '/'
      const victims = [...this.tree.keys(), ...[...this.overlay].filter(([, c]) => c !== null).map(([p]) => p)].filter((p) => p.startsWith(prefix) && this.overlay.get(p) !== null)
      for (const p of new Set(victims)) this.overlay.set(p, null), this.shas.delete(p)
      for (const d of [...this.explicitDirs]) if (d === path || d.startsWith(prefix)) this.explicitDirs.delete(d)
      this.index.delete(path)
      for (const k of [...this.index.keys()]) if (k.startsWith(prefix)) this.index.delete(k)
      this.index.get(dirname(path))?.delete(basename(path))
      this.pruneEmpty(dirname(path))
      this.changed([{ path, kind: 'deleted' }])
      return
    }
    this.overlay.set(path, null)
    this.shas.delete(path)
    this.indexRemove(path)
    this.changed([{ path, kind: 'deleted' }])
  }

  private pruneEmpty(dir: string): void {
    while (dir && !this.explicitDirs.has(dir) && (this.index.get(dir)?.size ?? 0) === 0) {
      this.index.delete(dir)
      this.index.get(dirname(dir))?.delete(basename(dir))
      dir = dirname(dir)
    }
  }

  mkdir(path: string): void {
    this.explicitDirs.add(path)
    this.indexDir(path)
    this.persistSoon()
    this.onDidChange([{ path, kind: 'created' }])
  }

  async rename(from: string, to: string): Promise<void> {
    const st = this.stat(from)
    if (!st) throw new Error('File not found')
    if (st.kind === 'file') {
      const bytes = await this.read(from)
      this.write(to, bytes)
      this.remove(from)
      return
    }
    const prefix = from + '/'
    const files = [...new Set([...this.tree.keys(), ...[...this.overlay].filter(([, c]) => c !== null).map(([p]) => p)])].filter((p) => p.startsWith(prefix) && this.overlay.get(p) !== null)
    const moved = await Promise.all(files.map(async (p) => [p, await this.read(p)] as const))
    for (const [p, bytes] of moved) this.write(to + '/' + p.slice(prefix.length), bytes)
    this.remove(from)
  }

  private changed(events: { path: string; kind: 'changed' | 'created' | 'deleted' }[]): void {
    this.onDidChange(events)
    this.persistSoon()
    this.schedule()
    this.emitStatus()
  }

  // ---------------------------------------------------------------- persistence
  private persistSoon(delay = 300): void {
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => void this.persist(), delay)
  }

  async persist(): Promise<void> {
    const record: CheckoutRecord = {
      key: this.key, owner: this.owner, repo: this.repo, ref: this.ref, baseOid: this.baseOid,
      tree: [...this.tree.values()], overlay: [...this.overlay], dirs: [...this.explicitDirs], syncedAt: Date.now()
    }
    await saveCheckout(record).catch(() => {})
  }

  // ---------------------------------------------------------------- sync
  private emitStatus(): void {
    const state: SyncState = this.errorMessage ? 'error' : this.syncing ? 'syncing' : this.overlay.size ? 'pending' : 'synced'
    this.onStatus({ state, pending: this.overlay.size, message: this.errorMessage })
  }

  private schedule(): void {
    if (this.paused) return
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => void this.sync(), Math.max(3000, this.syncDelayMs()))
  }

  /** Resume automatic sync after an error was shown to the user. */
  resume(): void {
    this.paused = false
    this.errorMessage = undefined
    this.schedule()
    this.emitStatus()
  }

  /** Overlay entries that really differ from the base commit, as a commit request. */
  private buildCommit(): { input: CommitInput; paths: string[]; snapshot: Map<string, Uint8Array | null> } | undefined {
    const snapshot = new Map(this.overlay)
    const additions: CommitInput['additions'] = []
    const deletions: CommitInput['deletions'] = []
    const paths: string[] = []
    const changes: string[] = []
    for (const [path, content] of snapshot) {
      const base = this.tree.get(path)
      if (content === null) {
        if (!base) continue
        deletions.push({ path }); paths.push(path); changes.push(`D ${path}`)
      } else {
        if (base && this.shas.get(path) === base.sha) continue // reverted to the committed content
        additions.push({ path, contents: toBase64(content) }); paths.push(path); changes.push(`${base ? 'M' : 'A'} ${path}`)
      }
    }
    if (!paths.length) return undefined
    const only = paths.length === 1 ? paths[0] : undefined
    const headline = only ? `${deletions.length ? 'Delete' : 'Update'} ${only.split('/').pop()}` : `Update ${paths.length} files`
    return {
      input: { owner: this.owner, repo: this.repo, branch: this.ref, expectedHeadOid: this.baseOid, headline, body: `${changes.slice(0, 50).join('\n')}${changes.length > 50 ? `\n... and ${changes.length - 50} more` : ''}\n\nSynced from Luma IDE`, additions, deletions },
      paths, snapshot
    }
  }

  /** Commits and pushes pending changes now. */
  async sync(): Promise<void> {
    clearTimeout(this.syncTimer)
    if (this.syncing) { this.again = true; return }
    const built = this.buildCommit()
    if (!built) {
      // everything pending equals the base: nothing to commit
      for (const [p, c] of this.overlay) if (c === null ? !this.tree.has(p) : this.shas.get(p) === this.tree.get(p)?.sha) this.overlay.delete(p)
      this.emitStatus(); this.persistSoon()
      return
    }
    this.syncing = true
    this.errorMessage = undefined
    this.emitStatus()
    try {
      const oid = await createCommit(built.input)
      await this.applyCommitted(built, oid)
    } catch (e) {
      await this.handleSyncError(e, built)
    } finally {
      this.syncing = false
      this.emitStatus()
      if (this.again || (this.overlay.size && !this.errorMessage)) { this.again = false; this.schedule() }
    }
  }

  private async applyCommitted(built: NonNullable<ReturnType<Checkout['buildCommit']>>, oid: string): Promise<void> {
    for (const [path, content] of built.snapshot) {
      if (this.overlay.get(path) !== content) continue // edited again while syncing: stays pending
      if (content === null) this.tree.delete(path)
      else {
        const sha = this.shas.get(path) ?? (await gitBlobSha(content))
        this.tree.set(path, { path, sha, size: content.length })
        this.blobs.set(sha, content)
      }
      this.overlay.delete(path)
      this.shas.delete(path)
    }
    // entries that were skipped as no-ops are dropped too
    for (const [p, c] of [...this.overlay]) if (built.snapshot.get(p) === c && !built.paths.includes(p)) this.overlay.delete(p)
    this.baseOid = oid
    this.persistSoon(0)
  }

  private async handleSyncError(e: unknown, built: NonNullable<ReturnType<Checkout['buildCommit']>>): Promise<void> {
    const message = e instanceof Error ? e.message : String(e)
    if (/Expected branch to point to|expectedHeadOid/i.test(message)) {
      // The branch moved. Reconcile, then try again (or move to a side branch on real conflicts).
      try {
        const moved = await this.reconcile()
        if (!moved) this.again = true
        return
      } catch (inner) {
        this.fail(inner instanceof Error ? inner.message : String(inner))
        return
      }
    }
    if (/protected branch|branch protection|required status|pull request is required|Repository rule violations/i.test(message)) {
      try { await this.rescue(built, 'The branch is protected'); return } catch (inner) { this.fail(inner instanceof Error ? inner.message : String(inner)); return }
    }
    if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) {
      this.fail('GitHub did not accept the sign-in or the permissions. Sign in again.', true)
      return
    }
    if (e instanceof TypeError) { this.fail('Offline: changes are kept locally and will sync when the connection returns.'); this.retryLater(); return }
    this.fail(message)
    this.retryLater()
  }

  private fail(message: string, pause = false): void {
    this.errorMessage = message
    this.paused = pause
    this.emitStatus()
  }

  private retryLater(): void {
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => { this.errorMessage = undefined; void this.sync() }, 30_000)
  }

  /**
   * Brings the base up to the branch's current head. Our pending edits are kept when they do not collide with remote changes.
   * @returns true when a conflict forced the pending edits onto a side branch
   */
  async reconcile(): Promise<boolean> {
    const head = await getHead(this.owner, this.repo, this.ref)
    if (head === this.baseOid) return false
    const { entries, truncated } = await getTree(this.owner, this.repo, head)
    const remote = new Map(entries.map((e) => [e.path, e]))
    const conflicts: string[] = []
    for (const [path, content] of [...this.overlay]) {
      const r = remote.get(path)
      const b = this.tree.get(path)
      if (content === null) {
        if (!r) this.overlay.delete(path) // already deleted upstream
        else if (r.sha !== b?.sha) conflicts.push(path)
      } else {
        const local = this.shas.get(path) ?? (await gitBlobSha(content))
        if (r && r.sha === local) this.overlay.delete(path) // already on GitHub (for example the page-close commit)
        else if ((r?.sha ?? null) !== (b?.sha ?? null)) conflicts.push(path)
      }
    }
    if (conflicts.length) {
      const built = this.buildCommit()
      if (built) { await this.rescue(built, `${conflicts.length} file(s) changed on GitHub as well`); return true }
    }
    this.tree = remote
    this.truncated = truncated
    this.baseOid = head
    this.buildIndex()
    this.persistSoon(0)
    this.onDidChange([{ path: '', kind: 'changed' }])
    return false
  }

  /** Saves pending edits on a new branch off the commit they were based on. */
  private async rescue(built: NonNullable<ReturnType<Checkout['buildCommit']>>, why: string): Promise<void> {
    const login = getSession()?.login ?? 'user'
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const branch = `luma/${login}-${stamp}`
    await createBranch(this.owner, this.repo, branch, built.input.expectedHeadOid)
    const oid = await createCommit({ ...built.input, branch })
    // continue working on the new branch
    const old = this.ref
    for (const [path, content] of built.snapshot) {
      if (this.overlay.get(path) !== content) continue
      if (content === null) this.tree.delete(path)
      else this.tree.set(path, { path, sha: this.shas.get(path) ?? (await gitBlobSha(content)), size: content.length })
      this.overlay.delete(path)
    }
    this.ref = branch
    this.baseOid = oid
    this.persistSoon(0)
    this.onNotice(`${why}, so your changes were saved to a new branch: ${branch}. You can open a pull request from ${old}...${branch} on GitHub. This window now works on that branch.`, 'warn')
    this.emitStatus()
  }

  // ---------------------------------------------------------------- page lifecycle
  /**
   * Called synchronously from pagehide/visibilitychange: starts one atomic commit with keepalive so it can finish after the
   * page is gone. Nothing can be awaited here.
   */
  flushForUnload(): void {
    clearTimeout(this.syncTimer)
    const session = getSession()
    if (!session || this.syncing) return
    const built = this.buildCommit()
    if (!built) return
    const body = commitBody(built.input)
    this.syncing = true
    this.emitStatus()
    try {
      fetch(graphqlUrl(), {
        method: 'POST', keepalive: body.length < 60_000, body,
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' }
      })
        // If the tab survives (it was only hidden), finish the bookkeeping like a normal sync.
        .then(async (res) => {
          const data = (await res.json()) as { data?: { createCommitOnBranch?: { commit: { oid: string } } }; errors?: { message: string }[] }
          const oid = data.data?.createCommitOnBranch?.commit.oid
          if (!oid) throw new GitHubError(data.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`, res.status)
          await this.applyCommitted(built, oid)
        })
        .catch((e) => this.handleSyncError(e, built))
        .finally(() => {
          this.syncing = false
          this.emitStatus()
          if (this.overlay.size && !this.errorMessage) this.schedule()
        })
    } catch { /* the edits stay in IndexedDB and are reconciled next time */ }
  }
}
