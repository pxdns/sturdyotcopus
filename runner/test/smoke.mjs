// End-to-end smoke test for the runner, using a fake GitHub API and the (unsafe, test-only) local shell mode.
import { spawn } from 'node:child_process'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const checks = []
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }

// fake GitHub: token "good-octo" -> octo, "good-eve" -> eve, "org-member" -> mona (org member), anything else -> 401
const github = http.createServer((req, res) => {
  const token = String(req.headers.authorization ?? '').replace('Bearer ', '')
  const who = { 'good-octo': 'octo', 'good-eve': 'eve', 'org-member': 'mona' }[token]
  res.setHeader('content-type', 'application/json')
  if (!who) { res.statusCode = 401; return res.end('{}') }
  if (req.url === '/user') return res.end(JSON.stringify({ login: who }))
  if (req.url.startsWith('/user/memberships/orgs/acme')) return who === 'mona' ? res.end(JSON.stringify({ state: 'active' })) : (res.statusCode = 404, res.end('{}'))
  res.statusCode = 404; res.end('{}')
})
await new Promise((r) => github.listen(4390, r))

const runner = (extraEnv, port) => spawn('node', [join(here, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), RUNNER_MODE: 'local', RUNNER_UNSAFE_LOCAL: '1', GITHUB_API_URL: 'http://localhost:4390', RUNNER_ALLOWED_ORIGINS: 'https://ide.example', RUNNER_ALLOWED_USERS: 'octo', RUNNER_ALLOWED_ORG: 'acme', RUNNER_MAX_SESSIONS_PER_USER: '1', ...extraEnv },
  stdio: ['ignore', 'pipe', 'pipe']
})

// 0) refuses to start when unconfigured
{
  const p = spawn('node', [join(here, '..', 'server.mjs')], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''; p.stderr.on('data', (d) => (err += d))
  const code = await new Promise((r) => p.on('exit', r))
  check('refuses to start without an allow-list and origin', code === 1 && /RUNNER_ALLOWED_USERS/.test(err) && /RUNNER_ALLOWED_ORIGINS/.test(err))
}

const proc = runner({}, 8791)
await new Promise((r) => proc.stdout.on('data', (d) => /listening/.test(String(d)) && r()))

const open = (origin = 'https://ide.example') => new Promise((resolve) => {
  const ws = new WebSocket('ws://localhost:8791/ws', { headers: origin ? { Origin: origin } : {} })
  const msgs = []
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
  ws.on('open', () => resolve({ ws, msgs, ok: true }))
  ws.on('error', () => resolve({ ws, msgs, ok: false }))
  ws.on('unexpected-response', () => resolve({ ws, msgs, ok: false }))
})
const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }

// 1) wrong origin is rejected
check('rejects a disallowed origin', !(await open('https://evil.example')).ok)

// 2) bad token
{
  const { ws, msgs } = await open()
  ws.send(JSON.stringify({ type: 'auth', token: 'nope' }))
  check('rejects an invalid GitHub token', await waitFor(() => msgs.some((m) => m.type === 'error')))
  ws.close()
}
// 3) valid user not on the list and not in the org
{
  const { ws, msgs } = await open()
  ws.send(JSON.stringify({ type: 'auth', token: 'good-eve' }))
  check('rejects a GitHub user who is not allowed', await waitFor(() => msgs.some((m) => m.type === 'error' && /not allowed/.test(m.message))))
  ws.close()
}
// 4) allowed user: real shell, output + resize + input
{
  const { ws, msgs } = await open()
  ws.send(JSON.stringify({ type: 'auth', token: 'good-octo', cols: 100, rows: 30 }))
  check('accepts an allowed user', await waitFor(() => msgs.some((m) => m.type === 'ready' && m.login === 'octo')))
  ws.send(JSON.stringify({ type: 'input', data: 'echo luma-$((6*7)) && echo "$GITHUB_USER" && stty size\n' }))
  check('runs commands in a real PTY', await waitFor(() => msgs.filter((m) => m.type === 'output').map((m) => m.data).join('').includes('luma-42')))
  const text = () => msgs.filter((m) => m.type === 'output').map((m) => m.data).join('')
  check('passes the GitHub identity into the session', await waitFor(() => /\noctо?\r?\n|octo\r?\n/.test(text())))
  check('applies the initial terminal size', await waitFor(() => /30 100/.test(text())))
  ws.send(JSON.stringify({ type: 'resize', cols: 50, rows: 10 }))
  ws.send(JSON.stringify({ type: 'input', data: 'stty size\n' }))
  check('applies resize', await waitFor(() => /10 50/.test(text())))
  // 5) session limit (limit is 1)
  const second = await open()
  second.ws.send(JSON.stringify({ type: 'auth', token: 'good-octo' }))
  check('enforces the per-user session limit', await waitFor(() => second.msgs.some((m) => m.type === 'error' && /Limit/.test(m.message))))
  second.ws.close()
  ws.send(JSON.stringify({ type: 'input', data: 'exit\n' }))
  check('reports shell exit', await waitFor(() => msgs.some((m) => m.type === 'exit')))
}
// 6) org members are allowed
{
  const { ws, msgs } = await open()
  ws.send(JSON.stringify({ type: 'auth', token: 'org-member' }))
  check('allows members of the allowed organization', await waitFor(() => msgs.some((m) => m.type === 'ready' && m.login === 'mona')))
  ws.close()
}
// 7) no auth within the timeout is not tested (10 s); an input before auth is rejected
{
  const { ws, msgs } = await open()
  ws.send(JSON.stringify({ type: 'input', data: 'echo pwned\n' }))
  check('ignores input before authentication', await waitFor(() => msgs.some((m) => m.type === 'error')) && !msgs.some((m) => m.type === 'output'))
  ws.close()
}

proc.kill(); github.close()
const failed = checks.filter((c) => !c).length
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
