import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { defineConfig, type Connect, type Plugin } from 'vite'
import { handleGalleryRequest, type CatalogEntry } from './lib/gallery-query.js'

// monaco-vscode-api expects CSS files from its packages to be exported as strings
// (it injects them itself), exactly as in the official demo.
const loadVscodeCssAsString: Plugin = {
  name: 'load-vscode-css-as-string',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, options)
    if (resolved == null) {
      throw new Error(`Unable to resolve: ${source} from ${importer}`)
    }
    if (/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)) {
      return { ...resolved, id: resolved.id + '?inline' }
    }
    return undefined
  }
}

// SharedArrayBuffer (used by the *-language-features extensions) needs cross-origin isolation.
// In production these headers come from vercel.json.
const isolationHeaders: Connect.NextHandleFunction = (_req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
}

/**
 * The extension gallery API. In production it is the Vercel function api/gallery.js; this plugin serves the
 * same logic (lib/gallery-query.js) from `vite dev` and `vite preview`, reading the catalog that
 * scripts/build-catalog.mjs wrote to public/gallery (dev) or dist/gallery (preview).
 */
function galleryApi(root: string): Connect.NextHandleFunction {
  const catalogFiles = [join(root, 'public/gallery/catalog.json'), join(root, 'dist/gallery/catalog.json')]
  const loadCatalog = (): CatalogEntry[] => {
    for (const file of catalogFiles) {
      if (existsSync(file)) {
        try { return JSON.parse(readFileSync(file, 'utf8')) as CatalogEntry[] } catch { /* try next */ }
      }
    }
    return []
  }
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(undefined) }
      })
    })
  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // The workbench lists an extension's files by requesting its root; we answer with an empty list.
    if (/^\/gallery\/resources\/[^/]+\/[^/]+\/[^/]+\/extension\/?$/.test(url.pathname)) return sendJson(res, 200, [])
    if (!url.pathname.startsWith('/api/gallery')) return next()
    const origin = `http://${req.headers.host}`
    const body = req.method === 'POST' ? await readBody(req) : undefined
    const out = handleGalleryRequest({
      method: req.method ?? 'GET',
      path: url.pathname.slice('/api/gallery'.length),
      body,
      catalog: loadCatalog(),
      origin
    })
    sendJson(res, out.status, out.body ?? {})
  }
}

const gallery = (): Plugin => ({
  name: 'gallery-api',
  configureServer(server) {
    server.middlewares.use(isolationHeaders)
    server.middlewares.use(galleryApi(server.config.root))
  },
  configurePreviewServer(server) {
    server.middlewares.use(isolationHeaders)
    server.middlewares.use(galleryApi(server.config.root))
  }
})

export default defineConfig({
  build: { target: 'esnext', chunkSizeWarningLimit: 100000 },
  worker: { format: 'es' },
  plugins: [loadVscodeCssAsString, gallery()],
  optimizeDeps: {
    include: [
      '@codingame/monaco-vscode-api/extensions',
      '@codingame/monaco-vscode-api',
      '@codingame/monaco-vscode-api/monaco',
      'vscode/localExtensionHost',
      '@vscode/vscode-languagedetection',
      'marked'
    ]
  },
  server: { port: 5173, host: '0.0.0.0' },
  resolve: { dedupe: ['vscode'] }
})
