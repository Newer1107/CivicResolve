// Shared AI client for all CivicResolve AI features.
// Primary: CoE AI Gateway (ai.tcetcercd.in, Qwen3.6-35B-A3B — text + vision).
// Fallbacks: opencode gateway (deepseek/mimo) -> local Ollama.

const COE_URL = process.env.COE_API_URL || 'https://ai.tcetcercd.in/v1'
const COE_API_KEY = process.env.COE_API_KEY || ''
const COE_MODEL = process.env.COE_MODEL || 'qwen3.6'
const OPENCODE_URL = process.env.OPENCODE_URL || 'https://opencode.ai/zen/go/v1'
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || ''
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://175.175.0.254:11434'
// Chat/vision model names — provider-specific, so the gateway and the local
// fallback can each use the right models. (The og .env.example only shipped
// OLLAMA_* names; OPENCODE_* were documented but never read — fixed here.)
export const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:3b'
export const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'llama3.2-vision:11b'
const GATEWAY_CHAT_MODEL = process.env.OPENCODE_CHAT_MODEL || 'deepseek-v4-flash'
const GATEWAY_VISION_MODEL = process.env.OPENCODE_VISION_MODEL || 'mimo-v2.5'
// Vision routing: 'local' forces ALL image calls to Ollama (dev convenience);
// 'gateway' (default) uses the cloud gateway chain (CoE -> opencode) first.
const VISION_PROVIDER = process.env.VISION_PROVIDER || 'gateway'

interface OllamaGenerateOptions {
  model?: string
  prompt?: string
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  images?: string[] // base64
  format?: 'json'
  temperature?: number
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// The chat model actually in use, for UI labels: CoE when configured, else the
// opencode gateway model when configured, else the local one.
export function activeChatModel(): string {
  if (COE_API_KEY && VISION_PROVIDER !== 'local') return `${COE_MODEL} (CoE)`
  return OPENCODE_API_KEY && VISION_PROVIDER !== 'local' ? GATEWAY_CHAT_MODEL : OLLAMA_CHAT_MODEL
}

export async function ollamaGenerate(opts: OllamaGenerateOptions): Promise<string> {
  const forceLocal = opts.images?.length && VISION_PROVIDER === 'local'
  if (!COE_API_KEY && !OPENCODE_API_KEY) return ollamaGenerateFallback(opts)
  if (forceLocal) return ollamaGenerateFallback(opts)
  // Provider chain: CoE gateway -> opencode gateway -> local Ollama.
  if (COE_API_KEY) {
    try {
      return await coeGenerate(opts)
    } catch (err) {
      console.warn(`[AI] CoE gateway failed (${(err as Error).message}) — trying opencode`)
    }
  }
  if (OPENCODE_API_KEY) {
    try {
      return await opencodeGenerate(opts)
    } catch (err) {
      console.warn(`[AI] opencode gateway failed (${(err as Error).message}) — falling back to Ollama`)
    }
  }
  return ollamaGenerateFallback(opts)
}

// CoE AI Gateway — OpenAI-compatible /chat/completions (Qwen3.6, single model).
// Thinking is OFF by default on the gateway (fast replies); we never send
// reasoning_effort here, and skip response_format in favour of the prompt's
// "return JSON only" contract (the callers already regex-extract JSON).
async function coeGenerate(opts: OllamaGenerateOptions): Promise<string> {
  const messages: Array<Record<string, unknown>> = opts.messages
    ? opts.messages.map((m) => ({ role: m.role, content: m.content }))
    : [{ role: 'user', content: opts.prompt ?? '' }]

  // Multi-image support (vision): data-URL image blocks on the last user message.
  if (opts.images?.length && messages.length) {
    const last = messages[messages.length - 1]
    const text = typeof last.content === 'string' ? (last.content as string) : ''
    last.content = [
      ...opts.images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${img}` },
      })),
      { type: 'text', text },
    ]
  }

  const body: Record<string, unknown> = {
    model: opts.model || COE_MODEL,
    stream: false,
    max_tokens: 2048,
    messages,
  }
  if (opts.temperature != null) body.temperature = opts.temperature

  const res = await fetch(`${COE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${COE_API_KEY}`,
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`CoE AI error ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = String(data.choices?.[0]?.message?.content ?? '').trim()
  if (!text) throw new Error('CoE AI returned an empty response')
  return text
}

// OpenAI-compatible chat completions against the opencode gateway.
async function opencodeGenerate(opts: OllamaGenerateOptions): Promise<string> {
  const messages: Array<Record<string, unknown>> = opts.messages
    ? opts.messages.map((m) => ({ role: m.role, content: m.content }))
    : [{ role: 'user', content: opts.prompt ?? '' }]

  // Attach images to the last user message as data-URL content blocks
  // (all images — enables multi-image comparison like verify-issue).
  if (opts.images?.length && messages.length) {
    const last = messages[messages.length - 1]
    const text = typeof last.content === 'string' ? (last.content as string) : ''
    last.content = [
      ...opts.images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${img}` },
      })),
      { type: 'text', text },
    ]
  }

  const body: Record<string, unknown> = {
    model: opts.model || (opts.images?.length ? GATEWAY_VISION_MODEL : GATEWAY_CHAT_MODEL),
    stream: false,
    max_tokens: 2048,
    messages,
  }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.format === 'json') body.response_format = { type: 'json_object' }
  // deepseek-v4-flash is a reasoning model; disable the thinking pass for
  // interactive chat (generation is instant once reasoning is off — the
  // ~12s floor is the gateway's time-to-first-token, not the model).
  // Vision models (mimo-v2.5) do NOT accept reasoning_effort — only send it
  // on text-only calls.
  if (!opts.images?.length) body.reasoning_effort = 'none'

  const res = await fetch(`${OPENCODE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENCODE_API_KEY}`,
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`AI error ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = String(data.choices?.[0]?.message?.content ?? '').trim()
  if (!text) throw new Error('AI returned an empty response')
  return text
}

// Ollama fallback (used when OPENCODE_API_KEY is unset or VISION_PROVIDER=local).
async function ollamaGenerateFallback(opts: OllamaGenerateOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model || (opts.images?.length ? OLLAMA_VISION_MODEL : OLLAMA_CHAT_MODEL),
    stream: false,
    options: {},
  }
  if (opts.messages) body.messages = opts.messages
  else body.prompt = opts.prompt ?? ''
  if (opts.images?.length) body.images = opts.images
  if (opts.format) body.format = opts.format
  if (opts.temperature != null) (body.options as Record<string, unknown>).temperature = opts.temperature

  const res = await fetch(`${OLLAMA_URL}/api/${opts.messages ? 'chat' : 'generate'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Ollama error ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = String(data.response ?? data.message?.content ?? '').trim()
  if (!text) throw new Error('Ollama returned an empty response')
  return text
}
