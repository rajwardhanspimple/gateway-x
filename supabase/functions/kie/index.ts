// ============================================================================
//  kie — Kie (api.kie.ai) Codex /responses proxy   ·   admin only
// ----------------------------------------------------------------------------
//  THERE IS EXACTLY ONE REQUEST SHAPE, because it is the only one Kie accepts:
//
//    POST https://api.kie.ai/codex/v1/responses
//    Authorization: Bearer <KIE_API_KEY>
//    Content-Type: application/json
//
//    {
//      "model":  "gpt-6-astra",
//      "stream": true,
//      "input":  "Say hello in one word."
//               |  [{ "role": "user", "content": [
//                     { "type": "input_text",  "text": "What is in this image?" },
//                     { "type": "input_image", "image_url": "https://…png" }]}]
//      "tools":     [{ "type": "web_search" }],   // optional
//      "reasoning": { "effort": "high" }          // optional
//    }
//
//  Anything else is refused BEFORE it leaves this function:
//    · no "messages" / "max_tokens" (Anthropic + chat-completions shapes)
//    · no extra headers (Kie sees only Authorization + Content-Type)
//    · no "stream": false — Kie answers text/event-stream and we still parse a
//      non-stream body defensively, but we never ask for one
//    · unknown top-level keys are dropped, never forwarded
//
//  Actions:
//    { action: "test",  model?, prompt?, image_url?/images?, web_search?,
//                       reasoning_effort?, input? }
//        one call; consumes the SSE stream and returns a FULL analysis of
//        everything Kie emitted (text, reasoning, tool calls, per-event-type
//        tally, usage, credits_consumed, timings, errors).
//    { action: "probe" }
//        runs the two canonical doc tests back to back (A: minimal stream,
//        B: image + web_search + reasoning.effort=high) and analyses both.
//    { action: "stream", … same fields as test … }
//        pipes the upstream SSE straight back to the caller.
//
//  Auth mirrors admin-account: Firebase/Supabase admin gate + service-role DB
//  client. DEPLOY WITH:  supabase functions deploy kie --no-verify-jwt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import {
  apiError,
  corsHeaders,
  json,
  MAX_BODY_BYTES,
  preflight,
  safeJsonParse,
} from "../_shared/cors.ts"
import {
  AuthTokenError,
  requireAdmin as requireAdminCaller,
  resolveJwtSecret,
} from "../_shared/firebase.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""
const JWT_SECRET = resolveJwtSecret()
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? ""

/* ------------------------------------------------------------------ contract */
const KIE_ENDPOINT = "https://api.kie.ai/codex/v1/responses"
/** Only this endpoint is callable. A stored endpoint has to match it. */
const ENDPOINT_RE = /^https:\/\/api\.kie\.ai\/codex\/v1\/responses\/?$/i
const CATEGORY = "codex"
const DEFAULT_MODEL = "gpt-6-astra"
const DELTA_EVENT = "response.output_text.delta"
const DONE_SENTINEL = "[DONE]"
const EFFORTS = new Set(["low", "medium", "high"])
/** The only tool type the doc example uses. */
const TOOL_TYPES = new Set(["web_search"])
const DOC_IMAGE =
  "https://file.aiquickdraw.com/custom-page/akr/section-images/1759055072437dqlsclj2.png"

type KieProvider = {
  id: string
  category: string
  endpoint: string
  default_model: string | null
}

type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }

type InputTurn = { role: string; content: InputPart[] }

type KiePayload = {
  model: string
  stream: true
  input: string | InputTurn[]
  tools?: Array<{ type: string }>
  reasoning?: { effort: string }
}

type Analysis = {
  ok: boolean
  status: number
  content_type: string | null
  streamed: boolean
  ms: number
  first_delta_ms: number | null
  bytes: number
  text: string
  reasoning: string
  refusal: string
  event_count: number
  delta_count: number
  events_by_type: Record<string, number>
  event_order: string[]
  output_items: Array<Record<string, unknown>>
  tool_calls: Array<Record<string, unknown>>
  annotations: unknown[]
  usage: unknown
  credits_consumed: unknown
  response_id: string | null
  response_model: string | null
  response_status: string | null
  incomplete_details: unknown
  error: unknown
  unmapped_event_samples: unknown[]
  raw_tail: string
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  if (req.method !== "POST") {
    return apiError("Method not allowed", 405, "method_not_allowed", {}, req)
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return apiError("Function is not configured", 500, "not_configured", {}, req)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ---- admin gate -------------------------------------------------------
  let caller
  try {
    caller = await requireAdminCaller(req, admin, {
      jwtSecret: JWT_SECRET,
      firebaseProjectId: FIREBASE_PROJECT_ID,
    })
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return apiError(err.message, err.status ?? 401, err.code ?? "unauthorized", {}, req)
    }
    return apiError("Admins only", 403, "forbidden", {}, req)
  }

  // ---- body -------------------------------------------------------------
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return apiError("Request body too large", 413, "too_large", {}, req)
  }
  const body = safeJsonParse(raw, {}) as Record<string, unknown>
  const action = typeof body.action === "string" ? body.action : "test"
  if (action !== "test" && action !== "stream" && action !== "probe") {
    return apiError(`Unknown action: ${action}`, 400, "bad_action", {}, req)
  }
  // Only the codex Responses category exists now; reject the old ones loudly
  // so a stale caller is fixed instead of silently retargeted.
  const category = typeof body.category === "string" ? body.category : CATEGORY
  if (category !== CATEGORY) {
    return apiError(
      `Only the "codex" Responses shape is supported (got "${category}").`,
      400,
      "bad_category",
      {},
      req,
    )
  }
  for (const banned of ["messages", "max_tokens", "max_output_tokens", "temperature", "top_p"]) {
    if (body[banned] !== undefined) {
      return apiError(
        `"${banned}" is not part of the Kie codex request shape. Use input / tools / reasoning.`,
        400,
        "bad_field",
        { field: banned },
        req,
      )
    }
  }

  // ---- provider + a usable key -----------------------------------------
  const { data: provider } = await admin
    .from("kie_providers")
    .select("id, category, endpoint, default_model")
    .eq("category", CATEGORY)
    .maybeSingle()
  if (!provider) {
    return apiError("Kie codex is not configured", 400, "not_configured", {}, req)
  }
  const prov = provider as KieProvider

  // The endpoint is pinned: a stored value may only confirm the canonical URL.
  const stored = (prov.endpoint || "").trim()
  if (stored && !ENDPOINT_RE.test(stored)) {
    return apiError(
      `Endpoint must be ${KIE_ENDPOINT} (stored: ${stored}).`,
      400,
      "bad_endpoint",
      {},
      req,
    )
  }
  const endpoint = KIE_ENDPOINT

  const { data: keyRow } = await admin
    .from("kie_provider_keys")
    .select("id, api_key")
    .eq("kie_provider_id", prov.id)
    .eq("is_active", true)
    .neq("status", "disabled")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle()
  if (!keyRow) {
    return apiError("No active key for Kie codex", 400, "no_key", {}, req)
  }
  const keyId = (keyRow as { id: string }).id
  const apiKey = (keyRow as { api_key: string }).api_key

  const model = pickModel(body.model, prov.default_model)

  /* The two headers Kie is sent — nothing else, ever. */
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }

  // ---- action: stream => pipe the SSE straight back --------------------
  if (action === "stream") {
    let payload: KiePayload
    try {
      payload = buildPayload(body, model)
    } catch (err) {
      return apiError(String((err as Error)?.message || err), 400, "bad_input", {}, req)
    }

    let upstream: Response
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
    } catch (err) {
      await markKey(admin, keyId, "failing", String((err as Error)?.message || err))
      return apiError("Could not reach Kie", 502, "upstream_unreachable", {}, req)
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await safeText(upstream)
      await markKey(admin, keyId, "failing", `${upstream.status} ${detail.slice(0, 200)}`)
      return apiError(`Kie responded ${upstream.status}`, 502, "upstream_error", {
        detail: detail.slice(0, 500),
      }, req)
    }
    markKey(admin, keyId, "working", null).catch(() => {})
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders(req),
        "content-type": upstream.headers.get("content-type") || "text/event-stream",
        "cache-control": "no-cache",
        "x-kie-model": model,
      },
    })
  }

  // ---- action: probe => the two doc tests, exactly as documented -------
  if (action === "probe") {
    const runs: Array<Record<string, unknown>> = []
    const specs: Array<{ name: string; payload: KiePayload }> = [
      {
        name: "A: minimal stream",
        payload: { model, stream: true, input: "Say hello in one word." },
      },
      {
        name: "B: doc example stream",
        payload: {
          model,
          stream: true,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "What is in this image?" },
                { type: "input_image", image_url: DOC_IMAGE },
              ],
            },
          ],
          tools: [{ type: "web_search" }],
          reasoning: { effort: "high" },
        },
      },
    ]

    let anyOk = false
    let lastError: string | null = null
    for (const spec of specs) {
      const result = await callKie(endpoint, headers, spec.payload)
      if (result.analysis.ok) anyOk = true
      else lastError = `${spec.name}: ${result.analysis.status} ${result.analysis.raw_tail.slice(0, 160)}`
      runs.push({ name: spec.name, request: spec.payload, analysis: result.analysis })
    }
    await markKey(admin, keyId, anyOk ? "working" : "failing", anyOk ? null : lastError)

    return json(
      {
        ok: anyOk,
        action: "probe",
        endpoint,
        model,
        runs,
        by: caller?.email || caller?.id || "admin",
      },
      200,
      {},
      req,
    )
  }

  // ---- action: test => one call, full analysis --------------------------
  let payload: KiePayload
  try {
    payload = buildPayload(body, model)
  } catch (err) {
    return apiError(String((err as Error)?.message || err), 400, "bad_input", {}, req)
  }

  const result = await callKie(endpoint, headers, payload)
  if (!result.analysis.ok) {
    await markKey(
      admin,
      keyId,
      "failing",
      `${result.analysis.status} ${result.analysis.raw_tail.slice(0, 200)}`,
    )
    return json(
      {
        ok: false,
        action: "test",
        endpoint,
        model,
        request: payload,
        analysis: result.analysis,
        by: caller?.email || caller?.id || "admin",
      },
      200,
      {},
      req,
    )
  }

  await markKey(admin, keyId, "working", null)
  return json(
    {
      ok: true,
      action: "test",
      endpoint,
      model,
      /* the exact JSON body that was sent, so the panel can show it */
      request: payload,
      analysis: result.analysis,
      /* kept flat for older callers / quick glances */
      text: result.analysis.text.slice(0, 8000),
      events: result.analysis.event_count,
      ms: result.analysis.ms,
      usage: result.analysis.usage,
      credits_consumed: result.analysis.credits_consumed,
      delta_event_type: DELTA_EVENT,
      by: caller?.email || caller?.id || "admin",
    },
    200,
    {},
    req,
  )
})

// ---------------------------------------------------------------------------
//  request building — the ONLY shape that leaves this file
// ---------------------------------------------------------------------------
function pickModel(given: unknown, fallback: string | null): string {
  const g = typeof given === "string" ? given.trim() : ""
  if (g) return g
  const f = (fallback || "").trim()
  return f || DEFAULT_MODEL
}

function buildPayload(body: Record<string, unknown>, model: string): KiePayload {
  const payload: KiePayload = { model, stream: true, input: normalizeInput(body) }

  const tools = normalizeTools(body)
  if (tools.length) payload.tools = tools

  const effort = normalizeEffort(body)
  if (effort) payload.reasoning = { effort }

  return payload
}

/** string input, or the [{ role, content: [parts] }] array — nothing else. */
function normalizeInput(body: Record<string, unknown>): string | InputTurn[] {
  const images = collectImages(body)
  const rawInput = body.input

  // already an array of turns -> validate and keep
  if (Array.isArray(rawInput)) {
    const turns: InputTurn[] = []
    for (const turn of rawInput) {
      const t = turn as Record<string, unknown>
      const role = typeof t?.role === "string" && t.role.trim() ? t.role.trim() : "user"
      const parts: InputPart[] = []
      const content = t?.content
      if (typeof content === "string") {
        if (content.trim()) parts.push({ type: "input_text", text: content })
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as Record<string, unknown>
          const type = typeof p?.type === "string" ? p.type : ""
          if (type === "input_image") {
            const url = typeof p?.image_url === "string" ? p.image_url.trim() : ""
            if (url) parts.push({ type: "input_image", image_url: url })
            continue
          }
          // input_text / text / output_text all collapse to input_text: that is
          // the only text part Kie's codex input accepts.
          const text =
            typeof p?.text === "string"
              ? p.text
              : typeof p?.content === "string"
                ? (p.content as string)
                : ""
          if (text.trim()) parts.push({ type: "input_text", text })
        }
      }
      if (parts.length) turns.push({ role, content: parts })
    }
    if (!turns.length) throw new Error("input array has no usable text or image parts")
    if (images.length) {
      const last = turns[turns.length - 1]
      for (const url of images) last.content.push({ type: "input_image", image_url: url })
    }
    return turns
  }

  const text =
    (typeof rawInput === "string" && rawInput.trim() && rawInput) ||
    (typeof body.prompt === "string" && body.prompt.trim() && (body.prompt as string)) ||
    "Say hello in one word."

  // no image -> the plain string form (Test A)
  if (!images.length) return String(text)

  // image(s) -> the parts array form (Test B)
  const content: InputPart[] = [{ type: "input_text", text: String(text) }]
  for (const url of images) content.push({ type: "input_image", image_url: url })
  return [{ role: "user", content }]
}

function collectImages(body: Record<string, unknown>): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== "string") return
    const url = v.trim()
    if (/^https:\/\//i.test(url) || /^data:image\//i.test(url)) out.push(url)
  }
  push(body.image_url)
  push(body.imageUrl)
  if (Array.isArray(body.images)) for (const v of body.images) push(v)
  return out.slice(0, 8)
}

function normalizeTools(body: Record<string, unknown>): Array<{ type: string }> {
  const wants =
    body.web_search === true || body.webSearch === true || body.web_search === "true"
  const out: Array<{ type: string }> = []
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const type =
        typeof tool === "string"
          ? tool
          : typeof (tool as Record<string, unknown>)?.type === "string"
            ? ((tool as Record<string, unknown>).type as string)
            : ""
      if (TOOL_TYPES.has(type) && !out.some((t) => t.type === type)) out.push({ type })
    }
  }
  if (wants && !out.some((t) => t.type === "web_search")) out.push({ type: "web_search" })
  return out
}

function normalizeEffort(body: Record<string, unknown>): string | null {
  const fromObj =
    body.reasoning && typeof body.reasoning === "object"
      ? (body.reasoning as Record<string, unknown>).effort
      : undefined
  const candidate =
    (typeof fromObj === "string" && fromObj) ||
    (typeof body.reasoning_effort === "string" && body.reasoning_effort) ||
    (typeof body.reasoningEffort === "string" && body.reasoningEffort) ||
    ""
  const effort = String(candidate).trim().toLowerCase()
  return EFFORTS.has(effort) ? effort : null
}

// ---------------------------------------------------------------------------
//  calling + analysing everything Kie returns
// ---------------------------------------------------------------------------
async function callKie(
  endpoint: string,
  headers: Record<string, string>,
  payload: KiePayload,
): Promise<{ analysis: Analysis }> {
  const started = Date.now()
  let upstream: Response
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
  } catch (err) {
    return {
      analysis: {
        ...emptyAnalysis(),
        ok: false,
        status: 0,
        ms: Date.now() - started,
        error: { type: "network", message: String((err as Error)?.message || err) },
        raw_tail: String((err as Error)?.message || err).slice(0, 500),
      },
    }
  }

  const contentType = upstream.headers.get("content-type")
  const isStream = (contentType || "").includes("event-stream")

  if (!upstream.ok) {
    const detail = await safeText(upstream)
    const parsed = safeJsonParse(detail, null)
    return {
      analysis: {
        ...emptyAnalysis(),
        ok: false,
        status: upstream.status,
        content_type: contentType,
        streamed: isStream,
        ms: Date.now() - started,
        bytes: detail.length,
        error: parsed ?? { message: detail.slice(0, 500) },
        raw_tail: detail.slice(-500),
      },
    }
  }

  const text = await upstream.text()
  const analysis = isStream
    ? analyzeSse(text)
    : analyzeJsonBody(safeJsonParse(text, null), text)

  return {
    analysis: {
      ...analysis,
      ok: true,
      status: upstream.status,
      content_type: contentType,
      streamed: isStream,
      ms: Date.now() - started,
      bytes: text.length,
      raw_tail: text.slice(-500),
    },
  }
}

function emptyAnalysis(): Analysis {
  return {
    ok: false,
    status: 0,
    content_type: null,
    streamed: false,
    ms: 0,
    first_delta_ms: null,
    bytes: 0,
    text: "",
    reasoning: "",
    refusal: "",
    event_count: 0,
    delta_count: 0,
    events_by_type: {},
    event_order: [],
    output_items: [],
    tool_calls: [],
    annotations: [],
    usage: null,
    credits_consumed: null,
    response_id: null,
    response_model: null,
    response_status: null,
    incomplete_details: null,
    error: null,
    unmapped_event_samples: [],
    raw_tail: "",
  }
}

/**
 * Walks the `data:` lines exactly like the reference python client, but keeps
 * every event so an admin can see the whole contract, not only the text:
 *
 *   response.created / response.in_progress          lifecycle
 *   response.output_item.added / .done               items (message, reasoning,
 *                                                    web_search_call, …)
 *   response.content_part.added / .done              content parts
 *   response.output_text.delta / .done               the answer text
 *   response.output_text.annotation.added            web_search citations
 *   response.reasoning_summary_text.delta / .done    visible reasoning
 *   response.refusal.delta / .done                   refusals
 *   response.web_search_call.in_progress/.searching/.completed
 *   response.completed  -> response.usage + response.credits_consumed
 *   response.failed / response.incomplete / error    failures
 *   [DONE]                                           end of stream
 */
function analyzeSse(raw: string): Analysis {
  const a = emptyAnalysis()
  const started = Date.now()
  const lines = raw.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const data = trimmed.slice(5).trim()
    if (!data) continue
    if (data === DONE_SENTINEL) {
      bump(a.events_by_type, "[DONE]")
      if (a.event_order.length < 80) a.event_order.push("[DONE]")
      break
    }

    const ev = safeJsonParse(data, null) as Record<string, unknown> | null
    if (!ev) continue
    const type = typeof ev.type === "string" ? ev.type : "(untyped)"
    a.event_count++
    bump(a.events_by_type, type)
    if (a.event_order.length < 80) a.event_order.push(type)

    switch (type) {
      case DELTA_EVENT: {
        if (typeof ev.delta === "string") {
          if (a.first_delta_ms === null) a.first_delta_ms = Date.now() - started
          a.text += ev.delta
          a.delta_count++
        }
        break
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof ev.delta === "string") a.reasoning += ev.delta
        break
      }
      case "response.refusal.delta": {
        if (typeof ev.delta === "string") a.refusal += ev.delta
        break
      }
      case "response.output_text.annotation.added": {
        if (ev.annotation !== undefined) a.annotations.push(ev.annotation)
        break
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = ev.item as Record<string, unknown> | undefined
        if (item) {
          if (type === "response.output_item.done") a.output_items.push(slimItem(item))
          const itemType = typeof item.type === "string" ? item.type : ""
          if (itemType.includes("search") || itemType.includes("tool") || itemType.includes("call")) {
            a.tool_calls.push(slimItem(item))
          }
        }
        break
      }
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
      case "response.web_search_call.completed": {
        a.tool_calls.push({
          type: "web_search_call",
          stage: type.split(".").pop(),
          item_id: ev.item_id ?? null,
        })
        break
      }
      case "response.created":
      case "response.in_progress":
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const res = ev.response as Record<string, unknown> | undefined
        if (res) {
          if (res.usage !== undefined && res.usage !== null) a.usage = res.usage
          if (res.credits_consumed !== undefined && res.credits_consumed !== null) {
            a.credits_consumed = res.credits_consumed
          }
          if (typeof res.id === "string") a.response_id = res.id
          if (typeof res.model === "string") a.response_model = res.model
          if (typeof res.status === "string") a.response_status = res.status
          if (res.incomplete_details) a.incomplete_details = res.incomplete_details
          if (res.error) a.error = res.error
          if (type === "response.completed" && !a.text) {
            // belt and braces: some deployments only fill the final object
            const finalText = textFromOutput(res.output)
            if (finalText) a.text = finalText
          }
        }
        break
      }
      case "error":
      case "response.error": {
        a.error = ev.error ?? ev
        break
      }
      default: {
        if (
          !type.startsWith("response.content_part") &&
          !type.startsWith("response.output_text.done") &&
          !type.startsWith("response.reasoning") &&
          a.unmapped_event_samples.length < 5
        ) {
          a.unmapped_event_samples.push(ev)
        }
      }
    }
  }
  return a
}

/** Defensive: a JSON (non-SSE) answer, read the same way the docs describe. */
function analyzeJsonBody(body: unknown, raw: string): Analysis {
  const a = emptyAnalysis()
  const b = (body ?? {}) as Record<string, unknown>
  a.text = textFromOutput(b.output)
  a.usage = b.usage ?? null
  a.credits_consumed = b.credits_consumed ?? null
  a.response_id = typeof b.id === "string" ? b.id : null
  a.response_model = typeof b.model === "string" ? b.model : null
  a.response_status = typeof b.status === "string" ? b.status : null
  a.incomplete_details = b.incomplete_details ?? null
  a.error = b.error ?? null
  if (Array.isArray(b.output)) {
    for (const item of b.output) {
      const it = item as Record<string, unknown>
      a.output_items.push(slimItem(it))
      const itemType = typeof it?.type === "string" ? it.type : ""
      if (itemType && itemType !== "message") a.tool_calls.push(slimItem(it))
    }
  }
  if (!a.text && !raw.trim().startsWith("{")) a.raw_tail = raw.slice(-500)
  return a
}

/** output[].content[] where content.type === "output_text" holds the answer. */
function textFromOutput(output: unknown): string {
  if (!Array.isArray(output)) return ""
  let text = ""
  for (const item of output) {
    const content = (item as Record<string, unknown>)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const p = part as Record<string, unknown>
      if (p?.type === "output_text" && typeof p?.text === "string") text += p.text
    }
  }
  return text
}

/** Keep items small: type, id, status and the search query if there is one. */
function slimItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ["type", "id", "status", "name", "query", "action", "role"]) {
    if (item[k] !== undefined) out[k] = item[k]
  }
  if (Array.isArray(item.summary) && item.summary.length) {
    out.summary = item.summary.slice(0, 3)
  }
  return out
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

// ---------------------------------------------------------------------------
//  key bookkeeping
// ---------------------------------------------------------------------------
async function markKey(
  admin: ReturnType<typeof createClient>,
  id: string,
  status: string,
  error: string | null,
) {
  try {
    await admin
      .from("kie_provider_keys")
      .update({ status, last_checked_at: new Date().toISOString(), last_error: error })
      .eq("id", id)
  } catch {
    /* best effort */
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}
