import { ExtensionHostKind, registerExtension, type IExtensionManifest } from '@codingame/monaco-vscode-api/extensions'
import { unzipSync, strFromU8 } from 'fflate'

// Extensions and themes the user adds from their own computer. They live in IndexedDB and are registered at every start,
// before the workbench initialises, so themes are there on first paint. Only declarative contributions are used:
// uploaded code is never executed.

const DB = 'luma-uploaded-extensions'
const STORE = 'extensions'
export const MAX_FILE_MB = 25
export const MAX_TOTAL_MB = 120

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export interface UploadedExtension {
  id: string
  label: string
  version: string
  kind: 'vsix' | 'theme'
  manifest: Mutable<IExtensionManifest> & { main?: string; browser?: string }
  files: Record<string, Uint8Array>
  size: number
  added: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable'))
  })
}
const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => { resolve(req.result); db.close() }
    req.onerror = () => { reject(req.error); db.close() }
  })
}

export const listUploaded = (): Promise<UploadedExtension[]> => tx('readonly', (s) => s.getAll() as IDBRequest<UploadedExtension[]>).catch(() => [])
export const removeUploaded = (id: string): Promise<void> => tx('readwrite', (s) => s.delete(id)).then(() => undefined)
export const saveUploaded = (e: UploadedExtension): Promise<void> => tx('readwrite', (s) => s.put(e)).then(() => undefined)

const MIME: Record<string, string> = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', md: 'text/markdown' }
const mime = (p: string): string => MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** Replaces %key% placeholders using package.nls.json, like the marketplace does. */
function localize(value: unknown, nls: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const m = /^%(.+)%$/.exec(value)
    if (!m) return value
    const hit = nls[m[1]]
    return typeof hit === 'string' ? hit : typeof (hit as { message?: string })?.message === 'string' ? (hit as { message: string }).message : value
  }
  if (Array.isArray(value)) return value.map((v) => localize(v, nls))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v, nls)]))
  return value
}

const stripJsonComments = (s: string): string => s.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1')

/** Reads a user-supplied file: a .vsix package or a single colour theme JSON. */
export async function parseUpload(file: File): Promise<UploadedExtension> {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`The file is larger than ${MAX_FILE_MB} MB.`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const name = file.name

  if (/\.vsix$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    let zip: Record<string, Uint8Array>
    try { zip = unzipSync(bytes) } catch { throw new Error('That file is not a valid .vsix package.') }
    const files: Record<string, Uint8Array> = {}
    for (const [p, data] of Object.entries(zip)) if (p.startsWith('extension/') && !p.endsWith('/')) files[p.slice('extension/'.length)] = data
    const pkg = files['package.json']
    if (!pkg) throw new Error('The package has no extension/package.json.')
    let manifest = JSON.parse(strFromU8(pkg)) as UploadedExtension['manifest']
    if (!manifest.name) throw new Error('package.json has no "name".')
    if (files['package.nls.json']) {
      try { manifest = localize(manifest, JSON.parse(stripJsonComments(strFromU8(files['package.nls.json']))) as Record<string, unknown>) as typeof manifest } catch { /* keep raw values */ }
    }
    // The browser cannot run Node code, and uploaded code is never run at all.
    delete manifest.main; delete manifest.browser
    manifest.activationEvents = undefined
    manifest.extensionDependencies = undefined; manifest.extensionPack = undefined
    const c = manifest.contributes ?? {}
    const usable = ['themes', 'iconThemes', 'productIconThemes', 'grammars', 'languages', 'snippets', 'keybindings'].filter((k) => (c as Record<string, unknown>)[k])
    if (!usable.length) throw new Error('This extension has no themes, grammars, snippets or keybindings. Extensions that only run code cannot be used in a browser.')
    manifest.contributes = Object.fromEntries(Object.entries(c).filter(([k]) => usable.includes(k))) as typeof c
    manifest.publisher ||= 'uploaded'
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase()
    const size = Object.values(files).reduce((n, f) => n + f.length, 0)
    return { id, label: manifest.displayName || manifest.name, version: manifest.version ?? '0.0.0', kind: 'vsix', manifest, files, size, added: Date.now() }
  }

  if (/\.json(c)?$/i.test(name)) {
    let theme: { name?: string; type?: string; colors?: unknown; tokenColors?: unknown; semanticTokenColors?: unknown }
    try { theme = JSON.parse(stripJsonComments(new TextDecoder().decode(bytes))) } catch { throw new Error('That file is not valid JSON.') }
    if (!theme || typeof theme !== 'object' || (!theme.colors && !theme.tokenColors)) throw new Error('That JSON is not a VS Code color theme (it needs "colors" or "tokenColors").')
    const base = name.replace(/\.jsonc?$/i, '')
    const label = (typeof theme.name === 'string' && theme.name.trim()) || base
    const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
    const uiTheme = theme.type === 'light' ? 'vs' : theme.type === 'hc' || theme.type === 'hc-black' ? 'hc-black' : theme.type === 'hc-light' ? 'hc-light' : 'vs-dark'
    const manifest = { name: slug, publisher: 'uploaded', version: '1.0.0', displayName: label, engines: { vscode: '*' }, contributes: { themes: [{ label, uiTheme, path: './theme.json' }] } } as UploadedExtension['manifest']
    return { id: `uploaded.${slug}`, label, version: '1.0.0', kind: 'theme', manifest, files: { 'theme.json': bytes }, size: bytes.length, added: Date.now() }
  }

  throw new Error('Choose a .vsix package or a color theme .json file.')
}

/** Registers every stored extension. Must run before the workbench is initialised. */
export async function registerUploadedExtensions(): Promise<string[]> {
  const out: string[] = []
  for (const ext of await listUploaded()) {
    try {
      const { registerFileUrl } = registerExtension(ext.manifest, ExtensionHostKind.LocalWebWorker, { path: '/' })
      for (const [path, data] of Object.entries(ext.files)) {
        registerFileUrl('/' + path, URL.createObjectURL(new Blob([data as BlobPart], { type: mime(path) })))
      }
      out.push(ext.id)
    } catch (e) {
      console.warn(`Failed to register uploaded extension ${ext.id}`, e)
    }
  }
  return out
}

export async function totalUploadedBytes(): Promise<number> {
  return (await listUploaded()).reduce((n, e) => n + e.size, 0)
}
