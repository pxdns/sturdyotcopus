// Copies the Pyodide runtime from node_modules into public/pyodide/ so it is served from our own origin
// (no CDN, no third-party requests at runtime). Never fails the build.
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pyodide')
const to = join(root, 'public', 'pyodide')
const files = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']

try {
  if (!existsSync(from)) throw new Error('pyodide is not installed')
  mkdirSync(to, { recursive: true })
  for (const f of files) cpSync(join(from, f), join(to, f))
  const version = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version
  console.log(`[pyodide] copied ${files.length} files (v${version}) to public/pyodide`)
} catch (e) {
  console.warn('[pyodide] WARN', e.message)
}
