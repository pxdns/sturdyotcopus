// Builds the self-hosted extension catalog served by /api/gallery.
//
//   Open VSX search ─► filter (web-compatible, license, size) ─► download .vsix ─► unzip
//     public/gallery/resources/<publisher>/<name>/<version>/extension/**   extension files
//     public/gallery/assets/<publisher>/<name>/<version>/<assetType>       manifest / readme / icon ...
//     public/gallery/catalog.json                                          metadata for the query API
//     public/gallery/empty-listing.json                                    "[]" (resource listing)
//
// Only extensions that can run in a browser are kept: they either ship a `browser` entry point or
// are purely declarative (themes, grammars, snippets...). Node-only extensions (`main` without
// `browser`) are dropped. Failures are logged and never fail the build.
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const galleryDir = join(root, 'public', 'gallery')
const resourcesDir = join(galleryDir, 'resources')
const assetsDir = join(galleryDir, 'assets')
const config = JSON.parse(readFileSync(join(root, 'catalog.config.json'), 'utf8'))
const OPEN_VSX = (process.env.OPEN_VSX_URL ?? config.openVsxUrl).replace(/\/$/, '')
const force = process.argv.includes('--force')
const skip = process.argv.includes('--skip') || process.env.SKIP_CATALOG === '1'
const MB = 1024 * 1024
const SKIP_FILE = /(^|\/)(node_modules|\.git)(\/|$)|\.map$|\.vsixmanifest$|^\[Content_Types\]\.xml$/
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const UA = 'web-vscode-catalog-builder (+https://github.com/pxdns/sturdyotcopus)'

const ASSET = {
  manifest: 'Microsoft.VisualStudio.Code.Manifest',
  details: 'Microsoft.VisualStudio.Services.Content.Details',
  changelog: 'Microsoft.VisualStudio.Services.Content.Changelog',
  license: 'Microsoft.VisualStudio.Services.Content.License',
  icon: 'Microsoft.VisualStudio.Services.Icons.Default'
}

const log = (...a) => console.log('[catalog]', ...a)
const warn = (...a) => console.warn('[catalog] WARN', ...a)

async function http(url, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
      return res
    } catch (e) {
      last = e
      if (e.fatal) break
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw last
}

async function pool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i).catch((e) => ({ error: e }))
      }
    })
  )
  return results
}

/** web-compatible = has a browser entry point, or is declarative (no node entry point). */
function isWebCompatible(m) {
  if (!m || typeof m !== 'object') return false
  if (m.browser) return true
  if (m.main) return false
  const kinds = m.extensionKind
  if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes('web') && !kinds.includes('ui') && !kinds.includes('workspace')) return false
  return true
}

function licenseAllowed(m, allowed) {
  const raw = typeof m.license === 'string' ? m.license : (m.license?.type ?? '')
  if (!raw) return false
  const ids = raw.replace(/[()]/g, ' ').split(/\s+(?:OR|AND|WITH)\s+|\s+/i).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const ok = new Set(allowed.map((s) => s.toLowerCase()))
  return ids.some((id) => ok.has(id.replace(/\+$/, '')))
}

function uuidFor(id) {
  const h = createHash('sha1').update(`web-vscode:${id.toLowerCase()}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function search(extra, limit) {
  const found = []
  for (let offset = 0; found.length < limit; ) {
    const url = `${OPEN_VSX}/api/-/search?size=100&offset=${offset}&sortBy=downloadCount&sortOrder=desc&includeAllVersions=false${extra}`
    let page
    try {
      page = await (await http(url)).json()
    } catch (e) {
      warn(`search failed at offset ${offset}: ${e.message}`)
      break
    }
    const list = page.extensions ?? []
    found.push(...list)
    offset += list.length
    if (list.length === 0 || offset >= (page.totalSize ?? Infinity)) break
  }
  return found.slice(0, limit)
}

function walk(base, dir = base) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(base, full))
    else out.push(full.slice(base.length + 1).split(sep).join('/'))
  }
  return out
}

function pickAsset(files, re) {
  return files.find((f) => !f.includes('/') && re.test(f))
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** Fields of package.json that the catalog needs (keeps the cache small). */
const liteManifest = (m) => ({
  displayName: m.displayName, description: m.description, categories: m.categories, keywords: m.keywords,
  license: m.license, repository: m.repository, icon: m.icon, engines: m.engines, preview: m.preview,
  extensionDependencies: m.extensionDependencies, extensionPack: m.extensionPack, browser: m.browser,
  hasThemes: !!m.contributes?.themes
})

async function main() {
  if (skip) return log('skipped (SKIP_CATALOG=1 / --skip)')
  mkdirSync(galleryDir, { recursive: true })
  writeFileSync(join(galleryDir, 'empty-listing.json'), '[]')
  const cacheDir = resolve(root, config.cacheDir)
  mkdirSync(cacheDir, { recursive: true })
  const verdictFile = join(cacheDir, 'verdicts.json')
  const verdicts = force ? {} : readJson(verdictFile, {}) // "<id>@<version>" -> { web, lic, size, lite }
  const saveVerdicts = () => writeFileSync(verdictFile, JSON.stringify(verdicts))

  const builtin = readJson(join(root, 'extensions.json'), [])
  const pinned = new Set([...builtin, ...config.include].map((s) => String(s).toLowerCase()))
  const excluded = new Set(config.exclude.map((s) => String(s).toLowerCase()))
  const isPinned = (e) => pinned.has(`${e.namespace}.${e.name}`.toLowerCase())

  // 1. discover candidates: web-targeted first, then everything by popularity
  log(`scanning ${OPEN_VSX} (up to ${config.maxScan} candidates)...`)
  const [web, all] = [await search('&targetPlatform=web', config.maxScan), await search('', config.maxScan)]
  const byId = new Map()
  for (const e of [...web, ...all]) {
    const id = `${e.namespace}.${e.name}`.toLowerCase()
    if (!byId.has(id) && !excluded.has(id)) byId.set(id, e)
  }
  for (const id of pinned) {
    if (byId.has(id) || excluded.has(id)) continue
    const [ns, name] = id.split('.')
    try {
      const e = await (await http(`${OPEN_VSX}/api/${ns}/${name}`)).json()
      if (e?.files) byId.set(id, e)
    } catch (e) { warn(`${id}: ${e.message}`) }
  }
  const candidates = [...byId.values()]
    .map((e) => {
      const file = (n) => `${OPEN_VSX}/api/${e.namespace}/${e.name}/${e.version}/file/${n}`
      return { ...e, files: { ...e.files, manifest: e.files?.manifest ?? file('package.json'), download: e.files?.download ?? file(`${e.namespace}.${e.name}-${e.version}.vsix`) } }
    })
    .filter((e) => e.namespace && e.name && e.version && SAFE_SEGMENT.test(e.namespace) && SAFE_SEGMENT.test(e.name) && SAFE_SEGMENT.test(String(e.version)))
  log(`${candidates.length} candidates`)
  if (candidates.length === 0) {
    warn('no candidates found (Open VSX unreachable?); keeping any existing catalog')
    if (!existsSync(join(galleryDir, 'catalog.json'))) writeFileSync(join(galleryDir, 'catalog.json'), '[]')
    return
  }

  // 2. cheap check on package.json (time-boxed, cached): web-compatible? allowed license?
  const deadline = Date.now() + config.maxScanSeconds * 1000
  let cached = 0, fetched = 0, timedOut = 0
  await pool(candidates, config.concurrency, async (e) => {
    const key = `${e.namespace}.${e.name}@${e.version}`.toLowerCase()
    if (verdicts[key]) { cached++; return }
    if (Date.now() > deadline && !isPinned(e)) { timedOut++; return }
    const manifest = await (await http(e.files.manifest)).json()
    fetched++
    verdicts[key] = { web: isWebCompatible(manifest), lic: licenseAllowed(manifest, config.allowedLicenses), lite: liteManifest(manifest) }
  })
  saveVerdicts()
  log(`manifests: ${fetched} fetched, ${cached} from cache${timedOut ? `, ${timedOut} not scanned (time limit; they are picked up on the next build)` : ''}`)
  let ok = candidates
    .map((e) => ({ e, v: verdicts[`${e.namespace}.${e.name}@${e.version}`.toLowerCase()] }))
    .filter(({ e, v }) => v && v.web && v.lic && ((e.downloadCount ?? 0) >= config.minDownloads || isPinned(e)))
  log(`${ok.length} web-compatible with an allowed license`)

  // 3. size pre-filter with HEAD requests, so we never download huge extensions just to reject them
  const maxVsix = config.maxVsixMB * MB
  await pool(ok, config.concurrency, async (c) => {
    if (c.v.size !== undefined) return
    try {
      const res = await fetch(c.e.files.download, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })
      const len = Number(res.headers.get('content-length'))
      c.v.size = Number.isFinite(len) && len > 0 ? len : -1
    } catch { c.v.size = -1 }
  })
  saveVerdicts()
  const tooBig = ok.filter(({ e, v }) => v.size > maxVsix && !isPinned(e))
  ok = ok.filter((c) => !tooBig.includes(c))
  log(`${tooBig.length} dropped as too large (> ${config.maxVsixMB} MB packaged)`)

  // 4. curate: reserve room per category so many small useful extensions beat a few giants
  const bucketOf = (m) => {
    for (const cat of m.categories ?? []) if (config.quotas[cat] !== undefined) return cat
    return 'Other'
  }
  const buckets = new Map()
  for (const c of ok.sort((a, b) => (isPinned(b.e) ? 1 : 0) - (isPinned(a.e) ? 1 : 0) || (b.e.downloadCount ?? 0) - (a.e.downloadCount ?? 0))) {
    const b = bucketOf(c.v.lite)
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(c)
  }
  const picked = []
  for (const [b, list] of buckets) picked.push(...list.slice(0, config.quotas[b] ?? config.quotas.Other).map((c) => ({ ...c, bucket: b })))
  picked.sort((a, b) => (isPinned(b.e) ? 1 : 0) - (isPinned(a.e) ? 1 : 0) || (b.e.downloadCount ?? 0) - (a.e.downloadCount ?? 0))
  const queue = picked.slice(0, Math.ceil(config.maxExtensions * 1.15))
  log(`curated ${queue.length} extensions: ${[...buckets.keys()].map((b) => `${b} ${queue.filter((q) => q.bucket === b).length}`).join(', ')}`)

  // 5. download + unzip within the size budget (aggregated reporting)
  const entries = []
  const problems = { failed: [], tooLargeUnzipped: [], budget: [] }
  let totalBytes = 0
  let totalFiles = 0
  async function materialize({ e, v }) {
    const pub = e.namespace, name = e.name, ver = String(e.version)
    const extDir = join(resourcesDir, pub, name, ver, 'extension')
    const cacheCopy = join(cacheDir, 'ext', `${pub}.${name}-${ver}`.toLowerCase())
    if (force || !existsSync(join(extDir, 'package.json'))) {
      if (!force && existsSync(join(cacheCopy, 'package.json'))) {
        rmSync(join(resourcesDir, pub, name), { recursive: true, force: true })
        cpSync(cacheCopy, extDir, { recursive: true })
      } else {
        const vsix = new Uint8Array(await (await http(e.files.download)).arrayBuffer())
        const zip = unzipSync(vsix)
        let bytes = 0
        const outFiles = []
        for (const [path, data] of Object.entries(zip)) {
          if (path.endsWith('/') || !path.startsWith('extension/')) continue
          const rel = path.slice('extension/'.length)
          if (SKIP_FILE.test(rel)) continue
          bytes += data.length
          outFiles.push([rel, data])
        }
        if (bytes > config.maxExtensionMB * MB) { const err = new Error('too large'); err.code = 'big'; throw err }
        rmSync(join(resourcesDir, pub, name), { recursive: true, force: true })
        for (const [rel, data] of outFiles) {
          const target = resolve(extDir, rel)
          if (!target.startsWith(extDir + sep)) continue // zip-slip guard
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, data)
        }
        try { rmSync(cacheCopy, { recursive: true, force: true }); cpSync(extDir, cacheCopy, { recursive: true }) } catch { /* cache is optional */ }
      }
    }
    const files = walk(extDir)
    const bytes = files.reduce((n, f) => n + statSync(join(extDir, f)).size, 0)
    return { files, bytes, extDir, pub, name, ver, v }
  }

  for (let i = 0; i < queue.length && entries.length < config.maxExtensions; i += config.concurrency) {
    const batch = queue.slice(i, i + config.concurrency)
    const done = await pool(batch, config.concurrency, async (c) => {
      try { return { c, m: await materialize(c) } } catch (err) {
        (err.code === 'big' ? problems.tooLargeUnzipped : problems.failed).push(`${c.e.namespace}.${c.e.name}`)
        return null
      }
    })
    for (const r of done) {
      if (!r || r.error || entries.length >= config.maxExtensions) continue
      const { c, m } = r
      const key = `${m.pub}.${m.name}`.toLowerCase()
      if (totalFiles + m.files.length + 6 > config.maxFiles || totalBytes + m.bytes > config.maxTotalMB * MB) {
        problems.budget.push(key)
        rmSync(join(resourcesDir, m.pub, m.name), { recursive: true, force: true })
        continue
      }
      const mf = m.v.lite
      const assets = {
        manifest: 'package.json',
        details: pickAsset(m.files, /^readme(\.md|\.markdown|\.txt)?$/i),
        changelog: pickAsset(m.files, /^(changelog|changes|history)(\.md|\.markdown|\.txt)?$/i),
        license: pickAsset(m.files, /^(license|licence|copying)(\.md|\.txt)?$/i),
        icon: typeof mf.icon === 'string' ? mf.icon.replace(/^\.?\//, '') : undefined
      }
      if (assets.icon && !m.files.includes(assets.icon)) assets.icon = undefined
      const assetBase = join(assetsDir, m.pub, m.name, m.ver)
      rmSync(assetBase, { recursive: true, force: true })
      mkdirSync(assetBase, { recursive: true })
      for (const [k, rel] of Object.entries(assets)) {
        if (rel) copyFileSync(join(m.extDir, rel), join(assetBase, ASSET[k]))
      }
      totalFiles += m.files.length + Object.values(assets).filter(Boolean).length
      totalBytes += m.bytes
      entries.push({
        id: `${m.pub}.${m.name}`,
        uuid: uuidFor(key),
        publisher: m.pub,
        name: m.name,
        version: m.ver,
        displayName: mf.displayName || c.e.displayName || m.name,
        description: mf.description || c.e.description || '',
        categories: Array.isArray(mf.categories) ? mf.categories : [],
        tags: [...new Set([...(Array.isArray(mf.keywords) ? mf.keywords : []), ...(mf.hasThemes ? ['theme'] : [])])].slice(0, 20),
        downloadCount: c.e.downloadCount ?? 0,
        averageRating: c.e.averageRating ?? 0,
        ratingCount: c.e.reviewCount ?? c.e.ratingCount ?? 0,
        timestamp: c.e.timestamp ?? null,
        license: typeof mf.license === 'string' ? mf.license : '',
        repository: typeof mf.repository === 'string' ? mf.repository : (mf.repository?.url ?? ''),
        engine: mf.engines?.vscode ?? '*',
        preview: !!mf.preview,
        dependencies: Array.isArray(mf.extensionDependencies) ? mf.extensionDependencies : [],
        extensionPack: Array.isArray(mf.extensionPack) ? mf.extensionPack : [],
        executesCode: !!mf.browser,
        assets
      })
    }
  }

  // 6. drop extensions whose hard dependencies / pack members are not in the catalog (to a fixpoint)
  const droppedDeps = []
  let changed = true
  while (changed) {
    changed = false
    const ids = new Set(entries.map((e) => e.id.toLowerCase()))
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if ([...e.dependencies, ...e.extensionPack].some((d) => !ids.has(String(d).toLowerCase()))) {
        droppedDeps.push(e.id)
        rmSync(join(resourcesDir, e.publisher, e.name), { recursive: true, force: true })
        rmSync(join(assetsDir, e.publisher, e.name), { recursive: true, force: true })
        entries.splice(i, 1)
        changed = true
      }
    }
  }

  // 7. remove stale mirrored extensions that are no longer in the catalog
  const keep = new Set(entries.map((e) => `${e.publisher}/${e.name}/${e.version}`))
  for (const base of [resourcesDir, assetsDir]) {
    if (!existsSync(base)) continue
    for (const pub of readdirSync(base)) {
      for (const name of readdirSync(join(base, pub))) {
        for (const ver of readdirSync(join(base, pub, name))) {
          if (!keep.has(`${pub}/${name}/${ver}`)) rmSync(join(base, pub, name, ver), { recursive: true, force: true })
        }
      }
    }
  }

  entries.sort((a, b) => b.downloadCount - a.downloadCount)
  writeFileSync(join(galleryDir, 'catalog.json'), JSON.stringify(entries))
  const sample = (list) => (list.length ? ` e.g. ${list.slice(0, 3).join(', ')}` : '')
  if (problems.failed.length) warn(`${problems.failed.length} download(s) failed;${sample(problems.failed)}`)
  if (problems.tooLargeUnzipped.length) log(`${problems.tooLargeUnzipped.length} dropped: unpacked size over ${config.maxExtensionMB} MB;${sample(problems.tooLargeUnzipped)}`)
  if (problems.budget.length) log(`${problems.budget.length} not added: file/size budget reached (raise maxFiles/maxTotalMB in catalog.config.json)`)
  if (droppedDeps.length) log(`${droppedDeps.length} dropped: missing dependency;${sample(droppedDeps)}`)
  log(`catalog.json: ${entries.length} extensions, ${totalFiles} files, ${(totalBytes / MB).toFixed(1)} MB`)
}

main().catch((e) => warn(`unexpected error: ${e.stack ?? e}`)).finally(() => process.exit(0))
