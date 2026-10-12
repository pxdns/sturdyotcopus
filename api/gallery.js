// Vercel serverless function: the extension gallery API (see lib/gallery-query.js).
// vercel.json rewrites /api/gallery/* to this function with ?path=*.
import { handleGalleryRequest } from '../lib/gallery-query.js'

let cache = { at: 0, origin: '', catalog: [] }
const TTL_MS = 5 * 60 * 1000

async function loadCatalog(origin, headers) {
  if (cache.catalog.length && cache.origin === origin && Date.now() - cache.at < TTL_MS) return cache.catalog
  try {
    // The catalog is a static file produced at build time; forward cookies so protected preview deployments work.
    const res = await fetch(`${origin}/gallery/catalog.json`, { headers: headers.cookie ? { cookie: headers.cookie } : {} })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const catalog = await res.json()
    if (Array.isArray(catalog)) {
      cache = { at: Date.now(), origin, catalog }
      return catalog
    }
  } catch (e) {
    console.error('gallery: cannot load catalog', e)
  }
  return cache.catalog
}

export default async function handler(req, res) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0]
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host).split(',')[0]
  const origin = `${proto}://${host}`
  const raw = req.query?.path
  const path = Array.isArray(raw) ? raw.join('/') : (raw ?? '')
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { body = undefined }
  }
  const catalog = await loadCatalog(origin, req.headers)
  const { status, body: out } = handleGalleryRequest({ method: req.method ?? 'GET', path, body, catalog, origin })
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=60, s-maxage=300' : 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(status).json(out ?? {})
}
