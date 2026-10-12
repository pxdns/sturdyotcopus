# Luma IDE

A desktop-class code editor that runs in a browser tab: the full VS Code workbench
([`@codingame/monaco-vscode-api`](https://github.com/CodinGame/monaco-vscode-api)) plus Python that runs in the page, Java and
Gradle tooling, GitHub sign-in with automatic commits, an AI assistant that uses your own key, a self-hosted extension
marketplace and an optional remote runner for real terminals. No ads, no analytics, no telemetry, no third-party scripts.

* **Site** – the promotional pages are static HTML in the repo root (`index.html`, `features/`, `python/`, `java-gradle/`, `github/`, `ai/`, `extensions/`, `runner/`, `privacy/`, `get-started/`, `mission/`, `about/`, `roadmap/`). Shared header/footer live in `site/partials/`, status badges in `site.config.json`.
* **IDE** – served at `/app/` (new tab, popup window, an `about:blank` host window, or install as a PWA from the site).
* **Themes** – *Luma Charcoal* and *Luma Paper* (flat, charcoal and light grey) follow the OS light/dark setting; *Glass Dark/Light* are optional.
* **Shell** – the default terminal is a bash-like shell that runs in the page on your workspace files (`ls cd cat grep find tree cp mv rm mkdir`, pipes, redirects, `&&`, globs, `python file.py` with `input()` typed in the terminal). It is not real bash and has no git, npm or JDK; those live in the Remote runner terminal.
* **Python** – Pyodide, self-hosted, in a worker: run files, `input()`, stop, a REPL terminal, live syntax errors, outline, completion and hover.
* **Java and Gradle** – parser-based syntax errors, outline, snippets and completion for Java; outline, snippets and inspections for `build.gradle`; *Gradle: Run Task* runs in the remote runner. A browser tab cannot compile or run Java.
* **GitHub** – OAuth sign-in (no personal access tokens), *GitHub: Open Repository*, the last repository and open files restored on the next visit, edits committed to the branch as one atomic commit a few seconds after you stop typing and again when the tab is hidden or closing. Conflicts go to a side branch; nothing is overwritten.
* **AI assistant** – chat and agent mode (list/find/read files, write files with your approval) in a side panel. The panel sits on the right, like Copilot Chat. Providers: GitHub Models (default; uses your GitHub sign-in or a `models:read` token), Anthropic, and any OpenAI-compatible endpoint, called straight from the browser (keys are kept in `localStorage`). Inline suggestions are off by default. It is not GitHub Copilot and does not use a Copilot subscription.
* **Your own themes** – *Extensions: Add Theme or Extension from File* takes a `.vsix` or a VS Code color theme `.json`, stores it in IndexedDB and registers it at every start. Only themes, grammars, snippets and keybindings are used; uploaded code is never run.
* **Extensions** – the Extensions view is backed by our own gallery API serving a curated mirror of web-compatible Open VSX extensions.
* **Remote runner** – `runner/`: a small Node server (WebSocket + pty) that gives the IDE a real shell, a JDK, Gradle and Node. Closed by default; see `runner/README.md`.

## Environment variables (Vercel)

| Name | Required | Purpose |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | for GitHub sign-in | Client ID of your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | for GitHub sign-in | Client secret. **Only ever set it here, never commit it.** |
| `GITHUB_ALLOWED_ORG` | optional | Only members of this organization can sign in |

The OAuth App's authorization callback URL is `https://<your-domain>/api/auth/github/callback`. Access tokens go straight to the
browser and are never stored on the server. If a client secret was ever pasted into a chat, an issue or a commit, regenerate it in
the OAuth App settings.

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
| Environment Variables | see above (optional; the IDE works without them) |
| Root Directory | repository root |

`vercel.json` also sets `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`
and `Cross-Origin-Resource-Policy: cross-origin` on every response (needed for `SharedArrayBuffer`, used by the
language-feature workers), long-lived caching for `/assets/*`,
and the rewrites for the gallery API. There is no SPA fallback: each site page is its own HTML file.

The build needs outbound internet access to `open-vsx.org` (Vercel builds have it). If Open VSX is unreachable
the build still succeeds; the failed extensions are logged and skipped, and the Extensions view is simply empty.

`vercel.json` also routes `/api/gallery/*` to the serverless function `api/gallery.js` (see *Extension marketplace*).

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

## Extension marketplace (custom gallery API)

The Extensions view does not talk to Open VSX or the Microsoft Marketplace at runtime. It talks to this site:

```
build:   Open VSX search ─► scripts/build-catalog.mjs ─► public/gallery/{catalog.json, resources/**, assets/**}   (gitignored)
runtime: workbench ──POST /api/gallery/extensionquery──► api/gallery.js ──reads──► /gallery/catalog.json
         workbench ──GET  /gallery/resources/<publisher>/<name>/<version>/extension/...  (the extension's files)
```

`scripts/build-catalog.mjs` (run by `prebuild`/`predev`, or alone with `npm run catalog`):

1. scans Open VSX by download count (`maxScan` candidates),
2. keeps an extension only if it **can run in a browser**: it ships a `browser` entry point, or it is purely
   declarative (themes, grammars, snippets, ...). Anything with a Node-only `main` entry point is dropped,
3. keeps only extensions with an allowed open-source `license` (`allowedLicenses`),
4. downloads and unzips the newest version of the top `maxExtensions`, within the size/file budgets,
5. drops extensions whose `extensionDependencies` / `extensionPack` members are not in the catalog,
6. writes `catalog.json` and the files the workbench loads.

Tune it in **`catalog.config.json`**: `maxExtensions` (default 300), `maxScan`, `maxExtensionMB`, `maxTotalMB`,
`maxFiles`, `minDownloads`, `allowedLicenses`, `include` (always add these IDs) and `exclude`. The IDs in
`extensions.json` (the preinstalled themes) are always included.

It is deliberately **not** "every extension": Open VSX holds tens of thousands, which would not fit in a repo or a
Vercel deployment, and most of them need Node and cannot run in a browser. Raise `maxExtensions` if you want more,
but watch the build time and the deployment's file count/size.

`api/gallery.js` implements the part of the VS Code gallery protocol the workbench uses (`extensionquery` with
search/category/tag/sort/paging, and `vscode/<publisher>/<name>/latest`). The query logic lives in
`lib/gallery-query.js` and is shared with `vite dev` / `vite preview`, so `npm run dev` and `npm run preview`
behave like production. Because we build the catalog ourselves there are no Marketplace signatures, so signature
verification is switched off in `src/main.ts` (`transformExtensionGalleryManifest`). VS Code still asks users to
trust a publisher before installing.

Please be considerate to Open VSX: the builder uses a modest concurrency, retries with backoff, and identifies
itself with a User-Agent. Each mirrored extension keeps its own license (included in its files).

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

Visitors can also install any extension from the marketplace list in the Extensions view; those live in their browser only.

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
npm run preview    # serve dist/ incl. the gallery API and COOP/COEP headers
npm run catalog    # rebuild only the extension catalog (node scripts/build-catalog.mjs [--force])
npm run typecheck
```

## Tests used during development

The GitHub workspace, runner, Python and AI features were exercised with Playwright against local mock servers (a mock GitHub API with a small in-memory git, a scripted model stream, a local runner). Nothing was run against the real GitHub or provider APIs from the build sandbox, so do a real sign-in and a real commit after deploying.

## Notes

* Package versions of all `@codingame/monaco-vscode-*` packages are pinned to the same exact version (`37.3.11`),
  as the packages must match each other. `monaco-editor` and `vscode` are npm aliases to
  `@codingame/monaco-vscode-editor-api` and `@codingame/monaco-vscode-extension-api`, as in the official demo.
* The built-in terminals are the in-page Luma shell, the Python REPL, and the remote runner (needs a server you run) for real bash.
* Telemetry is off (`telemetry.telemetryLevel: "off"`, no telemetry service). At runtime the app only talks to
  your own origin (including the extension gallery API); `open-vsx.org` is contacted only by the build.
