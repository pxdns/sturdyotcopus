// Which workspace the IDE opens: a GitHub repository (restored from last time) or the local sample workspace.
import { registerCustomProvider } from '@codingame/monaco-vscode-files-service-override'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { getSession } from './auth'
import { Checkout } from './checkout'
import { GITHUB_SCHEME, GitHubFileSystemProvider, repoUri } from './fs'

export type WorkspaceDescriptor = { kind: 'local' } | { kind: 'github'; owner: string; repo: string; ref: string }

const KEY = 'luma.lastWorkspace'

export function loadDescriptor(): WorkspaceDescriptor {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null') as WorkspaceDescriptor | null
    if (d?.kind === 'github' && d.owner && d.repo && d.ref) return d
  } catch { /* ignore */ }
  return { kind: 'local' }
}

export function saveDescriptor(d: WorkspaceDescriptor): void {
  try { localStorage.setItem(KEY, JSON.stringify(d)) } catch { /* ignore */ }
}

/** ?github=owner/repo or ?github=owner/repo@branch opens that repository (when signed in). */
export function descriptorFromUrl(): { owner: string; repo: string; ref?: string } | undefined {
  const m = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/.exec(new URLSearchParams(location.search).get('github') ?? '')
  return m ? { owner: m[1]!, repo: m[2]!, ref: m[3] } : undefined
}

export interface PreparedGithubWorkspace {
  checkout: Checkout
  folderUri: URI
}

let active: Checkout | undefined
export const getActiveCheckout = (): Checkout | undefined => active

/**
 * Loads the working copy of the last-used repository and registers its file system. Must run before the workbench starts.
 * Returns undefined (and the caller opens the local workspace) when nothing is saved, the user is signed out, or loading fails.
 */
export async function prepareGithubWorkspace(onProblem: (message: string) => void): Promise<PreparedGithubWorkspace | undefined> {
  let d = loadDescriptor()
  const fromUrl = descriptorFromUrl()
  if (fromUrl && getSession()) {
    // default branch is resolved lazily: use the saved ref for the same repo, else ask GitHub
    const same = d.kind === 'github' && d.owner === fromUrl.owner && d.repo === fromUrl.repo
    let ref = fromUrl.ref ?? (same ? (d as { ref: string }).ref : undefined)
    if (!ref) {
      try { ref = (await (await import('./api')).getRepo(fromUrl.owner, fromUrl.repo)).defaultBranch } catch (e) { onProblem(`Could not open ${fromUrl.owner}/${fromUrl.repo}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    if (ref) { d = { kind: 'github', owner: fromUrl.owner, repo: fromUrl.repo, ref }; saveDescriptor(d) }
  } else if (fromUrl && !getSession()) {
    onProblem(`Sign in with GitHub to open ${fromUrl.owner}/${fromUrl.repo}.`)
  }
  if (d.kind !== 'github') return undefined
  if (!getSession()) {
    onProblem(`Sign in with GitHub to reopen ${d.owner}/${d.repo}.`)
    return undefined
  }
  const checkout = new Checkout(d.owner, d.repo, d.ref)
  try {
    await checkout.init()
  } catch (e) {
    onProblem(`Could not open ${d.owner}/${d.repo}@${d.ref}: ${e instanceof Error ? e.message : String(e)}. Opening the local workspace instead.`)
    return undefined
  }
  registerCustomProvider(GITHUB_SCHEME, new GitHubFileSystemProvider(checkout))
  active = checkout
  return { checkout, folderUri: repoUri(d.owner, d.repo) }
}

/** Sync when the tab is hidden or closing, and ask before leaving with unsynced changes. */
export function installLifecycleHandlers(checkout: Checkout, saveAll: () => PromiseLike<unknown>): void {
  // Editors auto-save after a short delay; save the dirty ones first so a closing tab does not lose the last second of typing.
  const flush = (): void => {
    try { saveAll().then(() => checkout.flushForUnload(), () => checkout.flushForUnload()) } catch { checkout.flushForUnload() }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', (e) => {
    if (checkout.hasPending) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
}
