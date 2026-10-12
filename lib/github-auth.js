// GitHub OAuth (web flow) handlers, shared by the Vercel functions in api/auth/github/* and the Vite dev/preview server.
// Configuration (environment variables, set in Vercel; never committed):
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET   - the OAuth app credentials
//   GITHUB_ALLOWED_ORG                       - optional: only active members of this organization may sign in
//   GITHUB_URL / GITHUB_API_URL              - optional: GitHub Enterprise or a test double
// The access token is handed to the page (same origin) and is never stored server-side.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE = 'luma_gh_state'
const SCOPES = 'repo read:org'

const trim = (s) => String(s).replace(/\/+$/, '')
const urls = (env) => ({
  web: trim(env.GITHUB_URL || 'https://github.com'),
  api: trim(env.GITHUB_API_URL || 'https://api.github.com')
})

const sign = (value, secret) => createHmac('sha256', secret).update(value).digest('hex')

function makeState(secret) {
  const nonce = randomBytes(16).toString('hex')
  return `${nonce}.${sign(nonce, secret)}`
}

function validState(state, cookie, secret) {
  if (!state || !cookie || state !== cookie) return false
  const [nonce, mac] = state.split('.')
  if (!nonce || !mac) return false
  const expected = Buffer.from(sign(nonce, secret))
  const actual = Buffer.from(mac)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8ecf8;font:16px/1.5 system-ui,sans-serif}main{max-width:30rem;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#a3acc4}a{color:#7db7ff}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`

const html = (status, title, body, script, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers },
  body: page(title, body, script)
})

const clearCookie = (secure) => `${COOKIE}=; Path=/api/auth/github; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`

/** GET /api/auth/github/login */
export function handleLogin({ origin, env }) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return html(501, 'GitHub sign-in is not configured', '<p>The site owner has not set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> yet.</p>')
  }
  const { web } = urls(env)
  const state = makeState(env.GITHUB_CLIENT_SECRET)
  const secure = origin.startsWith('https:')
  const location = `${web}/login/oauth/authorize?` + new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/github/callback`,
    scope: SCOPES,
    state,
    allow_signup: 'true'
  })
  return {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Set-Cookie': `${COOKIE}=${state}; Path=/api/auth/github; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`
    },
    body: ''
  }
}

/** GET /api/auth/github/callback?code=&state= */
export async function handleCallback({ origin, query, cookies, env, fetchImpl = fetch }) {
  const secure = origin.startsWith('https:')
  const clear = { 'Set-Cookie': clearCookie(secure) }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return html(501, 'GitHub sign-in is not configured', '<p>Missing server configuration.</p>', '', clear)
  }
  if (query.error) {
    return html(400, 'Sign-in cancelled', `<p>GitHub reported: ${escapeHtml(query.error_description || query.error)}.</p><p><a href="/app/">Back to the IDE</a></p>`, '', clear)
  }
  if (!validState(query.state, cookies[COOKIE], env.GITHUB_CLIENT_SECRET) || !query.code) {
    return html(400, 'Sign-in failed', '<p>The sign-in request was invalid or expired. Please try again from the IDE.</p><p><a href="/app/">Back to the IDE</a></p>', '', clear)
  }
  const { web, api } = urls(env)
  try {
    const tokenRes = await fetchImpl(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'luma-ide' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: query.code,
        redirect_uri: `${origin}/api/auth/github/callback`
      })
    })
    const token = await tokenRes.json()
    if (!token.access_token) {
      return html(400, 'Sign-in failed', `<p>${escapeHtml(token.error_description || 'GitHub did not return an access token.')}</p><p><a href="/app/">Back to the IDE</a></p>`, '', clear)
    }
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'luma-ide' }
    const user = await (await fetchImpl(`${api}/user`, { headers })).json()
    if (!user.login) throw new Error('Could not read the GitHub user')

    if (env.GITHUB_ALLOWED_ORG) {
      const m = await fetchImpl(`${api}/user/memberships/orgs/${encodeURIComponent(env.GITHUB_ALLOWED_ORG)}`, { headers })
      const membership = m.ok ? await m.json() : null
      if (!membership || membership.state !== 'active') {
        return html(403, 'Access restricted', `<p>This site is limited to members of the <strong>${escapeHtml(env.GITHUB_ALLOWED_ORG)}</strong> organization. If you are a member, make sure the OAuth app is approved for that organization.</p><p><a href="/">Back to the home page</a></p>`, '', clear)
      }
    }

    const result = { type: 'luma-github-auth', token: token.access_token, scope: token.scope || '', login: user.login, name: user.name || '', avatar: user.avatar_url || '', apiUrl: api }
    const script = `const msg=${jsonForScript(result)};
try{new BroadcastChannel('luma-github-auth').postMessage(msg)}catch(e){}
try{localStorage.setItem('luma.github.handoff',JSON.stringify(Object.assign({t:Date.now()},msg)))}catch(e){}
try{if(window.opener)window.opener.postMessage(msg,location.origin)}catch(e){}
setTimeout(function(){window.close()},600);`
    return html(200, 'Signed in', `<p>You are signed in as <strong>${escapeHtml(user.login)}</strong>. You can close this window.</p><p><a href="/app/">Return to the IDE</a></p>`, script, clear)
  } catch (e) {
    return html(502, 'Sign-in failed', '<p>Could not reach GitHub. Please try again.</p><p><a href="/app/">Back to the IDE</a></p>', '', clear)
  }
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}
