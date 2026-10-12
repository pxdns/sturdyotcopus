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
import '@codingame/monaco-vscode-configuration-editing-default-extension'
import '@codingame/monaco-vscode-emmet-default-extension'
// Language features (run in web workers)
import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-markdown-language-features-default-extension'

import { registerBuiltinExtensions } from './extensions'
import { getHostColorSchemeServiceOverride } from './hostColorScheme'
import { setupWorkspace, WORKSPACE_ROOT } from './workspace'

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

  // Open VSX themes + the local Glass theme, registered before the workbench starts.
  await registerBuiltinExtensions()

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
      workspace: { folderUri: WORKSPACE_ROOT }
    },
    defaultLayout: {
      editors: [
        { uri: WORKSPACE_ROOT.with({ path: '/workspace/README.md' }), viewColumn: 1 },
        { uri: WORKSPACE_ROOT.with({ path: '/workspace/src/Program.cs' }), viewColumn: 2 }
      ],
      layout: { editors: { orientation: 0, groups: [{ size: 1 }, { size: 1 }] } }
    },
    configurationDefaults: {
      'workbench.colorTheme': 'Glass Dark',
      'window.autoDetectColorScheme': true,
      'workbench.preferredDarkColorTheme': 'Glass Dark',
      'workbench.preferredLightColorTheme': 'Glass Light',
      'editor.semanticHighlighting.enabled': true,
      'editor.fontSize': 14,
      'editor.minimap.enabled': true,
      'files.autoSave': 'afterDelay',
      'telemetry.telemetryLevel': 'off',
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
      'update.mode': 'none',
      'workbench.startupEditor': 'none',
      'window.title': 'Web VS Code${separator}${dirty}${activeEditorShort}'
    },
    productConfiguration: {
      nameShort: 'Web VS Code',
      nameLong: 'Web VS Code',
      // Extensions come from Open VSX, not the Microsoft Marketplace
      extensionsGallery: {
        serviceUrl: 'https://open-vsx.org/vscode/gallery',
        resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
        extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
        controlUrl: '',
        nlsBaseUrl: ''
      }
    }
  }

  await initialize(
    {
      ...getLogServiceOverride(),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
      ...getExtensionGalleryServiceOverride({ webOnly: true }),
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
}

/** Mirror the workbench theme kind (vs-dark | vs | hc-*) on <html> so glass.css can switch gradients. */
function syncThemeKind(): void {
  const update = (el: Element): void => {
    const cl = el.classList
    const kind = cl.contains('hc-black') || cl.contains('hc-light') ? 'hc' : cl.contains('vs-dark') ? 'dark' : 'light'
    document.documentElement.dataset.themeKind = kind
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
