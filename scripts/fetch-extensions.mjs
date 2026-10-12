// Downloads the extensions listed in extensions.json from Open VSX, unzips them into
// public/extensions/<publisher>.<name>/, copies extensions-local/*, and writes
// public/extensions/manifest.json. Failures are logged but never fail the build.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'extensions')
const localDir = join(root, 'extensions-local')
const listFile = join(root, 'extensions.json')
const OPEN_VSX = process.env.OPEN_VSX_URL ?? 'https://open-vsx.org'
const force = process.argv.includes('--force')
const SKIP_FILE = /(^|\/)(node_modules|\.git)(\/|$)|\.map$|\.vsixmanifest$|^\[Content_Types\]\.xml$/

const log = (...a) => console.log('[extensions]', ...a)
const warn = (...a) => console.warn('[extensions] WARN', ...a)

async function fetchWithRetry(url, init = {}, tries = 3) {
  let lastError
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return res
    } catch (e) {
      lastError = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw lastError
}

function writeEntries(entries, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  let count = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || !name.startsWith('extension/')) continue
    const rel = name.slice('extension/'.length)
    if (SKIP_FILE.test(rel)) continue
    const target = resolve(dest, rel)
    if (!target.startsWith(dest + sep)) continue // zip-slip guard
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    count++
  }
  return count
}

async function fetchExtension(id) {
  const [publisher, name] = id.split('.')
  if (!publisher || !name || id.split('.').length !== 2) throw new Error(`invalid id "${id}" (expected publisher.name)`)
  const dest = join(outDir, `${publisher}.${name}`.toLowerCase())
  if (!force && existsSync(join(dest, 'package.json'))) {
    log(`${id}: already present, skipping (use --force to refresh)`)
    return
  }
  const meta = await (await fetchWithRetry(`${OPEN_VSX}/api/${publisher}/${name}`)).json()
  const download = meta?.files?.download
  if (!download) throw new Error(meta?.error ?? 'no download URL in API response')
  const vsix = new Uint8Array(await (await fetchWithRetry(download)).arrayBuffer())
  const count = writeEntries(unzipSync(vsix), dest)
  if (!existsSync(join(dest, 'package.json'))) {
    rmSync(dest, { recursive: true, force: true })
    throw new Error('vsix has no extension/package.json')
  }
  log(`${id}@${meta.version}: ${count} files`)
}

function copyLocalExtensions() {
  if (!existsSync(localDir)) return
  for (const entry of readdirSync(localDir)) {
    const src = join(localDir, entry)
    try {
      if (!statSync(src).isDirectory()) continue
      const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
      const dest = join(outDir, `${pkg.publisher}.${pkg.name}`.toLowerCase())
      rmSync(dest, { recursive: true, force: true })
      cpSync(src, dest, { recursive: true })
      log(`${pkg.publisher}.${pkg.name}: copied from extensions-local/${entry}`)
    } catch (e) {
      warn(`extensions-local/${entry}: ${e.message}`)
    }
  }
}

function walk(base, dir = base) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(base, full))
    else files.push(relative(base, full).split(sep).join('/'))
  }
  return files
}

function writeManifest() {
  const extensions = []
  for (const folder of readdirSync(outDir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const base = join(outDir, folder.name)
    try {
      const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
      const nlsFile = join(base, 'package.nls.json')
      let nls
      if (existsSync(nlsFile)) {
        try { nls = JSON.parse(readFileSync(nlsFile, 'utf8')) } catch { /* ignore bad nls */ }
      }
      const files = walk(base).filter((f) => !SKIP_FILE.test(f))
      extensions.push({ id: `${manifest.publisher}.${manifest.name}`, folder: folder.name, manifest, nls, files })
    } catch (e) {
      warn(`${folder.name}: skipped in manifest (${e.message})`)
    }
  }
  extensions.sort((a, b) => a.id.localeCompare(b.id))
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ extensions }))
  log(`manifest.json: ${extensions.length} extension(s)`)
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  let ids = []
  try {
    ids = JSON.parse(readFileSync(listFile, 'utf8'))
    if (!Array.isArray(ids)) throw new Error('extensions.json must be an array of IDs')
  } catch (e) {
    warn(`cannot read extensions.json: ${e.message}`)
  }
  const failures = []
  for (const id of ids) {
    try {
      await fetchExtension(String(id).trim())
    } catch (e) {
      failures.push(id)
      warn(`${id}: ${e.message}${e.cause ? ` (${e.cause.message ?? e.cause})` : ''}`)
    }
  }
  copyLocalExtensions()
  writeManifest()
  if (failures.length) warn(`${failures.length} extension(s) failed: ${failures.join(', ')}`)
}

main().catch((e) => {
  warn(`unexpected error: ${e.stack ?? e}`)
}).finally(() => process.exit(0))
