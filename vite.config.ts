import { defineConfig, type Plugin } from 'vite'

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
const crossOriginIsolation: Plugin = {
  name: 'cross-origin-isolation-headers',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      next()
    })
  }
}

export default defineConfig({
  build: { target: 'esnext', chunkSizeWarningLimit: 100000 },
  worker: { format: 'es' },
  plugins: [loadVscodeCssAsString, crossOriginIsolation],
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
