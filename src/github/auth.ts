// GitHub sign-in on the client. The OAuth redirect flow runs in a popup (see lib/github-auth.js on the server); the popup hands
// the access token back to this page over a BroadcastChannel / storage event. The token lives only in this browser.

export interface GitHubSession {
  token: string
  login: string
  name: string
  avatar: string
  apiUrl: string
  scope: string
}

const SESSION_KEY = 'luma.github.session'
const HANDOFF_KEY = 'luma.github.handoff'
const CHANNEL = 'luma-github-auth'

type Listener = (session: GitHubSession | undefined) => void
const listeners = new Set<Listener>()
let current: GitHubSession | undefined

function load(): GitHubSession | undefined {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return undefined
    const s = JSON.parse(raw) as GitHubSession
    return s.token && s.login ? s : undefined
  } catch {
    return undefined
  }
}

function save(session: GitHubSession | undefined): void {
  current = session
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* storage unavailable: the session lasts for this tab only */
  }
  for (const l of listeners) l(session)
}

current = load()

// Keep several tabs in sync (sign in or out in one, the others follow).
window.addEventListener('storage', (e) => {
  if (e.key === SESSION_KEY) {
    current = load()
    for (const l of listeners) l(current)
  }
})

export const getSession = (): GitHubSession | undefined => current
export const onDidChangeSession = (l: Listener): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

function toSession(m: Record<string, unknown>): GitHubSession | undefined {
  if (m.type !== 'luma-github-auth' || typeof m.token !== 'string' || typeof m.login !== 'string') return undefined
  return {
    token: m.token,
    login: m.login,
    name: String(m.name ?? ''),
    avatar: String(m.avatar ?? ''),
    apiUrl: String(m.apiUrl ?? 'https://api.github.com'),
    scope: String(m.scope ?? '')
  }
}

/** Opens the GitHub sign-in popup and resolves with the new session (or rejects if closed/cancelled/timed out). */
export function signIn(): Promise<GitHubSession> {
  return new Promise((resolve, reject) => {
    const w = 620
    const h = 760
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2))
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2))
    const popup = window.open('/api/auth/github/login', 'luma-github-login', `popup=yes,width=${w},height=${h},left=${left},top=${top}`)
    if (!popup) return reject(new Error('The sign-in window was blocked. Allow popups for this site and try again.'))

    let channel: BroadcastChannel | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (session?: GitHubSession, error?: Error): void => {
      channel?.close()
      clearInterval(poll)
      clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      window.removeEventListener('storage', onStorage)
      try { localStorage.removeItem(HANDOFF_KEY) } catch { /* ignore */ }
      if (session) {
        save(session)
        resolve(session)
      } else reject(error ?? new Error('Sign-in was cancelled.'))
    }
    const accept = (m: Record<string, unknown>): void => {
      const s = toSession(m)
      if (s) finish(s)
    }
    const onMessage = (e: MessageEvent): void => {
      if (e.origin === location.origin && e.data) accept(e.data as Record<string, unknown>)
    }
    const onStorage = (e: StorageEvent): void => {
      if (e.key === HANDOFF_KEY && e.newValue) {
        try { accept(JSON.parse(e.newValue) as Record<string, unknown>) } catch { /* ignore */ }
      }
    }
    try {
      channel = new BroadcastChannel(CHANNEL)
      channel.onmessage = (e) => accept(e.data as Record<string, unknown>)
    } catch { /* storage event is the fallback */ }
    window.addEventListener('message', onMessage)
    window.addEventListener('storage', onStorage)
    poll = setInterval(() => { if (popup.closed) setTimeout(() => finish(undefined, new Error('Sign-in was cancelled.')), 800) }, 600)
    timeout = setTimeout(() => finish(undefined, new Error('Sign-in timed out.')), 5 * 60_000)
  })
}

export function signOut(): void {
  save(undefined)
}

/** Fetches from the GitHub REST API as the signed-in user. */
export async function githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const s = current
  if (!s) throw new Error('Not signed in to GitHub.')
  return fetch(path.startsWith('http') ? path : `${s.apiUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${s.token}` }
  })
}
