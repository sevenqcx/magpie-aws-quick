// OpenAI ⇄ Quick message rendering + model/mode mapping.
// Conversation history travels in text. The application instructions travel
// separately in Quick's per-turn custom_prompt, which the desktop backend
// actually passes to the model.

/** Text content of one content-part object (OpenAI/Anthropic/Responses shapes). */
function partText(p) {
  if (typeof p === 'string') return p
  const t = p?.type
  if (t === 'text' || t === 'input_text' || t === 'output_text') return p.text ?? ''
  if (t === 'image_url' || t === 'input_image' || t === 'image') return '[image]'
  if (t === 'file' || t === 'input_file') return '[file omitted]'
  if (t === 'tool_result') return textOf(p.content) // string or nested parts
  if (t === 'tool_use') {
    const args = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {})
    return `[called tool ${p.name ?? 'tool'}(${args})]`
  }
  return '' // thinking/redacted_thinking/audio/etc carry no user-visible text
}

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join('\n')
  }
  return String(content)
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s

/** One image part as {mimeType, data(base64)} or {url} when it isn't inline data. */
function partImage(p) {
  const t = p?.type
  if (t !== 'image_url' && t !== 'input_image' && t !== 'image') return null
  const src = p.source
  if (src?.type === 'base64' && typeof src.data === 'string') return { mimeType: src.media_type || 'image/png', data: src.data }
  const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? p.url ?? (typeof p.data === 'string' && p.mimeType ? `data:${p.mimeType};base64,${p.data}` : '')
  const m = DATA_URL.exec(String(url ?? ''))
  return m ? { mimeType: m[1], data: m[2].replace(/\s+/g, '') } : { url: String(url ?? '') }
}

/** Images in a message's content, including those nested in tool_result parts. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.flatMap((p) => (p?.type === 'tool_result' ? imagesOf(p.content) : [partImage(p)].filter(Boolean)))
}

const IMAGE_ENTRY_OVERHEAD = 256

// Cloud-upload caps for images too big for the inline frame (per turn).
export const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024
export const MAX_UPLOADS = 4
export const MAX_UPLOAD_TOTAL_BYTES = 5 * 1024 * 1024

const imageExt = (mimeType) => mimeType?.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'img'
const decodedSize = (data) => {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - pad
}

/**
 * Pick images from `messages` for user_message.attachments. Quick counts
 * inline attachment data against the same ~64 KB frame as the text, so only
 * images whose base64 fits `maxBytes` go inline; the rest (and non-inline
 * URLs) are counted in `skipped`. With `{upload:true}` (direct/cloud
 * sessions), inline-data images that don't fit instead queue in `toUpload`
 * for lib/attach.mjs, subject to the upload caps — anything beyond them
 * still lands in `skipped`. Names are numbered across inline + upload.
 */
export function pickImages(messages, maxBytes, { upload = false } = {}) {
  const attachments = []
  const toUpload = []
  let bytes = 0
  let skipped = 0
  let seq = 0
  let uploadCount = 0
  let uploadBytes = 0
  for (const m of messages) {
    for (const img of imagesOf(m.content)) {
      const cost = (img.data?.length ?? Infinity) + IMAGE_ENTRY_OVERHEAD
      if (img.data && bytes + cost <= maxBytes) {
        attachments.push({ type: 'image', name: `image-${++seq}.${imageExt(img.mimeType)}`, size: decodedSize(img.data), mimeType: img.mimeType, data: img.data })
        bytes += cost
        continue
      }
      const decoded = img.data ? decodedSize(img.data) : Infinity
      if (upload && img.data && decoded <= MAX_UPLOAD_IMAGE_BYTES && uploadCount < MAX_UPLOADS && uploadBytes + decoded <= MAX_UPLOAD_TOTAL_BYTES) {
        toUpload.push({ mimeType: img.mimeType, data: img.data, name: `image-${++seq}.${imageExt(img.mimeType)}` })
        uploadCount++
        uploadBytes += decoded
        continue
      }
      skipped++
    }
  }
  return { attachments, bytes, skipped, toUpload }
}

/**
 * Canonical role across client dialects: some agents/gateways emit 'ai',
 * 'human', 'observation' etc. instead of the OpenAI names. Thread-reuse
 * prefix matching and transcript rendering both key off this.
 */
export function canonRole(role) {
  const r = String(role ?? '').toLowerCase()
  if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model' || r === 'assistant_message') return 'assistant'
  if (r === 'user' || r === 'human' || r === 'input') return 'user'
  if (r === 'tool' || r === 'tool_result' || r === 'observation' || r === 'tool_output') return 'tool'
  return r
}

/** Agent modes the desktop client can send as `agent_mode`. */
export const AGENT_MODES = Object.freeze(['fast', 'balanced', 'smart', 'advanced'])

export const MODELS = Object.freeze(
  AGENT_MODES.map((mode) => ({
    id: mode,
    object: 'model',
    created: 0,
    owned_by: 'aws-quick',
    name: { fast: 'Quick Fast', balanced: 'Quick Balanced', smart: 'Quick Smart', advanced: 'Quick Advanced' }[mode],
  })),
)

/** Map a requested model id to an agent_mode; unknown → 'smart'. */
export function modeFor(model) {
  const m = String(model ?? '').trim().toLowerCase()
  const bare = m.includes('/') ? m.split('/').pop() : m
  return AGENT_MODES.includes(bare) ? bare : 'smart'
}

/** thinking_effort levels the client understands (off/low/medium/high/max). */
export const EFFORT_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max'])

/**
 * thinking_effort from the X-Magpie-Effort header or body.reasoning_effort.
 * Returns undefined when unset/invalid (server then uses its default).
 */
export function effortFor(effortHeader, body) {
  const raw = effortHeader ?? body?.reasoning_effort ?? body?.thinking_effort
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (EFFORT_LEVELS.includes(v)) return v
  // magpie/OpenAI spellings → quick levels
  const map = { none: 'off', minimal: 'low', low: 'low', medium: 'medium', med: 'medium', high: 'high', xhigh: 'max', max: 'max' }
  return map[v] ?? (v === 'enabled' || v === 'true' ? 'high' : v === 'disabled' || v === 'false' ? 'off' : undefined)
}

export function renderToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return ''
  return calls
    .map((c) => {
      const name = c?.function?.name ?? c?.name ?? 'tool'
      const args = c?.function?.arguments ?? c?.arguments ?? ''
      return `[called tool ${name}(${typeof args === 'string' ? args : JSON.stringify(args)})]`
    })
    .join('\n')
}

const te = new TextEncoder()
export const byteLen = (s) => te.encode(String(s ?? '')).length

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024
const SYSTEM_CAP = 24 * 1024
const USER_TURN_CAP = 20 * 1024
const TOOL_RESULT_CAP = 16 * 1024
const TRUNC_MARK = '\n…[truncated]'

function fitBytes(s, max, measure = byteLen) {
  if (measure(s) <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(s.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  if (lo && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo--
  return s.slice(0, lo)
}

/** Truncate to a byte budget, appending a marker. */
export function capText(s, maxBytes, measure = byteLen) {
  const str = String(s ?? '')
  if (measure(str) <= maxBytes) return str
  const room = maxBytes - measure(TRUNC_MARK)
  if (room <= 0) return fitBytes(str, maxBytes, measure)
  return fitBytes(str, room, measure) + TRUNC_MARK
}

const MIDDLE_MARK = '\n…[middle truncated]…\n'

/**
 * Cap a user message keeping head AND tail. The end of a message is often
 * what matters — the question after a pasted log, the last items of a task
 * brief — so the current turn and a pinned opening message are cut in the
 * middle. (System instructions keep capText's placement.)
 */
export function capMiddle(s, maxBytes) {
  const str = String(s ?? '')
  if (byteLen(str) <= maxBytes) return str
  const room = maxBytes - byteLen(MIDDLE_MARK)
  if (room < 512) return capText(str, maxBytes)
  const head = fitBytes(str, Math.floor(room * 0.6))
  return head + MIDDLE_MARK + tailBytes(str, room - byteLen(head))
}

export function frameBytes(threadId, payload) {
  return byteLen(JSON.stringify({ type: 'user_message', payload: { thread_id: threadId, ...payload } }))
}

const escapedBytes = text => byteLen(JSON.stringify(text)) - 2

// On local outpost, Smart retrieved labels from custom_prompt at both 124 B
// and 40 KiB, and missed both labels in system_prompt at either size. Keep
// the persona override small; the caller's instructions appear exactly once.
export function setInstructions(payload, system, custom, threadId) {
  if (!system) {
    if (custom) payload.custom_prompt = custom
    return false
  }
  payload.system_prompt = 'Follow the application instructions supplied for this turn.'
  const prefix = custom ? custom + '\n\n' : ''
  payload.custom_prompt = prefix
  // An omitted thread ID requests lossless placement. The permission reviewer
  // then checks the whole frame and rejects an oversize input before I/O.
  const instruction = threadId === undefined ? system
    : capText(system, Math.max(0, UPSTREAM_TEXT_LIMIT - frameBytes(threadId, payload)), escapedBytes)
  payload.custom_prompt += instruction
  return instruction !== system
}

const STALE_TOOL_CAP = 2 * 1024

/** Longest suffix of `s` within `max` bytes. */
function tailBytes(s, max) {
  if (max <= 0) return ''
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (byteLen(s.slice(mid)) <= max) hi = mid
    else lo = mid + 1
  }
  return s.slice(lo)
}

/**
 * Shrink a tool result to `max` bytes keeping head + tail (file headers and
 * trailing errors both matter) and telling the model how to get the rest —
 * a silent cut makes it guess, a vanished result makes it re-run blindly.
 */
function shrinkTool(body, max) {
  const total = byteLen(body)
  if (total <= max) return body
  const mark = `\n…[${total}-byte result, middle omitted to fit Quick's frame — re-run the tool with a narrower range if you need it]…\n`
  const room = max - byteLen(mark)
  if (room < 256) return `[${total}-byte result omitted to fit Quick's frame — re-run the tool if you need it]`
  const head = fitBytes(body, Math.floor((room * 2) / 3))
  return head + mark + tailBytes(body, room - byteLen(head))
}

const toolHead = (m) => `[tool_result ${[m.name, m.tool_call_id].filter(Boolean).join(' ')}]`
const isTool = (m) => canonRole(m.role) === 'tool' || m.role === 'function'
const renderBlock = (b) => (b.tool ? `${b.head}\n${b.body}` : b.body)

const blockBytes = (b) => 2 + (b.tool ? byteLen(b.head) + 1 + byteLen(b.body) : byteLen(b.body))
const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g
const REMINDER_CAP = 2 * 1024

/**
 * Water-fill <system-reminder> inner text inside non-tool blocks from `from`
 * onward when total bytes exceed `maxBytes`. Keeps small reminders intact and
 * shrinks huge ones (e.g. skill catalogs) before touching tool results or
 * user prompts. When tool blocks are present, caps reminders to at most
 * REMINDER_CAP each if tools would otherwise be starved.
 */
function waterFillReminders(blocks, maxBytes, cut, { from = 0, reserve = 0 } = {}) {
  const used = reserve + blocks.reduce((n, b) => n + blockBytes(b), 0)
  if (used <= maxBytes) return
  const entries = []
  const byBlock = new Map()
  for (let i = from; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.tool || !b.body.includes('<system-reminder>')) continue
    const list = []
    for (const m of b.body.matchAll(REMINDER_RE)) {
      const entry = { inner: m[1], len: byteLen(m[1]), next: m[1] }
      entries.push(entry)
      list.push(entry)
    }
    if (list.length) byBlock.set(i, list)
  }
  if (!entries.length) return
  const remTotal = entries.reduce((n, e) => n + e.len, 0)
  const toolsTotal = blocks.reduce((n, b) => n + (b.tool ? byteLen(b.body) : 0), 0)
  const fixedTotal = used - remTotal - toolsTotal
  let remBudget
  if (!toolsTotal) {
    remBudget = Math.max(0, maxBytes - fixedTotal)
  } else {
    const afterTools = maxBytes - fixedTotal - toolsTotal
    const cappedSum = entries.reduce((n, e) => n + Math.min(e.len, REMINDER_CAP), 0)
    remBudget = afterTools >= cappedSum ? afterTools : Math.min(cappedSum, Math.max(0, maxBytes - fixedTotal))
  }
  let avail = remBudget
  let left = entries.length
  for (const e of [...entries].sort((a, b) => a.len - b.len)) {
    const share = Math.max(0, Math.floor(avail / left--))
    if (e.len > share) {
      const shrunk = shrinkTool(e.inner, share)
      e.next = byteLen(shrunk) <= share ? shrunk : capText(e.inner, share)
      cut()
    }
    avail -= byteLen(e.next)
  }
  for (const [i, list] of byBlock) {
    let idx = 0
    blocks[i].body = blocks[i].body.replace(REMINDER_RE, () => `<system-reminder>${list[idx++].next}</system-reminder>`)
  }
}

/**
 * Water-fill rendered text strings at `indices` in `out` so small messages
 * (e.g. a short user prompt or timestamp) stay whole while oversized siblings
 * split the remaining budget via capMiddle. Only indices in `apply` are shrunk.
 */
function waterFillTexts(out, indices, maxBytes, cut, apply = indices) {
  let used = out.reduce((n, s) => n + byteLen(s) + 2, 0)
  if (used <= maxBytes || !indices.length) return used
  const applySet = new Set(apply)
  const other = used - indices.reduce((n, i) => n + byteLen(out[i]) + 2, 0)
  let avail = Math.max(0, maxBytes - other - indices.length * 2)
  const sorted = [...indices].sort((a, b) => byteLen(out[a]) - byteLen(out[b]))
  let left = sorted.length
  for (const i of sorted) {
    const len = byteLen(out[i])
    const share = Math.max(0, Math.floor(avail / left--))
    if (len > share && applySet.has(i)) {
      const shrunk = capMiddle(out[i], share)
      used -= len - byteLen(shrunk)
      out[i] = shrunk
      avail -= byteLen(shrunk)
      cut()
    } else {
      avail -= Math.min(len, share)
    }
  }
  return used
}

/**
 * Fit blocks into `maxBytes`:
 * 1. Drop middle history (`pin .. historyEnd - 1`) first when a transcript has
 *    prior turns, keeping the pinned opening message if `pinFirst` is set.
 * 2. Shrink oversized <system-reminder> blocks in the current turn before
 *    touching tool results or user text.
 * 3. Water-fill tool-result bodies so parallel results all survive partially.
 * 4. If text still overflows: squeeze the pinned head, then either water-fill
 *    all current-turn blocks (`protectTurn`, so multi-message turns never drop
 *    a short user prompt for a huge sibling) or water-fill oversized trailing
 *    blocks before dropping from the front (`renderDelta`).
 */
function fitBlocks(blocks, maxBytes, cut, { pinFirst = false, historyEnd = 0, protectTurn = false } = {}) {
  const pin = pinFirst && historyEnd > 1 ? 1 : 0
  let dropped = 0
  let used = blocks.reduce((n, b) => n + blockBytes(b), 0)
  while (used > maxBytes && pin + dropped < historyEnd) {
    used -= blockBytes(blocks[pin + dropped++])
    cut()
  }
  const active = pin
    ? [blocks[0], ...blocks.slice(1 + dropped)]
    : blocks.slice(dropped)
  const activeTurnStart = historyEnd - dropped
  const marker = `[${dropped} earlier message(s) omitted]`
  const markerReserve = pin && dropped ? byteLen(marker) + 2 : 0

  waterFillReminders(active, maxBytes, cut, { from: activeTurnStart, reserve: markerReserve })

  let avail = maxBytes - markerReserve - active.reduce((n, b) => n + 2 + (b.tool ? byteLen(b.head) + 1 : byteLen(b.body)), 0)
  const tools = active.filter((b) => b.tool).sort((a, b) => byteLen(a.body) - byteLen(b.body))
  let left = tools.length
  for (const b of tools) {
    const share = Math.max(0, Math.floor(avail / left--))
    if (byteLen(b.body) > share) { b.body = shrinkTool(b.body, share); cut() }
    avail -= byteLen(b.body)
  }

  const rendered = active.map(renderBlock)
  const kept = pin && dropped ? [rendered[0], marker, ...rendered.slice(1)] : rendered
  let keptTurnStart = activeTurnStart + (pin && dropped ? 1 : 0)
  used = kept.reduce((n, s) => n + byteLen(s) + 2, 0)

  if (pin && used > maxBytes) {
    // squeeze the pinned head to what's left beside the rest
    const room = Math.max(512, maxBytes - (used - byteLen(kept[0])))
    if (room < byteLen(kept[0])) { used -= byteLen(kept[0]); kept[0] = capMiddle(kept[0], room); used += byteLen(kept[0]); cut() }
  }

  let headDropped = pin ? 0 : dropped
  if (used > maxBytes) {
    if (protectTurn) {
      const turnIdx = []
      for (let i = keptTurnStart; i < kept.length; i++) turnIdx.push(i)
      used = waterFillTexts(kept, turnIdx, maxBytes, cut)
    } else {
      // In deltas, shrink oversized trailing user blocks before dropping oldest
      // so a short user prompt at index 0 isn't sacrificed for a huge sibling.
      const textIdx = []
      const trailingIdx = []
      active.forEach((b, i) => {
        if (b.tool) return
        textIdx.push(i)
        if (i > 0) trailingIdx.push(i)
      })
      used = waterFillTexts(kept, textIdx, maxBytes, cut, trailingIdx)
      while (used > maxBytes && kept.length > 1) {
        used -= byteLen(kept.shift()) + 2
        headDropped++
        if (keptTurnStart > 0) keptTurnStart--
        cut()
      }
    }
  }

  if (pin && used > maxBytes && kept.length) {
    const room = Math.max(0, maxBytes - (used - byteLen(kept[0])))
    if (room < byteLen(kept[0])) { used -= byteLen(kept[0]); kept[0] = capMiddle(kept[0], room); used += byteLen(kept[0]); cut() }
  }
  while (used > maxBytes && kept.length > 1) {
    used -= byteLen(kept.shift()) + 2
    headDropped++
    if (keptTurnStart > 0) keptTurnStart--
    cut()
  }
  if (used > maxBytes && kept.length) {
    const others = used - byteLen(kept[kept.length - 1]) - 2
    kept[kept.length - 1] = capMiddle(kept[kept.length - 1], Math.max(0, maxBytes - others - 2))
    cut()
  }
  // a pinned drop is marked inline; callers only label head-of-list drops
  return { kept, dropped: headDropped, keptTurnStart }
}

/**
 * Claude Code re-injects whole files as <system-reminder> blocks inside user
 * messages. In history they are stale context, not conversation: squeeze
 * each oversized one like a tool result so it can't crowd out real turns.
 */
function squeezeReminders(text, cut) {
  if (!text.includes('<system-reminder>')) return text
  return text.replace(REMINDER_RE, (all, inner) => {
    if (byteLen(inner) <= REMINDER_CAP) return all
    cut()
    return `<system-reminder>${shrinkTool(inner, REMINDER_CAP)}</system-reminder>`
  })
}

function toolBlock(m, cap, cut) {
  let body = textOf(m.content)
  if (byteLen(body) > cap) { body = shrinkTool(body, cap); cut() }
  return { tool: true, head: toolHead(m), body }
}

/** One transcript line for a non-tool message in the rendered history. */
function transcriptLine(m, cut = () => {}) {
  const text = squeezeReminders(textOf(m.content), cut)
  const role = canonRole(m.role)
  if (role === 'assistant') {
    const calls = renderToolCalls(m.tool_calls)
    return `assistant: ${[text, calls].filter(Boolean).join('\n')}`
  }
  return `${role}: ${text}`
}

const HISTORY_HEAD_RESERVE = 96

/**
 * Byte cap for the current user turn: at least USER_TURN_CAP, up to 60% of
 * the budget — a long final message (a task brief, a pasted log) is usually
 * the thing to answer; older history yields first.
 */
function lastTurnCap(budget) {
  return Number.isFinite(budget) ? Math.max(USER_TURN_CAP, Math.floor(budget * 0.6)) : Infinity
}

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final turn. Everything the model needs in one user_message.
 * Tool results answered before the latest assistant turn are stale and
 * squeezed to STALE_TOOL_CAP; the rest share the budget via fitBlocks.
 * `stats` is mutated with {truncated:true} when anything was cut.
 */
export function renderTranscript(messages, systemText, { maxBytes = Infinity, stats } = {}) {
  const cut = () => { if (stats) stats.truncated = true }
  const parts = []
  if (systemText) {
    if (byteLen(systemText) > SYSTEM_CAP) { systemText = capText(systemText, SYSTEM_CAP); cut() }
    parts.push(`[system instructions]\n${systemText}`)
  }
  let lastAsst = -1
  messages.forEach((m, i) => { if (canonRole(m.role) === 'assistant') lastAsst = i })
  const historyEnd = messages.length ? Math.min(lastAsst + 1, messages.length - 1) : 0
  const sysBytes = parts.reduce((n, s) => n + byteLen(s) + 2, 0)
  const budget = maxBytes - sysBytes - (historyEnd > 0 ? HISTORY_HEAD_RESERVE : 0)
  const turnCap = lastTurnCap(budget)
  const blocks = messages.map((m, i) => {
    if (isTool(m)) return toolBlock(m, i < lastAsst ? STALE_TOOL_CAP : TOOL_RESULT_CAP, cut)
    if (i >= historyEnd && canonRole(m.role) === 'user') {
      let t = textOf(m.content)
      if (!t.includes('<system-reminder>') && byteLen(t) > turnCap) { t = capMiddle(t, turnCap); cut() }
      return { tool: false, body: t || '(empty)' }
    }
    return { tool: false, body: transcriptLine(m, cut) }
  })
  if (!blocks.length) blocks.push({ tool: false, body: '(empty)' })
  const pinFirst = canonRole(messages[0]?.role) === 'user'
  const { kept, dropped, keptTurnStart } = fitBlocks(blocks, budget, cut, {
    pinFirst,
    historyEnd,
    protectTurn: true,
  })
  const history = kept.slice(0, keptTurnStart)
  const current = kept.slice(keptTurnStart)
  if (history.length || (historyEnd > 0 && dropped)) {
    const head = dropped
      ? `[conversation so far — ${dropped} earlier message(s) omitted]\n`
      : '[conversation so far]\n'
    parts.push(head + history.join('\n\n'))
  }
  parts.push(current.join('\n\n'))
  return parts.join('\n\n')
}

/**
 * Delta text for a REUSED thread: only the new user/tool content.
 * Per-block caps apply first (TOOL_RESULT_CAP / USER_TURN_CAP); then
 * <system-reminder> blocks and tool results share the remaining budget
 * (fitBlocks) — the current turn's question is never sacrificed for tool
 * output or injected reminders.
 */
export function renderDelta(delta, { maxBytes = Infinity, stats } = {}) {
  const cut = () => { if (stats) stats.truncated = true }
  const blocks = []
  for (const m of delta) {
    if (isTool(m)) { blocks.push(toolBlock(m, TOOL_RESULT_CAP, cut)); continue }
    // assistant messages never appear in a valid delta (findContinuation rejects them)
    if (canonRole(m.role) !== 'user') continue
    const t = textOf(m.content)
    if (t) blocks.push({ tool: false, body: t })
  }
  // the newest user message is the current turn: it gets the larger cap
  const lastUser = blocks.findLastIndex((b) => !b.tool)
  blocks.forEach((b, i) => {
    if (b.tool) return
    if (Number.isFinite(maxBytes) && b.body.includes('<system-reminder>')) return
    const cap = i === lastUser ? lastTurnCap(maxBytes - 48) : USER_TURN_CAP
    if (byteLen(b.body) > cap) { b.body = capMiddle(b.body, cap); cut() }
  })
  if (!blocks.length) return ''
  const { kept, dropped } = fitBlocks(blocks, maxBytes - 48, cut)
  return dropped ? `[${dropped} earlier message(s) omitted]\n` + kept.join('\n\n') : kept.join('\n\n')
}
