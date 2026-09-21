/* KIE ORIGINAL - the dialect bridge.

   KIE speaks exactly one shape: POST https://api.kie.ai/codex/v1/responses with
   { model, stream, input, tools?, reasoning? }, answering with SSE frames of
   type response.output_text.delta. Harnesses speak four different shapes, so we
   translate on the way in (toKiePayload) and on the way out (bridgeKie).
   No Anthropic provider, no second upstream, no extra key. */

export type Dialect = "chat" | "messages" | "responses" | "completions" | "embeddings"

export const KIE_DELTA_EVENT = "response.output_text.delta"
export const KIE_DONE = "[DONE]"
export const KIE_DEFAULT_PATH = "/codex/v1/responses"

/* chat = SDKs/Cursor/Cline, messages = Claude Code, responses = Codex CLI */
export function dialectOf(path: string): Dialect {
  const p = String(path || "").toLowerCase()
  if (p.includes("/messages")) return "messages"
  if (p.includes("/responses")) return "responses"
  if (p.includes("/embeddings")) return "embeddings"
  if (p.includes("/chat/completions")) return "chat"
  if (p.includes("/completions")) return "completions"
  return "chat"
}

const HARNESS_HINTS: Array<[RegExp, string]> = [
  [/claude-?(cli|code)/i, "claude-code"],
  [/codex/i, "codex"],
  [/cursor/i, "cursor"],
  [/cline/i, "cline"],
  [/roo/i, "roo"],
  [/aider/i, "aider"],
  [/opencode/i, "opencode"],
  [/continue/i, "continue"],
  [/open-?webui/i, "open-webui"],
  [/langchain/i, "langchain"],
  [/llama-?index/i, "llamaindex"],
  [/curl/i, "curl"],
  [/python-requests|httpx|aiohttp|node-fetch|axios|undici|okhttp/i, "script"],
]

export function harnessOf(req: Request, dialect: Dialect): string {
  const h = req.headers
  const hint = [h.get("x-app"), h.get("x-title"), h.get("x-client-name"), h.get("user-agent")]
    .filter(Boolean)
    .join(" ")
  for (const [re, name] of HARNESS_HINTS) if (re.test(hint)) return name
  if (h.get("anthropic-version") || h.get("anthropic-api-key") || dialect === "messages") {
    return "anthropic-client"
  }
  if (dialect === "responses") return "codex"
  return "api"
}

export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part
        if (!part || typeof part !== "object") return ""
        if (typeof part.text === "string") return part.text
        if (part.type === "tool_result") return textOfContent(part.content)
        if (part.type === "tool_use" || part.type === "function_call") {
          const name = part.name ?? part.function?.name ?? ""
          return `[tool ${name} ${JSON.stringify(part.input ?? part.arguments ?? {})}]`
        }
        if (/image/i.test(String(part.type ?? ""))) return "[image]"
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (content && typeof content === "object") {
    const c = content as any
    if (typeof c.text === "string") return c.text
    if (c.content) return textOfContent(c.content)
  }
  return ""
}

function roleLabel(role: unknown): string {
  const r = String(role || "user").toLowerCase()
  if (r === "system" || r === "developer") return "System"
  if (r === "assistant" || r === "model") return "Assistant"
  if (r === "tool" || r === "function") return "Tool"
  return "User"
}

/* Every dialect collapses into one plain `input` string, the only field KIE takes. */
export function flattenToInput(body: any, dialect: Dialect): string {
  if (dialect === "completions") {
    const p = body?.prompt
    if (typeof p === "string") return p
    if (Array.isArray(p)) return p.map((x) => String(x)).join("\n")
    return ""
  }

  const chunks: string[] = []
  if (typeof body?.instructions === "string" && body.instructions.trim()) {
    chunks.push(`System: ${body.instructions.trim()}`)
  }
  const sys = body?.system
  if (typeof sys === "string" && sys.trim()) chunks.push(`System: ${sys.trim()}`)
  else if (Array.isArray(sys)) {
    const t = textOfContent(sys)
    if (t) chunks.push(`System: ${t}`)
  }

  if (dialect === "responses") {
    if (typeof body?.input === "string" && body.input.trim()) chunks.push(body.input)
    else if (Array.isArray(body?.input)) {
      for (const item of body.input) {
        if (typeof item === "string") {
          chunks.push(item)
          continue
        }
        const t = textOfContent(item?.content ?? item?.text ?? item)
        if (t) chunks.push(`${roleLabel(item?.role)}: ${t}`)
      }
    }
    return chunks.join("\n\n")
  }

  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    const t = textOfContent(m?.content)
    if (t) chunks.push(`${roleLabel(m?.role)}: ${t}`)
  }
  return chunks.join("\n\n") || textOfContent(body?.input) || ""
}

export function wantsWebSearch(body: any): boolean {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.some((t: any) =>
    /web_?search|browser|browse/i.test(String(t?.type ?? t?.name ?? t?.function?.name ?? "")),
  )
}

/* Anthropic sends a thinking budget; KIE wants low | medium | high. */
export function effortOf(body: any): "low" | "medium" | "high" | null {
  const direct = body?.reasoning?.effort ?? body?.reasoning_effort
  if (typeof direct === "string" && /^(low|medium|high)$/i.test(direct)) {
    return direct.toLowerCase() as "low" | "medium" | "high"
  }
  if (body?.thinking?.type === "disabled") return null
  const budget = Number(body?.thinking?.budget_tokens ?? body?.reasoning?.max_tokens ?? 0)
  if (budget >= 16000) return "high"
  if (budget >= 4000) return "medium"
  if (budget > 0) return "low"
  return null
}

/* Fields KIE rejects (messages, max_tokens, temperature, top_p...) are dropped. */
export function toKiePayload(body: any, dialect: Dialect, upstreamModel: string) {
  const payload: Record<string, unknown> = {
    model: upstreamModel,
    stream: true,
    input: flattenToInput(body, dialect),
  }
  if (wantsWebSearch(body)) payload.tools = [{ type: "web_search" }]
  const effort = effortOf(body)
  if (effort) payload.reasoning = { effort }
  return payload
}

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

export function scrubText(text: string, secrets: string[] = []): string {
  let out = String(text ?? "")
  for (const s of secrets) if (s && s.length > 6) out = out.split(s).join("***")
  return out
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const sseNamed = (event: string, obj: unknown) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`

type Ctx = { dialect: Dialect; model: string; id: string; created: number }

function openFrames(c: Ctx): string {
  if (c.dialect === "messages") {
    return (
      sseNamed("message_start", {
        type: "message_start",
        message: {
          id: c.id,
          type: "message",
          role: "assistant",
          model: c.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }) +
      sseNamed("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })
    )
  }
  if (c.dialect === "responses") {
    return sseNamed("response.created", {
      type: "response.created",
      response: { id: c.id, object: "response", created_at: c.created, model: c.model, status: "in_progress", output: [] },
    })
  }
  if (c.dialect === "chat") {
    return sse({
      id: c.id,
      object: "chat.completion.chunk",
      created: c.created,
      model: c.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })
  }
  return ""
}

function deltaFrames(c: Ctx, text: string): string {
  if (!text) return ""
  if (c.dialect === "messages") {
    return sseNamed("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })
  }
  if (c.dialect === "responses") {
    return sseNamed(KIE_DELTA_EVENT, {
      type: KIE_DELTA_EVENT,
      item_id: c.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    })
  }
  if (c.dialect === "completions") {
    return sse({
      id: c.id,
      object: "text_completion",
      created: c.created,
      model: c.model,
      choices: [{ index: 0, text, finish_reason: null }],
    })
  }
  return sse({
    id: c.id,
    object: "chat.completion.chunk",
    created: c.created,
    model: c.model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
}

function closeFrames(c: Ctx, tIn: number, tOut: number): string {
  const usage = { prompt_tokens: tIn, completion_tokens: tOut, total_tokens: tIn + tOut }
  if (c.dialect === "messages") {
    return (
      sseNamed("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseNamed("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: tIn, output_tokens: tOut },
      }) +
      sseNamed("message_stop", { type: "message_stop" })
    )
  }
  if (c.dialect === "responses") {
    return sseNamed("response.completed", {
      type: "response.completed",
      response: {
        id: c.id,
        object: "response",
        created_at: c.created,
        model: c.model,
        status: "completed",
        usage: { input_tokens: tIn, output_tokens: tOut, total_tokens: tIn + tOut },
      },
    })
  }
  const tail =
    c.dialect === "completions"
      ? { id: c.id, object: "text_completion", created: c.created, model: c.model, choices: [{ index: 0, text: "", finish_reason: "stop" }], usage }
      : { id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }
  return sse(tail) + `data: ${KIE_DONE}\n\n`
}

function errorFrames(c: Ctx, message: string): string {
  if (c.dialect === "messages") {
    return sseNamed("error", { type: "error", error: { type: "api_error", message } })
  }
  if (c.dialect === "responses") {
    return sseNamed("response.failed", {
      type: "response.failed",
      response: { id: c.id, object: "response", model: c.model, status: "failed", error: { message } },
    })
  }
  return sse({ error: { message, type: "upstream_error" } }) + `data: ${KIE_DONE}\n\n`
}

function nonStreamBody(c: Ctx, text: string, tIn: number, tOut: number) {
  const usage = { prompt_tokens: tIn, completion_tokens: tOut, total_tokens: tIn + tOut }
  if (c.dialect === "messages") {
    return {
      id: c.id,
      type: "message",
      role: "assistant",
      model: c.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: tIn, output_tokens: tOut },
    }
  }
  if (c.dialect === "responses") {
    return {
      id: c.id,
      object: "response",
      created_at: c.created,
      model: c.model,
      status: "completed",
      output: [
        {
          id: `${c.id}-msg`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      output_text: text,
      usage: { input_tokens: tIn, output_tokens: tOut, total_tokens: tIn + tOut },
    }
  }
  if (c.dialect === "completions") {
    return {
      id: c.id,
      object: "text_completion",
      created: c.created,
      model: c.model,
      choices: [{ index: 0, text, finish_reason: "stop" }],
      usage,
    }
  }
  return {
    id: c.id,
    object: "chat.completion",
    created: c.created,
    model: c.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage,
  }
}

export type KieUsage = {
  tokensIn: number
  tokensOut: number
  text: string
  reasoning: string
  status: number
  responseId: string | null
  error: string | null
}

export type BridgeOptions = {
  dialect: Dialect
  publicModel: string
  requestId: string
  streaming: boolean
  headers: Record<string, string>
  secrets?: string[]
  promptText?: string
  onDone?: (usage: KieUsage) => void | Promise<void>
}

function parseFrame(raw: string): { event: string | null; data: string } {
  let event: string | null = null
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trim())
  }
  return { event, data: data.join("\n") }
}

/* Read KIE's SSE body once, yielding text / reasoning / usage / error events. */
async function* readKie(upstream: Response, secrets: string[]) {
  const body = upstream.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf("\n\n")
    while (cut !== -1) {
      const raw = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      cut = buffer.indexOf("\n\n")
      const frame = parseFrame(raw)
      if (!frame.data || frame.data === KIE_DONE) continue
      let obj: any
      try {
        obj = JSON.parse(frame.data)
      } catch {
        continue
      }
      const type = String(obj?.type ?? frame.event ?? "")
      const piece = typeof obj?.delta === "string" ? obj.delta : String(obj?.delta?.text ?? "")
      if (type === KIE_DELTA_EVENT || type.endsWith("output_text.delta")) {
        if (piece) yield { text: piece }
        continue
      }
      if (/reasoning.*delta/.test(type)) {
        if (piece) yield { reasoning: piece }
        continue
      }
      if (type === "response.completed" || type === "response.incomplete") {
        yield {
          usage: obj?.response?.usage ?? null,
          responseId: obj?.response?.id ?? null,
          fullText: typeof obj?.response?.output_text === "string" ? obj.response.output_text : "",
        }
        continue
      }
      if (type === "response.failed" || type === "error" || obj?.error) {
        const message = obj?.response?.error?.message ?? obj?.error?.message ?? obj?.message ?? "upstream error"
        yield { error: scrubText(String(message), secrets).slice(0, 400) }
        continue
      }
      const alt = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text
      if (typeof alt === "string" && alt) yield { text: alt }
    }
  }
}

/* Read KIE's reply once and re-emit it in the caller's dialect. */
export async function bridgeKie(upstream: Response, o: BridgeOptions): Promise<Response> {
  const c: Ctx = {
    dialect: o.dialect === "embeddings" ? "chat" : o.dialect,
    model: o.publicModel,
    id: o.dialect === "messages" ? `msg_${o.requestId}` : `resp_${o.requestId}`,
    created: Math.floor(Date.now() / 1000),
  }
  const secrets = o.secrets ?? []
  const promptTokens = estimateTokens(o.promptText ?? "")

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "")
    const message = scrubText(raw || `upstream ${upstream.status}`, secrets).slice(0, 400)
    await o.onDone?.({
      tokensIn: promptTokens,
      tokensOut: 0,
      text: "",
      reasoning: "",
      status: upstream.status,
      responseId: null,
      error: message,
    })
    if (!o.streaming) {
      return new Response(JSON.stringify({ error: { message, type: "upstream_error" } }), {
        status: upstream.status,
        headers: { ...o.headers, "content-type": "application/json" },
      })
    }
    return new Response(errorFrames(c, message), {
      status: 200,
      headers: { ...o.headers, "content-type": "text/event-stream" },
    })
  }

  if (!o.streaming) {
    let text = ""
    let reasoning = ""
    let tokensIn = promptTokens
    let tokensOut = 0
    let responseId: string | null = null
    let error: string | null = null
    for await (const ev of readKie(upstream, secrets)) {
      const e = ev as any
      if (e.text) text += e.text
      if (e.reasoning) reasoning += e.reasoning
      if (e.error) error = e.error
      if (e.usage || e.responseId) {
        tokensIn = Number(e.usage?.input_tokens ?? e.usage?.prompt_tokens ?? tokensIn) || tokensIn
        tokensOut = Number(e.usage?.output_tokens ?? e.usage?.completion_tokens ?? 0) || tokensOut
        responseId = e.responseId ?? responseId
        if (!text && e.fullText) text = e.fullText
      }
    }
    if (!tokensOut) tokensOut = estimateTokens(text)
    await o.onDone?.({ tokensIn, tokensOut, text, reasoning, status: error ? 502 : 200, responseId, error })
    if (error && !text) {
      return new Response(JSON.stringify({ error: { message: error, type: "upstream_error" } }), {
        status: 502,
        headers: { ...o.headers, "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify(nonStreamBody(c, text, tokensIn, tokensOut)), {
      status: 200,
      headers: { ...o.headers, "content-type": "application/json" },
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let text = ""
      let reasoning = ""
      let tokensIn = promptTokens
      let tokensOut = 0
      let responseId: string | null = null
      let error: string | null = null
      const push = (s: string) => {
        if (s) controller.enqueue(encoder.encode(s))
      }
      try {
        push(openFrames(c))
        for await (const ev of readKie(upstream, secrets)) {
          const e = ev as any
          if (e.text) {
            text += e.text
            push(deltaFrames(c, e.text))
          }
          if (e.reasoning) reasoning += e.reasoning
          if (e.error) error = e.error
          if (e.usage || e.responseId) {
            tokensIn = Number(e.usage?.input_tokens ?? e.usage?.prompt_tokens ?? tokensIn) || tokensIn
            tokensOut = Number(e.usage?.output_tokens ?? e.usage?.completion_tokens ?? 0) || tokensOut
            responseId = e.responseId ?? responseId
          }
        }
        if (!tokensOut) tokensOut = estimateTokens(text)
        if (error && !text) push(errorFrames(c, error))
        else push(closeFrames(c, tokensIn, tokensOut))
      } catch (err) {
        error = scrubText(String((err as Error)?.message ?? err), secrets).slice(0, 400)
        push(errorFrames(c, error))
      } finally {
        controller.close()
        try {
          await o.onDone?.({
            tokensIn,
            tokensOut: tokensOut || estimateTokens(text),
            text,
            reasoning,
            status: error && !text ? 502 : 200,
            responseId,
            error,
          })
        } catch {
          /* logging must never break a finished stream */
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      ...o.headers,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}
