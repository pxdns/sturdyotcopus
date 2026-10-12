import type * as vscode from 'vscode'
import { listUploaded, MAX_TOTAL_MB, parseUpload, removeUploaded, saveUploaded, totalUploadedBytes } from '../uploaded-extensions'

type Vscode = typeof vscode

function pickFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.vsix,.json,.jsonc'
    input.style.display = 'none'
    input.onchange = () => { resolve(input.files?.[0]); input.remove() }
    input.oncancel = () => { resolve(undefined); input.remove() }
    document.body.appendChild(input)
    input.click()
  })
}

const reloadPrompt = async (vs: Vscode, message: string): Promise<void> => {
  const pick = await vs.window.showInformationMessage(message, 'Reload now', 'Later')
  if (pick === 'Reload now') location.reload()
}

export function activateUploads(vs: Vscode): void {
  vs.commands.registerCommand('luma.extensions.upload', async () => {
    const file = await pickFile()
    if (!file) return
    try {
      const ext = await parseUpload(file)
      const used = (await totalUploadedBytes()) + ext.size
      if (used > MAX_TOTAL_MB * 1024 * 1024) throw new Error(`Uploaded extensions are limited to ${MAX_TOTAL_MB} MB in total. Remove some first.`)
      await saveUploaded(ext)
      await reloadPrompt(vs, `Saved "${ext.label}" in this browser. Reload to start using it, then pick it under Preferences: Color Theme (for themes).`)
    } catch (e) {
      void vs.window.showErrorMessage(`Could not add the file: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  vs.commands.registerCommand('luma.extensions.manageUploaded', async () => {
    const list = await listUploaded()
    if (!list.length) { void vs.window.showInformationMessage('Nothing uploaded yet. Run "Extensions: Add Theme or Extension from File".'); return }
    const picks = await vs.window.showQuickPick(
      list.map((e) => ({ label: e.label, description: `${e.id} ${e.version}`, detail: `${e.kind === 'theme' ? 'Theme file' : 'Package'}, ${(e.size / 1024).toFixed(0)} KB`, id: e.id })),
      { canPickMany: true, title: 'Remove uploaded extensions', placeHolder: 'Tick the ones to remove' }
    )
    if (!picks?.length) return
    for (const p of picks) await removeUploaded(p.id)
    await reloadPrompt(vs, `Removed ${picks.length}. Reload to finish.`)
  })
}
