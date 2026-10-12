// Model providers called straight from the browser with the user's own key. Nothing goes through our server.
export type Provider = 'anthropic' | 'openai'

export interface ToolDef { name: string; description: string; schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[] }
  | { role: 'tool'; results: { id: string; name: string; content: string }[] }

export interface ProviderConfig { provider: Provider; apiKey: string; model: string; baseUrl: string }

export interface StreamHandlers { onText(delta: string): void }
export interface Turn { text: string; calls: ToolCall[]; stop: string }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

async function* sse(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error('The response has no body.')
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd()
      buf = buf.slice(i + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

async function failure(res: Response): Promise<Error> {
  let detail = ''
  try {
    const j = await res.json()
    detail = j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 300)
  } catch { /* not JSON */ }
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key (AI: Set API Key).' : ''
  return new Error(`${res.status} ${res.statusText}${detail ? ': ' + detail : ''}.${hint}`)
}

function parseArgs(s: string): Record<string, unknown> {
  try { return s ? (JSON.parse(s) as Record<string, unknown>) : {} } catch { return {} }
}

export async function streamTurn(cfg: ProviderConfig, system: string, messages: Msg[], tools: ToolDef[], h: StreamHandlers, signal: AbortSignal): Promise<Turn> {
  return cfg.provider === 'anthropic' ? anthropicTurn(cfg, system, messages, tools, h, signal) : openaiTurn(cfg, system, messages, tools, h, signal)
}

async function anthropicTurn(cfg: ProviderConfig, system: string, messages: Msg[], tools: ToolDef[], h: StreamHandlers, signal: AbortSignal): Promise<Turn> {
  const wire = messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text }
    if (m.role === 'assistant') {
      const content: unknown[] = []
      if (m.text) content.push({ type: 'text', text: m.text })
      for (const c of m.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      return { role: 'assistant', content }
    }
    return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) }
  })
  const res = await fetch(cfg.baseUrl || ANTHROPIC_URL, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: cfg.model, max_tokens: 4096, system, messages: wire, stream: true, ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}) })
  })
  if (!res.ok) throw await failure(res)
  const turn: Turn = { text: '', calls: [], stop: '' }
  const partial = new Map<number, { id: string; name: string; json: string }>()
  for await (const data of sse(res)) {
    let e: { type: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string }; error?: { message: string } }
    try { e = JSON.parse(data) } catch { continue }
    if (e.type === 'error') throw new Error(e.error?.message ?? 'The model reported an error.')
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') partial.set(e.index ?? 0, { id: e.content_block.id ?? '', name: e.content_block.name ?? '', json: '' })
    else if (e.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta' && e.delta.text) { turn.text += e.delta.text; h.onText(e.delta.text) }
      else if (e.delta?.type === 'input_json_delta') { const p = partial.get(e.index ?? 0); if (p) p.json += e.delta.partial_json ?? '' }
    } else if (e.type === 'message_delta' && e.delta?.stop_reason) turn.stop = e.delta.stop_reason
  }
  for (const p of partial.values()) turn.calls.push({ id: p.id, name: p.name, args: parseArgs(p.json) })
  return turn
}

async function openaiTurn(cfg: ProviderConfig, system: string, messages: Msg[], tools: ToolDef[], h: StreamHandlers, signal: AbortSignal): Promise<Turn> {
  const wire: unknown[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') wire.push({ role: 'user', content: m.text })
    else if (m.role === 'assistant') wire.push({ role: 'assistant', content: m.text || null, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) })
    else for (const r of m.results) wire.push({ role: 'tool', tool_call_id: r.id, content: r.content })
  }
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages: wire, stream: true, ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}) })
  })
  if (!res.ok) throw await failure(res)
  const turn: Turn = { text: '', calls: [], stop: '' }
  const partial = new Map<number, { id: string; name: string; json: string }>()
  for await (const data of sse(res)) {
    if (data === '[DONE]') break
    let e: { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]; error?: { message: string } }
    try { e = JSON.parse(data) } catch { continue }
    if (e.error) throw new Error(e.error.message)
    const c = e.choices?.[0]
    if (!c) continue
    if (c.delta?.content) { turn.text += c.delta.content; h.onText(c.delta.content) }
    for (const t of c.delta?.tool_calls ?? []) {
      const p = partial.get(t.index) ?? { id: '', name: '', json: '' }
      if (t.id) p.id = t.id
      if (t.function?.name) p.name += t.function.name
      if (t.function?.arguments) p.json += t.function.arguments
      partial.set(t.index, p)
    }
    if (c.finish_reason) turn.stop = c.finish_reason
  }
  for (const p of partial.values()) turn.calls.push({ id: p.id || `call_${turn.calls.length}`, name: p.name, args: parseArgs(p.json) })
  return turn
}

/** One short, non-streaming completion (used for inline suggestions). */
export async function complete(cfg: ProviderConfig, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  const t = await streamTurn({ ...cfg }, system, [{ role: 'user', text: prompt }], [], { onText() {} }, signal)
  return t.text
}
