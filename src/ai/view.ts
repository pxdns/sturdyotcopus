/** HTML for the assistant panel. It runs in a sandboxed webview and talks to the extension code with postMessage. */
export function chatHtml(nonce: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;font:13px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background)}
  #log{flex:1;overflow-y:auto;padding:10px 12px}
  .msg{margin:0 0 14px}
  .who{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin-bottom:3px}
  .body{white-space:pre-wrap;word-wrap:break-word}
  .body code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:0 3px;border-radius:2px}
  pre{margin:6px 0;padding:8px;overflow-x:auto;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border,transparent);border-radius:2px;position:relative}
  pre code{background:none;padding:0;white-space:pre}
  pre button{position:absolute;top:4px;right:4px}
  .tool{border-left:2px solid var(--vscode-focusBorder);padding:4px 8px;margin:0 0 10px;color:var(--vscode-descriptionForeground);font-size:12px}
  .tool b{color:var(--vscode-foreground)}
  .tool .row{display:flex;gap:6px;margin-top:6px}
  .err{color:var(--vscode-errorForeground)}
  .note{color:var(--vscode-descriptionForeground)}
  #bar{border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border));padding:8px 10px;display:flex;flex-direction:column;gap:6px}
  #opts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:12px}
  select,textarea,button,input{font:inherit}
  select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:1px 4px}
  textarea{width:100%;box-sizing:border-box;min-height:56px;max-height:200px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:6px}
  textarea:focus,select:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder)}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:3px 10px;cursor:pointer}
  button:hover{background:var(--vscode-button-hoverBackground)}
  button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  #send{align-self:flex-end}
  #empty{padding:14px 12px;color:var(--vscode-descriptionForeground)}
  #empty h3{margin:0 0 6px;color:var(--vscode-foreground);font-size:13px}
</style></head>
<body>
<div id="log"><div id="empty"></div></div>
<div id="bar">
  <div id="opts">
    <label>Mode <select id="mode"><option value="chat">Chat</option><option value="agent">Agent</option></select></label>
    <label><input type="checkbox" id="ctx" checked> Current file</label>
    <button class="sec" id="clear" title="Start a new conversation">New chat</button>
    <button class="sec" id="key" title="Set the API key">Key</button>
  </div>
  <textarea id="in" placeholder="Ask about your code. Enter sends, Shift+Enter adds a line." aria-label="Message"></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${nonce}">
(function(){
  const vs = acquireVsCodeApi()
  const log = document.getElementById('log'), input = document.getElementById('in'), send = document.getElementById('send'), empty = document.getElementById('empty')
  let busy = false, cur = null, curText = ''
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
  function md(src){
    const parts = src.split(/\`\`\`/)
    return parts.map((p, i) => {
      if (i % 2) { const nl = p.indexOf('\\n'); const code = nl >= 0 ? p.slice(nl + 1) : p; return '<pre><button class="sec" data-copy>Copy</button><code>' + esc(code.replace(/\\n$/, '')) + '</code></pre>' }
      return esc(p).replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>')
    }).join('')
  }
  function scroll(){ log.scrollTop = log.scrollHeight }
  function add(cls, who, html){ empty.style.display = 'none'; const d = document.createElement('div'); d.className = cls; if (who) d.innerHTML = '<div class="who">' + who + '</div><div class="body">' + html + '</div>'; else d.innerHTML = html; log.appendChild(d); scroll(); return d }
  function setBusy(b){ busy = b; send.textContent = b ? 'Stop' : 'Send'; input.disabled = false }
  function go(){
    if (busy) { vs.postMessage({ type: 'stop' }); return }
    const text = input.value.trim(); if (!text) return
    input.value = ''
    vs.postMessage({ type: 'send', text, mode: document.getElementById('mode').value, withFile: document.getElementById('ctx').checked })
  }
  send.onclick = go
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go() } })
  document.getElementById('clear').onclick = () => { vs.postMessage({ type: 'clear' }) }
  document.getElementById('key').onclick = () => { vs.postMessage({ type: 'setKey' }) }
  log.addEventListener('click', (e) => {
    const t = e.target
    if (t.dataset && t.dataset.copy !== undefined) vs.postMessage({ type: 'copy', text: t.parentElement.querySelector('code').textContent })
    if (t.dataset && t.dataset.approve) { vs.postMessage({ type: 'approval', id: t.dataset.approve, ok: t.dataset.ok === '1' }); t.parentElement.remove() }
  })
  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (m.type === 'init') { empty.innerHTML = m.empty; document.getElementById('mode').value = m.mode }
    else if (m.type === 'user') { cur = null; add('msg', 'You', esc(m.text)) }
    else if (m.type === 'start') { setBusy(true); cur = add('msg', 'Assistant', ''); curText = '' }
    else if (m.type === 'text') { if (!cur) { cur = add('msg', 'Assistant', ''); curText = '' } curText += m.text; cur.querySelector('.body').innerHTML = md(curText); scroll() }
    else if (m.type === 'turn-end') { cur = null }
    else if (m.type === 'tool') { cur = null; add('tool', '', '<b>' + esc(m.name) + '</b> ' + esc(m.summary)) }
    else if (m.type === 'approve') { cur = null; add('tool', '', '<b>' + esc(m.name) + '</b> wants to ' + esc(m.summary) + '<div class="row"><button data-approve="' + m.id + '" data-ok="1">Allow</button><button class="sec" data-approve="' + m.id + '" data-ok="0">Deny</button></div>') }
    else if (m.type === 'error') { cur = null; add('msg err', '', esc(m.text)) }
    else if (m.type === 'note') { cur = null; add('msg note', '', esc(m.text)) }
    else if (m.type === 'done') { setBusy(false); cur = null }
    else if (m.type === 'cleared') { log.querySelectorAll('.msg,.tool').forEach((n) => n.remove()); empty.style.display = ''; cur = null }
    else if (m.type === 'prefill') { input.value = m.text; input.focus() }
  })
  vs.postMessage({ type: 'ready' })
})()
</script></body></html>`
}
