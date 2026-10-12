import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { IHostColorSchemeService } from '@codingame/monaco-vscode-api/services'

/**
 * Feeds the OS light/dark preference to the workbench theme service so that
 * "window.autoDetectColorScheme" can switch between the preferred dark/light themes.
 */
class MediaQueryHostColorSchemeService {
  private readonly dark$ = window.matchMedia('(prefers-color-scheme: dark)')
  private readonly contrast$ = window.matchMedia('(prefers-contrast: more)')
  private readonly emitter = new Emitter<void>()
  readonly onDidChangeColorScheme = this.emitter.event

  constructor() {
    this.dark$.addEventListener('change', () => this.emitter.fire())
    this.contrast$.addEventListener('change', () => this.emitter.fire())
  }

  get dark(): boolean {
    return this.dark$.matches
  }

  get highContrast(): boolean {
    return this.contrast$.matches
  }
}

export function getHostColorSchemeServiceOverride() {
  return { [IHostColorSchemeService.toString()]: new MediaQueryHostColorSchemeService() }
}
