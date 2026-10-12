import './glass.css'

import { initialize, LogLevel, type IWorkbenchConstructionOptions } from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getFilesServiceOverride, { createIndexedDBProviders } from '@codingame/monaco-vscode-files-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationsServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getBannerServiceOverride from '@codingame/monaco-vscode-view-banner-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getWorkspaceTrustServiceOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override'
import getSnippetsServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
import getLanguageDetectionWorkerServiceOverride from '@codingame/monaco-vscode-language-detection-worker-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getUserDataProfileServiceOverride from '@codingame/monaco-vscode-user-data-profile-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'
import getLocalizationServiceOverride from '@codingame/monaco-vscode-localization-service-override'
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getTimelineServiceOverride from '@codingame/monaco-vscode-timeline-service-override'
import getMultiDiffEditorServiceOverride from '@codingame/monaco-vscode-multi-diff-editor-service-override'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import 'vscode/localExtensionHost'

// Default (built-in) language and theme extensions
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-theme-seti-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-css-default-extension'
import '@codingame/monaco-vscode-html-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'
import '@codingame/monaco-vscode-csharp-default-extension'
import '@codingame/monaco-vscode-python-default-extension'
import '@codingame/monaco-vscode-java-default-extension'
import '@codingame/monaco-vscode-groovy-default-extension'
import '@codingame/monaco-vscode-xml-default-extension'
import '@codingame/monaco-vscode-yaml-default-extension'
import '@codingame/monaco-vscode-shellscript-default-extension'
import '@codingame/monaco-vscode-ini-default-extension'
import '@codingame/monaco-vscode-configuration-editing-default-extension'
import '@codingame/monaco-vscode-emmet-default-extension'
// Language features (run in web workers)
import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-markdown-language-features-default-extension'

import { registerBuiltinExtensions } from './extensions'
import { registerUploadedExtensions } from './uploaded-extensions'
import { activateLuma } from './features'
import { lumaManifest } from './features/manifest'
import { LumaTerminalBackend } from './terminal/backend'
import { getHostColorSchemeServiceOverride } from './hostColorScheme'
import { setupWorkspace, WORKSPACE_ROOT } from './workspace'
import { installLifecycleHandlers, prepareGithubWorkspace } from './github/workspace'

// Must be named `Worker`: Vite only bundles worker URLs written as `new Worker(new URL(...))`.
class Worker {
  constructor(
    public url: URL,
    public options?: WorkerOptions
  ) {}
}

const workers: Partial<Record<string, Worker>> = {
  editorWorkerService: new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' }),
  extensionHostWorkerMain: new Worker(new URL('@codingame/monaco-vscode-api/workers/extensionHost.worker', import.meta.url), { type: 'module' }),
  TextMateWorker: new Worker(new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url), { type: 'module' }),
  OutputLinkDetectionWorker: new Worker(new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url), { type: 'module' }),
  LanguageDetectionWorker: new Worker(new URL('@codingame/monaco-vscode-language-detection-worker-service-override/worker', import.meta.url), { type: 'module' }),
  LocalFileSearchWorker: new Worker(new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url), { type: 'module' })
}

window.MonacoEnvironment = {
  getWorkerUrl: (_moduleId: string, label: string) => workers[label]?.url.toString(),
  getWorkerOptions: (_moduleId: string, label: string) => workers[label]?.options
}

async function start(): Promise<void> {
  syncThemeKind()
  // Persistent user data (settings, keybindings, ...) and workspace files, both in IndexedDB.
  await createIndexedDBProviders()
  await setupWorkspace()

  // Reopen the GitHub repository from last time (its working copy is loaded before the workbench starts).
  const problems: string[] = []
  const github = await prepareGithubWorkspace((m) => problems.push(m))

  // Open VSX themes + the local Glass theme, registered before the workbench starts.
  await registerBuiltinExtensions()
  await registerUploadedExtensions()
  // Built-in Luma features (Python, GitHub, Java/Gradle, AI, runner) run in the main thread through the extension API.
  const luma = registerExtension(lumaManifest as never, ExtensionHostKind.LocalProcess)

  const container = document.getElementById('app')
  if (container == null) throw new Error('#app not found')

  const options: IWorkbenchConstructionOptions = {
    developmentOptions: { logLevel: LogLevel.Warning },
    enableWorkspaceTrust: false,
    workspaceProvider: {
      trusted: true,
      async open() {
        return false
      },
      workspace: { folderUri: github?.folderUri ?? WORKSPACE_ROOT }
    },
    defaultLayout: github ? undefined : {
      editors: [
        { uri: WORKSPACE_ROOT.with({ path: '/workspace/README.md' }), viewColumn: 1 },
        { uri: WORKSPACE_ROOT.with({ path: '/workspace/src/Program.cs' }), viewColumn: 2 }
      ],
      layout: { editors: { orientation: 0, groups: [{ size: 1 }, { size: 1 }] } }
    },
    configurationDefaults: {
      'workbench.colorTheme': 'Luma Charcoal',
      'window.autoDetectColorScheme': true,
      'workbench.preferredDarkColorTheme': 'Luma Charcoal',
      'workbench.preferredLightColorTheme': 'Luma Paper',
      'editor.semanticHighlighting.enabled': true,
      'editor.fontSize': 14,
      'editor.minimap.enabled': true,
      'files.autoSave': 'afterDelay',
      'telemetry.telemetryLevel': 'off',
      'terminal.integrated.enablePersistentSessions': false,
      'terminal.integrated.gpuAcceleration': 'off',
      'terminal.integrated.defaultProfile.linux': 'Python',
      'terminal.integrated.defaultProfile.osx': 'Python',
      'terminal.integrated.defaultProfile.windows': 'Python',
      'terminal.integrated.profiles.linux': { Python: { path: 'luma-python' }, 'Remote runner': { path: 'luma-runner' } },
      'terminal.integrated.profiles.osx': { Python: { path: 'luma-python' }, 'Remote runner': { path: 'luma-runner' } },
      'terminal.integrated.profiles.windows': { Python: { path: 'luma-python' }, 'Remote runner': { path: 'luma-runner' } },
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
      'update.mode': 'none',
      'workbench.startupEditor': 'none',
      'window.title': 'Luma IDE${separator}${dirty}${activeEditorShort}'
    },
    productConfiguration: {
      nameShort: 'Luma IDE',
      nameLong: 'Luma IDE',
      // Extensions come from our own gallery API (api/gallery.js), a curated mirror of web-compatible
      // Open VSX extensions built by scripts/build-catalog.mjs - not the Microsoft Marketplace.
      extensionsGallery: {
        serviceUrl: `${window.location.origin}/api/gallery`,
        resourceUrlTemplate: `${window.location.origin}/gallery/resources/{publisher}/{name}/{version}/{path}`,
        extensionUrlTemplate: `${window.location.origin}/api/gallery/vscode/{publisher}/{name}/latest`,
        controlUrl: '',
        nlsBaseUrl: ''
      }
    }
  }

  await initialize(
    {
      ...getLogServiceOverride(),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
      ...getExtensionGalleryServiceOverride({
        webOnly: true,
        // The catalog is built and hosted by us (scripts/build-catalog.mjs), so there are no Marketplace
        // signatures to verify; without this the workbench refuses to install every extension.
        transformExtensionGalleryManifest: (manifest) =>
          manifest == null
            ? null
            : { ...manifest, capabilities: { ...manifest.capabilities, signing: { allPublicRepositorySigned: false } } }
      }),
      ...getFilesServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getModelServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getBannerServiceOverride(),
      ...getStatusBarServiceOverride(),
      ...getTitleBarServiceOverride(),
      ...getOutputServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getWorkspaceTrustServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getOutlineServiceOverride(),
      ...getSnippetsServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getAccessibilityServiceOverride(),
      ...getLanguageDetectionWorkerServiceOverride(),
      ...getStorageServiceOverride(),
      ...getUserDataProfileServiceOverride(),
      ...getSecretStorageServiceOverride(),
      ...getAuthenticationServiceOverride(),
      ...getEmmetServiceOverride(),
      ...getLocalizationServiceOverride({
        async clearLocale() {},
        async setLocale() {},
        availableLanguages: [{ locale: 'en', languageName: 'English' }]
      }),
      ...getTerminalServiceOverride(new LumaTerminalBackend()),
      ...getTimelineServiceOverride(),
      ...getMultiDiffEditorServiceOverride(),
      ...getHostColorSchemeServiceOverride(),
      ...getWorkbenchServiceOverride(),
      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: () => true,
        shouldUseGlobalPicker: () => true
      })
    },
    container,
    options
  )

  const lumaApi = await luma.getApi()
  if (github) installLifecycleHandlers(github.checkout, () => lumaApi.commands.executeCommand('workbench.action.files.saveAll'))
  activateLuma(lumaApi, { checkout: github?.checkout, problems })
}

/** Mirror the workbench theme kind (vs-dark | vs | hc-*) on <html> so glass.css can switch gradients. */
function syncThemeKind(): void {
  const update = (el: Element): void => {
    const cl = el.classList
    const kind = cl.contains('hc-black') || cl.contains('hc-light') ? 'hc' : cl.contains('vs-dark') ? 'dark' : 'light'
    document.documentElement.dataset.themeKind = kind
    // The translucent "glass" chrome (blur, gradient, rounded widgets) only applies to the Glass themes.
    const glass = [...cl].some((c) => c.startsWith('local-glass-theme-themes-glass-'))
    document.documentElement.dataset.ui = glass ? 'glass' : 'flat'
  }
  const attach = (el: Element): void => {
    update(el)
    new MutationObserver(() => update(el)).observe(el, { attributes: true, attributeFilter: ['class'] })
  }
  const existing = document.querySelector('.monaco-workbench')
  if (existing != null) return attach(existing)
  const waiter = new MutationObserver(() => {
    const el = document.querySelector('.monaco-workbench')
    if (el != null) {
      waiter.disconnect()
      attach(el)
    }
  })
  waiter.observe(document.body, { childList: true, subtree: true })
}

start().catch((error) => {
  console.error('Failed to start the workbench', error)
  const app = document.getElementById('app')
  if (app != null) {
    app.textContent = `Failed to start the workbench: ${error instanceof Error ? error.message : String(error)}`
    app.style.cssText = 'color:#f88;font:14px monospace;padding:16px'
  }
})
