import type * as vscode from 'vscode'
import { createBranch, getRepo, listBranches, listRepos } from '../github/api'
import { getSession, onDidChangeSession, signIn, signOut } from '../github/auth'
import type { Checkout, SyncStatus } from '../github/checkout'
import { saveDescriptor } from '../github/workspace'

type Vscode = typeof vscode

export function activateGithub(vs: Vscode, checkout: Checkout | undefined, problems: string[]): void {
  // ----- account status item
  const account = vs.window.createStatusBarItem('luma.github', vs.StatusBarAlignment.Left, 100)
  account.name = 'GitHub account'
  const renderAccount = (): void => {
    const s = getSession()
    account.text = s ? `$(mark-github) ${s.login}` : '$(mark-github) Sign in'
    account.tooltip = s ? `Signed in to GitHub as ${s.login}. Click to sign out.` : 'Sign in with GitHub'
    account.command = s ? 'luma.github.signOut' : 'luma.github.signIn'
    account.show()
  }
  renderAccount()
  onDidChangeSession(renderAccount)

  // ----- sync status item
  const sync = vs.window.createStatusBarItem('luma.github.sync', vs.StatusBarAlignment.Left, 99)
  sync.name = 'GitHub sync'
  const renderSync = (st: SyncStatus): void => {
    if (!checkout) return sync.hide()
    const label = `${checkout.owner}/${checkout.repo}@${checkout.ref}`
    switch (st.state) {
      case 'synced': sync.text = '$(check) Synced'; sync.tooltip = `${label}: everything is on GitHub`; break
      case 'pending': sync.text = `$(cloud-upload) ${st.pending} unsynced`; sync.tooltip = `${label}: changes will be committed automatically. Click to sync now.`; break
      case 'syncing': sync.text = '$(sync~spin) Syncing'; sync.tooltip = `${label}: committing to GitHub`; break
      case 'error': sync.text = '$(warning) Sync problem'; sync.tooltip = st.message ?? 'Sync failed. Click for details.'; break
    }
    sync.command = 'luma.github.syncNow'
    sync.show()
  }
  if (checkout) {
    checkout.onStatus = renderSync
    checkout.onNotice = (m, level) => void (level === 'warn' ? vs.window.showWarningMessage(m) : vs.window.showInformationMessage(m))
    checkout.syncDelayMs = () => vs.workspace.getConfiguration('luma.github').get<number>('syncDelaySeconds', 10) * 1000
    renderSync({ state: checkout.pending ? 'pending' : 'synced', pending: checkout.pending })
    // pick up anything that changed upstream (and drop edits that already reached GitHub, e.g. from a tab that was closing)
    void checkout.reconcile().then(() => checkout.sync()).catch(() => {})
  }
  for (const p of problems) void vs.window.showWarningMessage(p)

  const reopen = async (descriptor: { kind: 'local' } | { kind: 'github'; owner: string; repo: string; ref: string }): Promise<void> => {
    if (checkout) await checkout.sync().catch(() => {})
    if (checkout?.hasPending) {
      const choice = await vs.window.showWarningMessage('Some changes could not be synced yet. Switching now keeps them on this device until you return to this repository.', { modal: true }, 'Switch anyway')
      if (choice !== 'Switch anyway') return
    }
    saveDescriptor(descriptor)
    const url = new URL(location.href)
    url.searchParams.delete('github')
    location.assign(url.toString())
  }

  vs.commands.registerCommand('luma.github.signIn', async () => {
    try {
      const s = await signIn()
      void vs.window.showInformationMessage(`Signed in to GitHub as ${s.login}.`)
    } catch (e) {
      void vs.window.showWarningMessage(e instanceof Error ? e.message : String(e))
    }
  })
  vs.commands.registerCommand('luma.github.signOut', async () => {
    const choice = await vs.window.showInformationMessage('Sign out of GitHub in this browser?', 'Sign out')
    if (choice === 'Sign out') signOut()
  })

  vs.commands.registerCommand('luma.github.openRepository', async () => {
    if (!getSession()) {
      try { await signIn() } catch (e) { return void vs.window.showWarningMessage(e instanceof Error ? e.message : String(e)) }
    }
    try {
      const manual = '$(edit) Enter owner/repo...'
      const repos = await listRepos()
      const pick = await vs.window.showQuickPick(
        [{ label: manual, alwaysShow: true }, ...repos.map((r) => ({ label: r.fullName, description: r.private ? 'private' : 'public' }))],
        { placeHolder: 'Choose a repository to open', matchOnDescription: true }
      )
      if (!pick) return
      let full = pick.label
      if (full === manual) {
        const typed = await vs.window.showInputBox({ prompt: 'Repository', placeHolder: 'owner/repo', validateInput: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? undefined : 'Use the form owner/repo') })
        if (!typed) return
        full = typed
      }
      const [owner, repo] = full.split('/') as [string, string]
      const info = await getRepo(owner, repo)
      const branches = await listBranches(owner, repo)
      const ordered = [info.defaultBranch, ...branches.filter((b) => b !== info.defaultBranch)]
      const ref = ordered.length === 1 ? ordered[0] : (await vs.window.showQuickPick(ordered.map((b) => ({ label: b, description: b === info.defaultBranch ? 'default' : '' })), { placeHolder: 'Choose a branch' }))?.label
      if (!ref) return
      await reopen({ kind: 'github', owner: info.owner, repo: info.name, ref })
    } catch (e) {
      void vs.window.showErrorMessage(`Could not open the repository: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  vs.commands.registerCommand('luma.github.closeRepository', () => reopen({ kind: 'local' }))

  vs.commands.registerCommand('luma.github.syncNow', async () => {
    if (!checkout) return void vs.window.showInformationMessage('Open a GitHub repository first (GitHub: Open Repository).')
    checkout.resume()
    await checkout.sync()
    const st = checkout.pending
    void (st ? vs.window.showWarningMessage(`${st} change(s) are still waiting to sync.`) : vs.window.showInformationMessage('Everything is synced to GitHub.'))
  })

  vs.commands.registerCommand('luma.github.createBranch', async () => {
    if (!checkout) return void vs.window.showInformationMessage('Open a GitHub repository first.')
    const name = await vs.window.showInputBox({ prompt: `New branch from ${checkout.ref}`, placeHolder: 'feature/my-change', validateInput: (v) => (/^[\w./-]{1,100}$/.test(v) ? undefined : 'Use letters, numbers, / . _ -') })
    if (!name) return
    try {
      await checkout.sync()
      await createBranch(checkout.owner, checkout.repo, name, checkout.baseOid)
      await reopen({ kind: 'github', owner: checkout.owner, repo: checkout.repo, ref: name })
    } catch (e) {
      void vs.window.showErrorMessage(`Could not create the branch: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
