// Launch modes and PWA install for the marketing pages.
const IDE_URL = '/app/'

function launchPopup() {
  const w = Math.min(1400, screen.availWidth - 80)
  const h = Math.min(900, screen.availHeight - 80)
  const left = Math.max(0, Math.round((screen.availWidth - w) / 2))
  const top = Math.max(0, Math.round((screen.availHeight - h) / 2))
  const win = window.open(`${IDE_URL}?mode=popup`, 'luma-ide', `popup=yes,width=${w},height=${h},left=${left},top=${top}`)
  if (!win) alert('Your browser blocked the popup. Allow popups for this site and try again.')
}

/** Opens a blank window and hosts the IDE in a full-window frame; the address bar stays on about:blank. */
function launchBlank() {
  const win = window.open('about:blank', '_blank')
  if (!win) return alert('Your browser blocked the new window. Allow popups for this site and try again.')
  const doc = win.document
  doc.title = 'Luma IDE'
  doc.body.style.cssText = 'margin:0;height:100vh;overflow:hidden;background:#1b1b19'
  const frame = doc.createElement('iframe')
  frame.src = new URL(`${IDE_URL}?mode=blank`, location.href).href
  frame.setAttribute('allow', 'cross-origin-isolated; clipboard-read; clipboard-write; fullscreen')
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0'
  doc.body.appendChild(frame)
}

document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-launch]') : null
  if (!el) return
  const mode = el.getAttribute('data-launch')
  if (mode === 'popup') { e.preventDefault(); launchPopup() }
  else if (mode === 'blank') { e.preventDefault(); launchBlank() }
})

const here = location.pathname.replace(/\/+$/, '') || '/'
document.querySelectorAll('.masthead nav a:not(.btn)').forEach((a) => {
  if ((new URL(a.href).pathname.replace(/\/+$/, '') || '/') === here) a.setAttribute('aria-current', 'page')
})

let deferredPrompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredPrompt = e
  document.querySelectorAll('[data-install]').forEach((b) => b.removeAttribute('hidden'))
})
document.querySelectorAll('[data-install]').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    deferredPrompt = undefined
    b.setAttribute('hidden', '')
  })
)
