import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { defineConfig, type Connect, type Plugin } from 'vite'
import { handleGalleryRequest, type CatalogEntry } from './lib/gallery-query.js'
import { handleCallback, handleLogin, parseCookies } from './lib/github-auth.js'

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
    if (url.pathname === '/api/auth/github/login' || url.pathname === '/api/auth/github/callback') {
      const origin = `http://${req.headers.host}`
      const args = { origin, env: process.env as Record<string, string | undefined> }
      const out =
        url.pathname.endsWith('/login')
          ? handleLogin(args)
          : await handleCallback({ ...args, query: Object.fromEntries(url.searchParams), cookies: parseCookies(req.headers.cookie) })
      res.statusCode = out.status
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v)
      res.end(out.body)
      return
    }
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

/** Replaces {{name}}, {{tagline}}... from site.config.json and <!--include:header|footer--> partials in every HTML page. */
function siteTemplate(root: string): Plugin {
  const config = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8')) as Record<string, unknown>
  const status = (config.status ?? {}) as Record<string, string>
  const label: Record<string, string> = { live: 'Live', building: 'Building', planned: 'Planned' }
  const partial = (name: string) => readFileSync(join(root, 'site/partials', `${name}.html`), 'utf8')
  return {
    name: 'site-template',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace(/<!--include:(\w+)-->/g, (_m, name: string) => partial(name))
          .replace(/\{\{status:([\w-]+)\}\}/g, (m, key: string) => {
            const s = status[key]
            return s ? `<span class="status" data-s="${s}">${label[s] ?? s}</span>` : m
          })
          .replace(/\{\{(\w+)\}\}/g, (m, key: string) => (typeof config[key] === 'string' ? (config[key] as string) : m))
      }
    }
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
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 100000,
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL('./index.html', import.meta.url)),
        features: fileURLToPath(new URL('./features/index.html', import.meta.url)),
        python: fileURLToPath(new URL('./python/index.html', import.meta.url)),
        java_gradle: fileURLToPath(new URL('./java-gradle/index.html', import.meta.url)),
        github: fileURLToPath(new URL('./github/index.html', import.meta.url)),
        ai: fileURLToPath(new URL('./ai/index.html', import.meta.url)),
        extensions: fileURLToPath(new URL('./extensions/index.html', import.meta.url)),
        runner: fileURLToPath(new URL('./runner/index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy/index.html', import.meta.url)),
        get_started: fileURLToPath(new URL('./get-started/index.html', import.meta.url)),
        mission: fileURLToPath(new URL('./mission/index.html', import.meta.url)),
        about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
        roadmap: fileURLToPath(new URL('./roadmap/index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app/index.html', import.meta.url))
      }
    }
  },
  worker: { format: 'es' },
  plugins: [loadVscodeCssAsString, siteTemplate(fileURLToPath(new URL('.', import.meta.url))), gallery()],
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
