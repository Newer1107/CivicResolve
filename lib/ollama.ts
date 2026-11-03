// Shared AI client for every CivicResolve AI feature.
//
// One provider: the official DeepSeek API (OpenAI-compatible chat completions).
// `deepseek-flash` handles both text and images, so chat, photo analysis and
// verification all route through this single function — there is no failover
// chain any more, because a fallback that can never answer is worse than an
// honest error (it adds latency and lies in the logs).
//
// The file name and the `ollamaGenerate` export are historical; the ~10 call
// sites and the verify worker's bundle reference them, so they stay.

const API_URL = (process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

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

// Model label for the UI ("deepseek-flash (DeepSeek)").
export function activeChatModel(): string {
  return `${MODEL} (DeepSeek)`
}

export async function ollamaGenerate(opts: OllamaGenerateOptions): Promise<string> {
  if (!API_KEY) {
    // Same prefix the callers key off to return a 503 rather than a 500.
    throw new Error('No AI provider available (DEEPSEEK_API_KEY is not set)')
  }

  const messages: Array<Record<string, unknown>> = opts.messages
    ? opts.messages.map((m) => ({ role: m.role, content: m.content }))
    : [{ role: 'user', content: opts.prompt ?? '' }]

  // Vision: images ride on the last user message as data-URL content blocks.
  // DeepSeek rejects images in system/assistant messages, and these callers
  // only ever append to the final user turn.
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
    model: opts.model || MODEL,
    stream: false,
    max_tokens: 2048,
    messages,
    // Thinking is enabled by default at effort "high" — seconds of
    // chain-of-thought before a chat reply or a verdict. Off for every call.
    thinking: { type: 'disabled' },
  }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.format === 'json') body.response_format = { type: 'json_object' }

  const res = await fetch(`${API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
    // A hung provider must surface as an error, not a request that never ends.
    signal: AbortSignal.timeout(Number(process.env.AI_REQUEST_TIMEOUT) || 120_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`DeepSeek error ${res.status}: ${detail.slice(0, 200)}`)
  }

  const data = await res.json()
  const text = String(data.choices?.[0]?.message?.content ?? '').trim()
  if (!text) throw new Error('DeepSeek returned an empty response')
  return text
}
