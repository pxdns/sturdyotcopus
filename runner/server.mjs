// Luma runner: a WebSocket terminal server. Each connection authenticates with the user's GitHub token, then gets an
// isolated shell (a Docker container by default) running a real PTY. The IDE side is src/features/runner.ts.
//
// Safe by default: the server refuses to start unless you say who may connect (RUNNER_ALLOWED_USERS or RUNNER_ALLOWED_ORG)
// and from which web origin (RUNNER_ALLOWED_ORIGINS). See README.md.
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import * as pty from '@lydell/node-pty'
import { WebSocketServer } from 'ws'

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const cfg = {
  port: Number(process.env.PORT) || 8787,
  mode: process.env.RUNNER_MODE || 'docker', // docker | local (local = no isolation, development only)
  image: process.env.RUNNER_IMAGE || 'luma-runner:latest',
  origins: list(process.env.RUNNER_ALLOWED_ORIGINS),
  anyOrigin: process.env.RUNNER_ALLOW_ANY_ORIGIN === '1',
  users: list(process.env.RUNNER_ALLOWED_USERS).map((s) => s.toLowerCase()),
  org: process.env.RUNNER_ALLOWED_ORG || '',
  anyUser: process.env.RUNNER_ALLOW_ANY_GITHUB_USER === '1',
  api: String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  maxPerUser: Number(process.env.RUNNER_MAX_SESSIONS_PER_USER) || 2,
  idleMs: (Number(process.env.RUNNER_IDLE_MINUTES) || 30) * 60_000,
  memory: process.env.RUNNER_MEMORY || '2g',
  cpus: process.env.RUNNER_CPUS || '1',
  pids: process.env.RUNNER_PIDS || '512',
  unsafeLocal: process.env.RUNNER_UNSAFE_LOCAL === '1'
}

const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

export function validateConfig(c) {
  const problems = []
  if (!c.users.length && !c.org && !c.anyUser) problems.push('Set RUNNER_ALLOWED_USERS or RUNNER_ALLOWED_ORG (or RUNNER_ALLOW_ANY_GITHUB_USER=1 to allow every GitHub account).')
  if (!c.origins.length && !c.anyOrigin) problems.push('Set RUNNER_ALLOWED_ORIGINS to your IDE origin, for example https://luma-ide.vercel.app (or RUNNER_ALLOW_ANY_ORIGIN=1 for local testing).')
  if (c.mode === 'local' && !c.unsafeLocal) problems.push('RUNNER_MODE=local has no isolation. Set RUNNER_UNSAFE_LOCAL=1 to confirm you are only testing.')
  if (!['docker', 'local'].includes(c.mode)) problems.push('RUNNER_MODE must be docker or local.')
  return problems
}

// ---------- GitHub identity
const identityCache = new Map() // sha256(token) -> { login, at }
async function identify(token) {
  const key = createHash('sha256').update(token).digest('hex')
  const hit = identityCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.login
  const res = await fetch(`${cfg.api}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'luma-runner' } })
  if (!res.ok) throw new Error('GitHub rejected the token')
  const login = String((await res.json()).login ?? '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new Error('Unexpected GitHub login')
  identityCache.set(key, { login, at: Date.now() })
  return login
}

async function isAllowed(login, token) {
  if (cfg.users.includes(login.toLowerCase())) return true
  if (cfg.org) {
    const res = await fetch(`${cfg.api}/user/memberships/orgs/${encodeURIComponent(cfg.org)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'luma-runner' } })
    if (res.ok && (await res.json()).state === 'active') return true
  }
  return cfg.anyUser
}

// ---------- shells
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const REF = /^[A-Za-z0-9._\/-]{1,100}$/

function spawnShell({ login, token, repo, ref, cols, rows }) {
  const base = { TERM: 'xterm-256color', LANG: 'C.UTF-8', GITHUB_TOKEN: token, GITHUB_USER: login }
  if (repo) base.LUMA_REPO = repo
  if (ref) base.LUMA_REF = ref
  if (cfg.mode === 'local') {
    const dir = join(os.tmpdir(), 'luma-runner', login)
    mkdirSync(dir, { recursive: true })
    const proc = pty.spawn(process.env.SHELL || 'bash', ['--noprofile', '--norc'], { name: 'xterm-256color', cols, rows, cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...base } })
    return { proc, kill: () => { try { proc.kill() } catch { /* already gone */ } } }
  }
  const name = `luma-${login.toLowerCase()}-${randomBytes(4).toString('hex')}`
  const args = [
    'run', '--rm', '-it', '--name', name,
    '--memory', cfg.memory, '--cpus', cfg.cpus, '--pids-limit', cfg.pids,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', 'TERM', '-e', 'LANG', '-e', 'GITHUB_TOKEN', '-e', 'GITHUB_USER', '-e', 'LUMA_REPO', '-e', 'LUMA_REF',
    '-v', `luma-work-${login.toLowerCase()}:/work`, '-w', '/work',
    cfg.image
  ]
  const proc = pty.spawn('docker', args, { name: 'xterm-256color', cols, rows, env: { PATH: process.env.PATH, HOME: os.homedir(), ...base } })
  return {
    proc,
    kill: () => {
      try { proc.kill() } catch { /* already gone */ }
      spawnSync('docker', ['kill', name], { stdio: 'ignore' })
    }
  }
}

// ---------- server
const sessions = new Map() // login -> Set(session)
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, mode: cfg.mode }))
  }
  res.writeHead(404).end()
})
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const origin = req.headers.origin ?? ''
  if (url.pathname !== '/ws' || (!cfg.anyOrigin && !cfg.origins.includes(origin))) {
    log('rejected', { reason: url.pathname !== '/ws' ? 'path' : 'origin', origin })
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
  const fail = (message, code = 4003) => { send({ type: 'error', message }); ws.close(code) }
  let session
  const authTimer = setTimeout(() => fail('Authentication timed out', 4001), 10_000)

  ws.on('message', async (raw) => {
    let m
    try { m = JSON.parse(String(raw)) } catch { return }
    if (session) {
      session.touch()
      if (m.type === 'input' && typeof m.data === 'string') session.shell.proc.write(m.data)
      else if (m.type === 'resize') session.shell.proc.resize(Math.max(2, Math.min(500, m.cols | 0)), Math.max(2, Math.min(300, m.rows | 0)))
      return
    }
    if (m.type !== 'auth' || typeof m.token !== 'string') return fail('Expected authentication first', 4002)
    clearTimeout(authTimer)
    try {
      const login = await identify(m.token)
      if (!(await isAllowed(login, m.token))) {
        log('denied', { login })
        return fail('This GitHub account is not allowed to use this runner.')
      }
      const mine = sessions.get(login) ?? new Set()
      if (mine.size >= cfg.maxPerUser) return fail(`Limit of ${cfg.maxPerUser} sessions reached. Close one and try again.`, 4004)
      const repo = typeof m.repo === 'string' && REPO.test(m.repo) ? m.repo : undefined
      const ref = typeof m.ref === 'string' && REF.test(m.ref) ? m.ref : undefined
      const cols = Math.max(2, Math.min(500, Number(m.cols) || 80))
      const rows = Math.max(2, Math.min(300, Number(m.rows) || 24))
      const shell = spawnShell({ login, token: m.token, repo, ref, cols, rows })
      let idle
      const s = {
        shell,
        touch: () => { clearTimeout(idle); idle = setTimeout(() => { send({ type: 'output', data: '\r\n[Closed: idle for too long]\r\n' }); close() }, cfg.idleMs) }
      }
      const close = () => { clearTimeout(idle); shell.kill(); mine.delete(s); try { ws.close() } catch { /* closed */ } }
      session = s
      mine.add(s)
      sessions.set(login, mine)
      s.touch()
      shell.proc.onData((data) => {
        send({ type: 'output', data })
        if (ws.bufferedAmount > 1 << 20) { shell.proc.pause(); const t = setInterval(() => { if (ws.bufferedAmount < 1 << 18 || ws.readyState !== ws.OPEN) { clearInterval(t); shell.proc.resume() } }, 50) }
      })
      shell.proc.onExit(({ exitCode }) => { send({ type: 'exit', code: exitCode }); close() })
      ws.on('close', close)
      log('session', { login, repo: repo ?? null, active: mine.size })
      send({ type: 'ready', login })
    } catch (e) {
      log('auth-failed', { reason: e.message })
      fail(e.message === 'GitHub rejected the token' ? 'GitHub rejected the token. Sign in again.' : 'Could not verify your GitHub identity.')
    }
  })
  ws.on('close', () => clearTimeout(authTimer))
})

export function start() {
  const problems = validateConfig(cfg)
  if (problems.length) {
    console.error('Luma runner refuses to start:\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  server.listen(cfg.port, () => log('listening', { port: cfg.port, mode: cfg.mode, origins: cfg.origins.length, users: cfg.users.length, org: cfg.org || null }))
  const stop = () => { for (const set of sessions.values()) for (const s of set) s.shell.kill(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

start()
