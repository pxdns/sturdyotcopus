# Web VS Code

A browser-based VS Code (think vscode.dev) built as a static Vite + TypeScript site on top of
[`@codingame/monaco-vscode-api`](https://github.com/CodinGame/monaco-vscode-api). It runs the full VS Code
workbench (explorer, tabs, command palette, settings, extensions view, search, problems/output panels) entirely
in the browser. No server, no analytics, no telemetry, no third-party scripts.

* **Themes** – a local **Glass Dark / Glass Light** theme plus themes downloaded from [Open VSX](https://open-vsx.org) at build time.
* **Extensions** – the Extensions view searches **Open VSX** (not the Microsoft Marketplace). Only web-compatible extensions can be installed.
* **Files** – an in-browser virtual file system (a small sample workspace) persisted in **IndexedDB**.
* **Languages** – JS/TS, JSON, CSS, HTML, Markdown, C# grammars, with the TS/CSS/HTML/JSON language features running in web workers.

## Deploy to Vercel

Push this repo to GitHub and import it in Vercel. `vercel.json` already contains the settings below; check them
in **Project → Settings** if the build doesn't pick them up:

| Setting | Value |
| --- | --- |
| Framework Preset | **Vite** |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` (default) |
| Node.js Version | **22.x** (anything ≥ 20.19 works; Vite 8 needs it) |
| Environment Variables | none required |
| Root Directory | repository root |

`vercel.json` also sets `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`
and `Cross-Origin-Resource-Policy: cross-origin` on every response (needed for `SharedArrayBuffer`, used by the
language-feature workers; `credentialless` still lets the app call Open VSX), long-lived caching for `/assets/*`,
and an SPA rewrite to `/index.html`.

The build needs outbound internet access to `open-vsx.org` (Vercel builds have it). If Open VSX is unreachable
the build still succeeds; the failed extensions are logged and skipped.

## How it works

```
extensions.json ──► scripts/fetch-extensions.mjs ──► public/extensions/<publisher>.<name>/…   (gitignored)
extensions-local/* ─────────────┘                    public/extensions/manifest.json
                                                          │
src/main.ts ── src/extensions.ts reads manifest.json and registers every extension as a built-in ◄┘
```

* `npm run build` / `npm run dev` first run `scripts/fetch-extensions.mjs` (`prebuild` / `predev`). For each ID in
  `extensions.json` it calls `https://open-vsx.org/api/<publisher>/<name>`, downloads the `.vsix`, unzips it into
  `public/extensions/<publisher>.<name>/`, and logs (never throws on) failures. Already-downloaded extensions are
  skipped locally; pass `--force` to refresh (`node scripts/fetch-extensions.mjs --force`).
* Everything in `extensions-local/` is copied into `public/extensions/` as well, so local extensions ship too.
* The script writes `public/extensions/manifest.json` (id, `package.json`, file list). `src/extensions.ts`
  registers each entry as a built-in extension **before** the workbench starts, so themes are there on first paint.
* Extensions that only provide Node (`main`) code can't run in a browser: their declarative contributions (themes,
  grammars, snippets) are kept and the Node entry point is dropped.

## Add more themes

1. Find the extension on <https://open-vsx.org> and take its ID (`publisher.name`, from the URL
   `open-vsx.org/extension/<publisher>/<name>`).
2. Add the ID to `extensions.json`:

   ```json
   [
     "dracula-theme.theme-dracula",
     "zhuangtongfa.material-theme",
     "github.github-vscode-theme",
     "catppuccin.catppuccin-vsc",
     "enkia.tokyo-night",
     "your-publisher.your-theme"
   ]
   ```
3. Commit and push. Vercel rebuilds, downloads the extension, and it shows up under
   **Preferences: Color Theme** (`Ctrl/Cmd+K Ctrl/Cmd+T`).

Visitors can also install extensions themselves from the Extensions view; those live in their browser only.

## Glass theme

`extensions-local/glass-theme/` contributes **Glass Dark** (`vs-dark`, based on Dark+) and **Glass Light** (`vs`, based on
Light+). Surfaces use translucent 8-digit hex colours, widgets are ~88% opaque, borders are 1px 10% white/black, and
the syntax palette matches Visual Studio C# 2017 / Dark+ / Light+ (also applied to TS, JS, JSON, HTML, CSS).

`src/glass.css` adds the page gradient, `backdrop-filter` blur, transparency fixes and rounded widgets, with an
opaque fallback via `@supports not (backdrop-filter: blur(1px))`.

The defaults (set in `src/main.ts`) follow the OS: `window.autoDetectColorScheme` with
`workbench.preferredDarkColorTheme = "Glass Dark"` and `workbench.preferredLightColorTheme = "Glass Light"`.
Users can pick any theme afterwards; their choice is stored in their browser.

## Local development

```bash
npm install
npm run dev        # fetches extensions, then starts Vite on :5173
npm run build      # fetches extensions, then builds to dist/
npm run preview    # serve dist/ (add COOP/COEP headers yourself; vercel.json does this in production)
npm run typecheck
```

## Notes

* Package versions of all `@codingame/monaco-vscode-*` packages are pinned to the same exact version (`37.3.11`),
  as the packages must match each other. `monaco-editor` and `vscode` are npm aliases to
  `@codingame/monaco-vscode-editor-api` and `@codingame/monaco-vscode-extension-api`, as in the official demo.
* The terminal is not included (there is no backend to run a shell).
* Telemetry is off (`telemetry.telemetryLevel: "off"`, no telemetry service), and no request is made at startup
  to any host other than your own. The Extensions view contacts `open-vsx.org` only when used.
