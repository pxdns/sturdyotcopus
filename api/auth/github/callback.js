// Vercel function: GitHub OAuth callback (see lib/github-auth.js).
import { handleCallback, parseCookies } from '../../../lib/github-auth.js'

export default async function handler(req, res) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0]
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host).split(',')[0]
  const out = await handleCallback({
    origin: `${proto}://${host}`,
    query: req.query ?? {},
    cookies: parseCookies(req.headers.cookie),
    env: process.env
  })
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v)
  res.status(out.status).send(out.body)
}
