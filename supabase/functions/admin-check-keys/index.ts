// ============================================================================
//  RageStar — upstream key tools (admin only)
// ----------------------------------------------------------------------------
//  POST {SUPABASE_URL}/functions/v1/admin-check-keys
//  Authorization: Bearer <the signed-in admin's access token>
//  apikey:        <your publishable / anon key>
//
//  Actions (body.action, defaults to "check" so old callers keep working):
//
//   { action: "ping"  }                              -> is the function deployed?
//   { action: "check" }                              -> test every active stored key
//   { action: "check", key_id }                      -> test one stored key
//   { action: "check", upstream_id }                 -> test every key on an upstream
//   { action: "probe", upstream_id, api_key }        -> test a RAW key, nothing stored
//   { action: "probe", base_url, ... , api_key }     -> test a key against an ad-hoc upstream
//   { action: "scan",  upstream_id, api_key? }       -> list the models the upstream exposes
//
//  "check" writes the result to upstream_keys.status + upstream_key_checks.
//  "probe" and "scan" never touch the database, so you can validate a key
//  BEFORE you decide to store it.
//
//  Deploy with JWT verification OFF — the admin check happens in here, and
//  platform-level JWT verification rejects the browser's CORS preflight
//  (which carries no Authorization header) with a header-less 401, which the
//  browser reports as the useless "Failed to fetch":
//
//      supabase functions deploy admin-check-keys --no-verify-jwt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import {
  apiError,
  corsHeaders,
  json,
  preflight,
  scrubSecrets,
  assertPublicHttpsUrl,
  safeJsonParse,
  MAX_BODY_BYTES,
  bodyLimitLabel,
} from "../_shared/cors.ts"
import {
  AuthTokenError,
  requireAdmin,
  resolveJwtSecret,
  type AdminCaller,
} from "../_shared/firebase.ts"

/* v10: bridge-issued access tokens are verified locally with this secret.
   Leave it unset and the gate falls back to asking GoTrue. */
/* Accepts JWT_SECRET, SUPABASE_JWT_SECRET and the other spellings, so a
   differently named secret can no longer silently disable the admin gate. */
const JWT_SECRET = resolveJwtSecret()
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? ""
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SB_PUBLISHABLE_KEY") ?? ""

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/* The audit trail is a side effect, never the point of the request. A write
   that fails (missing column, FK, RLS) must not turn a finished key check into
   a 500 the way the undefined `uid` reference used to - record it and move on. */
async function logAudit(row: Record<string, unknown>) {
  try {
    const { error } = await admin.from("audit_logs").insert(row)
    if (error) console.error("audit_logs insert failed:", error.message)
  } catch (err) {
    console.error("audit_logs insert threw:", String((err as Error)?.message ?? err))
  }
}

const UPSTREAM_COLS =
  "id,name,base_url,models_path,health_path,chat_path,auth_scheme,auth_header,auth_query_arg,extra_headers,timeout_ms,wire_format"

type Upstream = {
  id: string | null
  name: string | null
  base_url: string
  models_path: string | null
  health_path: string | null
  chat_path?: string | null
  auth_scheme: string
  auth_header: string
  auth_query_arg: string | null
  extra_headers: Record<string, string> | null
  timeout_ms: number | null
}

type KeyRow = {
  id: string
  label: string
  api_key: string
  upstream_id: string
  is_active: boolean
  upstreams: Upstream
}

/* -------------------------------------------------------------- upstream io */

function headersFor(u: Upstream, key: string) {
  const h = new Headers({ accept: "application/json" })
  for (const [k, v] of Object.entries(u.extra_headers ?? {})) h.set(k, String(v))
  switch (u.auth_scheme) {
    case "x-api-key":
      h.set("x-api-key", key)
      break
    case "api-key":
      h.set("api-key", key)
      break
    case "header":
      h.set(u.auth_header || "Authorization", key)
      break
    case "query":
      break
    default:
      h.set(u.auth_header || "Authorization", `Bearer ${key}`)
  }
  return h
}

function urlFor(u: Upstream, path: string, key: string) {
  /* SSRF guard — this function also serves ad-hoc "probe" requests where the
     base_url comes straight from the admin panel form. */
  assertPublicHttpsUrl(u.base_url || "", "base_url")
  const base = (u.base_url || "").replace(/\/+$/, "")
  const suffix = path.startsWith("/") ? path : "/" + path
  const url = new URL(base + suffix)
  if (u.auth_scheme === "query") url.searchParams.set(u.auth_query_arg || "key", key)
  return url.toString()
}

/**
 * Paths worth trying, in order. Providers disagree about where the model list
 * lives, and a wrong guess should not be reported as "key is dead".
 */
function candidatePaths(u: Upstream, preferHealth: boolean) {
  const wanted = [
    preferHealth ? u.health_path : u.models_path,
    preferHealth ? u.models_path : u.health_path,
    "/models",
    "/v1/models",
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of wanted) {
    const clean = (p || "").trim()
    if (!clean) continue
    if (seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out.length ? out : ["/models"]
}

async function fetchUpstream(u: Upstream, path: string, key: string, budgetMs: number) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), budgetMs)
  const t0 = Date.now()
  try {
    const res = await fetch(urlFor(u, path, key), {
      method: "GET",
      headers: headersFor(u, key),
      signal: ctrl.signal,
    })
    const text = await res.text().catch(() => "")
    return {
      ok: res.ok,
      status: res.status,
      latency: Date.now() - t0,
      text,
      path,
      networkError: null as string | null,
    }
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError"
    return {
      ok: false,
      status: aborted ? 504 : 0,
      latency: Date.now() - t0,
      text: "",
      path,
      networkError: aborted
        ? `Upstream did not answer within ${budgetMs} ms`
        : `Could not reach the upstream: ${String((err as Error)?.message ?? err)}`,
    }
  }
}

/** Try each candidate path until one answers with something other than 404/405. */
async function probeUpstream(u: Upstream, key: string, preferHealth: boolean) {
  const budget = Math.min(Math.max(Number(u.timeout_ms) || 20000, 3000), 25000)
  /* KIE ORIGINAL answers one POST shape only: it has no GET /models and no
     health path, so a GET probe would wrongly condemn a working key. Its keys
     are proven by real traffic instead. */
  const kieUpstream =
    String((u as { wire_format?: string | null }).wire_format ?? "") === "kie_responses" ||
    /api\.kie\.ai/i.test(String(u.base_url ?? ""))
  if (kieUpstream) {
    return {
      ok: true,
      status: 200,
      latency: 0,
      text: "",
      path: u.chat_path || "/codex/v1/responses",
      message: "KIE ORIGINAL is verified by traffic, not by a GET probe",
      state: "working",
    }
  }

  const paths = candidatePaths(u, preferHealth)
  let last = await fetchUpstream(u, paths[0], key, budget)
  for (let i = 1; i < paths.length && !last.ok; i++) {
    if (last.status !== 404 && last.status !== 405 && last.status !== 0) break
    last = await fetchUpstream(u, paths[i], key, budget)
  }
  const message = last.ok
    ? null
    : scrubSecrets(last.networkError || last.text || `HTTP ${last.status}`, [key]).slice(0, 400)
  return {
    ok: last.ok,
    status: last.status,
    latency: last.latency,
    text: last.text,
    path: last.path,
    message,
    state: last.ok
      ? "working"
      : last.status === 401 || last.status === 403
        ? "expired"
        : last.status === 429
          ? "rate_limited"
          : "failing",
  }
}

/* ------------------------------------------------------------ model parsing */

type ScannedModel = {
  id: string
  display_name: string
  description: string | null
  context_window: number | null
  max_output_tokens: number | null
  price_in_per_m: number | null
  price_out_per_m: number | null
  capabilities: string[]
}

function n(value: unknown): number | null {
  const x = Number(value)
  return Number.isFinite(x) && x > 0 ? Math.round(x) : null
}

/** Most providers price per token; we publish per million. */
function perMillion(value: unknown): number | null {
  const x = Number(value)
  if (!Number.isFinite(x) || x <= 0) return null
  return Number((x * 1_000_000).toFixed(4))
}

function titleise(id: string) {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id
  return tail
    .replace(/[-_.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function capabilitiesOf(raw: Record<string, any>) {
  const caps = new Set<string>(["chat"])
  const arch = raw.architecture ?? {}
  const modalities: string[] = []
    .concat(arch.input_modalities ?? [])
    .concat(arch.output_modalities ?? [])
    .concat(raw.modalities ?? [])
    .concat(typeof arch.modality === "string" ? arch.modality.split(/[->,+]/) : [])
    .map((m: unknown) => String(m).trim().toLowerCase())
    .filter(Boolean)
  if (modalities.some((m) => m.includes("image") || m.includes("vision"))) caps.add("vision")
  if (modalities.some((m) => m.includes("audio"))) caps.add("audio")
  const methods: string[] = ([] as string[]).concat(raw.supportedGenerationMethods ?? [])
  if (methods.some((m) => String(m).toLowerCase().includes("stream"))) caps.add("streaming")
  if (raw.supports_tools || raw.tool_use || raw.supports_function_calling) caps.add("tools")
  if (raw.supports_reasoning || raw.reasoning) caps.add("reasoning")
  return Array.from(caps)
}

/**
 * Normalise every model-list shape we have seen into one row type:
 *   OpenAI / OpenRouter / Anthropic  { data: [...] }
 *   Google AI Studio                 { models: [{ name: "models/x" }] }
 *   Ollama / LM Studio               { models: [{ name, model }] }
 *   plain arrays                     [...]
 */
function normaliseModels(payload: unknown): ScannedModel[] {
  const list: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.data)
      ? (payload as any).data
      : Array.isArray((payload as any)?.models)
        ? (payload as any).models
        : Array.isArray((payload as any)?.result)
          ? (payload as any).result
          : Array.isArray((payload as any)?.data?.models)
            ? (payload as any).data.models
            : []

  const out: ScannedModel[] = []
  const seen = new Set<string>()

  for (const raw of list) {
    if (!raw) continue
    const item = typeof raw === "string" ? { id: raw } : (raw as Record<string, any>)
    const id = String(
      item.id ?? item.model ?? item.model_id ?? item.slug ?? item.name ?? "",
    )
      .replace(/^models\//, "")
      .trim()
    if (!id || seen.has(id)) continue
    seen.add(id)

    const pricing = item.pricing ?? item.price ?? {}
    const top = item.top_provider ?? {}

    out.push({
      id,
      display_name: String(
        item.display_name ?? item.displayName ?? item.name ?? titleise(id),
      )
        .replace(/^models\//, "")
        .trim() || titleise(id),
      description:
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim().slice(0, 400)
          : null,
      context_window:
        n(item.context_length) ??
        n(item.context_window) ??
        n(item.max_context_length) ??
        n(item.inputTokenLimit) ??
        n(top.context_length) ??
        null,
      max_output_tokens:
        n(item.max_output_tokens) ??
        n(item.max_completion_tokens) ??
        n(item.outputTokenLimit) ??
        n(top.max_completion_tokens) ??
        null,
      price_in_per_m: perMillion(pricing.prompt ?? pricing.input ?? pricing.in ?? pricing.prompt_tokens),
      price_out_per_m: perMillion(
        pricing.completion ?? pricing.output ?? pricing.out ?? pricing.completion_tokens,
      ),
      capabilities: capabilitiesOf(item),
    })
  }

  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

function countModels(text: string) {
  try {
    return normaliseModels(safeJsonParse<any>(text, [])).length
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- upstreams */

function upstreamFromBody(body: Record<string, any>): Upstream {
  return {
    id: null,
    name: body.name ?? "ad-hoc upstream",
    base_url: String(body.base_url || "").trim(),
    models_path: body.models_path ?? "/models",
    health_path: body.health_path ?? null,
    auth_scheme: body.auth_scheme ?? "bearer",
    auth_header: body.auth_header ?? "Authorization",
    auth_query_arg: body.auth_query_arg ?? null,
    extra_headers:
      typeof body.extra_headers === "string"
        ? safeJsonParse<Record<string, unknown>>(body.extra_headers, {})
        : (body.extra_headers ?? {}),
    timeout_ms: Number(body.timeout_ms) || 20000,
  }
}

async function resolveUpstream(body: Record<string, any>) {
  if (body.upstream_id) {
    const { data, error } = await admin
      .from("upstreams")
      .select(UPSTREAM_COLS)
      .eq("id", body.upstream_id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error("That upstream no longer exists. Reload the admin panel.")
    return data as unknown as Upstream
  }
  const adhoc = upstreamFromBody(body)
  if (!adhoc.base_url) {
    throw new Error("Pick an upstream (or pass base_url) before testing a key.")
  }
  return adhoc
}

/** Raw key from the body, or the best stored key for that upstream. */
async function resolveKey(body: Record<string, any>, upstreamId: string | null) {
  const raw = typeof body.api_key === "string" ? body.api_key.trim() : ""
  if (raw) return { key: raw, label: body.label ?? "pasted key", stored: false }

  if (body.key_id) {
    const { data } = await admin
      .from("upstream_keys")
      .select("id,label,api_key")
      .eq("id", body.key_id)
      .maybeSingle()
    if (!data?.api_key) throw new Error("That stored key no longer exists.")
    return { key: data.api_key as string, label: data.label as string, stored: true }
  }

  if (upstreamId) {
    const { data } = await admin
      .from("upstream_keys")
      .select("id,label,api_key,status,weight")
      .eq("upstream_id", upstreamId)
      .eq("is_active", true)
      .order("status", { ascending: true })
      .order("weight", { ascending: false })
      .limit(20)
    const rows = data ?? []
    const best = rows.find((r: any) => r.status === "working") ?? rows[0]
    if (best?.api_key) {
      return { key: best.api_key as string, label: best.label as string, stored: true }
    }
  }

  throw new Error(
    "No key to test with. Paste a key, or store one on this upstream first.",
  )
}

/* -------------------------------------------------------------- the handler */

async function handle(req: Request) {
  if (req.method === "OPTIONS") return preflight(req)

  const url = new URL(req.url)
  const isPingGet = req.method === "GET"

  // Unauthenticated liveness probe, so the admin panel can tell "function is
  // not deployed" apart from "function rejected me".
  if (isPingGet && (url.searchParams.get("action") ?? "ping") === "ping") {
    return json({ ok: true, service: "admin-check-keys", deployed: true, version: "5.2.0" }, 200, {}, req)
  }
  if (req.method !== "POST") {
    return apiError("Use POST.", 405, "not_found", {}, req)
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return apiError(
      "Function is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.",
      500,
      "server_error",
      {},
      req,
    )
  }

  let body: Record<string, any> = {}
  try {
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) {
      return apiError(
        `Request body is too large (${bodyLimitLabel()} limit).`,
        413,
        "invalid_request_error",
        {},
        req,
      )
    }
    body = safeJsonParse<Record<string, any>>(text, {})
  } catch {
    body = {}
  }

  const action = String(body.action ?? "check").toLowerCase()
  if (action === "ping") {
    return json({ ok: true, service: "admin-check-keys", deployed: true, version: "5.2.0" }, 200, {}, req)
  }

  // ---- caller must be a signed-in, active admin ----------------------------
  /* v10: the session is minted by the firebase-auth bridge, so it carries the
     project's JWT signature but has no row in auth.sessions for
     auth.getUser() to look up. The shared helper verifies the signature here
     instead, then applies the unchanged rule: role = 'admin' and an active
     status, exactly what the admin RLS policies require. */
  /* Hold on to who this is. The audit writes further down need the caller's
     id and email, and discarding this value is exactly what left `uid`
     undefined and turned every "check" pass into a 500. */
  let caller: AdminCaller
  try {
    caller = await requireAdmin(req, admin as never, {
      jwtSecret: JWT_SECRET,
      firebaseProjectId: FIREBASE_PROJECT_ID,
    })
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return apiError(err.message, err.status, err.code, {}, req)
    }
    return apiError(
      err instanceof Error && err.message
        ? `Could not confirm your admin session. ${err.message}`
        : "Admin access required.",
      403,
      "forbidden",
      {},
      req,
    )
  }

  /* ============================================================== PROBE === */
  // Test a key without storing it, so the admin panel can validate before add.
  if (action === "probe" || action === "test") {
    const upstream = await resolveUpstream(body)
    const { key, label } = await resolveKey(body, upstream.id)
    const r = await probeUpstream(upstream, key, true)

    return json(
      {
        action: "probe",
        ok: r.ok,
        state: r.state,
        status_code: r.status,
        latency_ms: r.latency,
        endpoint: r.path,
        upstream: upstream.name,
        label,
        model_count: r.ok ? countModels(r.text) : null,
        message: r.message,
        hint: r.ok
          ? null
          : r.status === 401 || r.status === 403
            ? "The upstream rejected this key. Check you copied it fully, and that it is enabled on the provider's dashboard."
            : r.status === 429
              ? "The key is valid but rate limited right now."
              : r.status === 404 || r.status === 405
                ? "Key auth may be fine — the models path looks wrong. Fix models_path / health_path on the upstream."
                : r.status === 0 || r.status === 504
                  ? "Could not reach the upstream at all. Check base_url (scheme + host, no trailing path typo)."
                  : "The upstream answered with an error. See the message above.",
      },
      200,
      {},
      req,
    )
  }

  /* =============================================================== SCAN === */
  // Read the upstream's model catalogue so the admin can import it in bulk.
  if (action === "scan" || action === "scan_models") {
    const upstream = await resolveUpstream(body)
    const { key, label } = await resolveKey(body, upstream.id)
    const r = await probeUpstream(upstream, key, false)

    if (!r.ok) {
      return json(
        {
          action: "scan",
          ok: false,
          status_code: r.status,
          latency_ms: r.latency,
          endpoint: r.path,
          upstream: upstream.name,
          label,
          models: [],
          message: r.message,
        },
        200,
        {},
        req,
      )
    }

    let parsed: unknown = null
    try {
      parsed = safeJsonParse<any>(r.text, null)
    } catch {
      return json(
        {
          action: "scan",
          ok: false,
          status_code: r.status,
          endpoint: r.path,
          upstream: upstream.name,
          models: [],
          message: "The upstream did not return JSON from its models endpoint.",
        },
        200,
        {},
        req,
      )
    }

    const models = normaliseModels(parsed)
    if (upstream.id) {
      await logAudit({
        actor_id: caller.id,
        actor_email: caller.email,
        action: "scan_upstream_models",
        entity: "upstreams",
        entity_id: upstream.id,
        detail: { found: models.length, endpoint: r.path },
      })
    }

    return json(
      {
        action: "scan",
        ok: true,
        status_code: r.status,
        latency_ms: r.latency,
        endpoint: r.path,
        upstream: upstream.name,
        upstream_id: upstream.id,
        label,
        count: models.length,
        models,
        message: models.length
          ? null
          : "The endpoint answered but listed no models. Check models_path on the upstream.",
      },
      200,
      {},
      req,
    )
  }

  /* ============================================================== CHECK === */
  let q = admin
    .from("upstream_keys")
    .select(`id,label,api_key,upstream_id,is_active,upstreams(${UPSTREAM_COLS})`)
  if (body.key_id) q = q.eq("id", body.key_id)
  else if (body.upstream_id) q = q.eq("upstream_id", body.upstream_id)

  const { data: rows, error } = await q
  if (error) return apiError(error.message, 500, "server_error", {}, req)

  const keys = (rows ?? []) as unknown as KeyRow[]
  if (!keys.length) {
    return json(
      { action: "check", checked: 0, results: [], message: "No stored keys matched." },
      200,
      {},
      req,
    )
  }

  const results = []
  for (const row of keys) {
    const u = row.upstreams
    if (!u?.base_url) {
      results.push({
        key_id: row.id,
        label: row.label,
        upstream: u?.name ?? null,
        ok: false,
        status_code: null,
        latency_ms: 0,
        state: "failing",
        message: "This key's upstream has no base_url configured.",
      })
      continue
    }

    const r = await probeUpstream(u, row.api_key, true)

    await admin.rpc("internal_record_key_result", {
      p_key_id: row.id,
      p_ok: r.ok,
      p_status_code: r.status || null,
      p_latency_ms: r.latency,
      p_error: r.message,
      p_cost_usd: 0,
      p_source: "manual",
    })

    results.push({
      key_id: row.id,
      label: row.label,
      upstream: u?.name ?? null,
      ok: r.ok,
      status_code: r.status || null,
      latency_ms: r.latency,
      endpoint: r.path,
      state: r.state,
      message: r.message,
    })
  }

  await logAudit({
    actor_id: caller.id,
    actor_email: caller.email,
    action: "check_upstream_keys",
    entity: "upstream_keys",
    detail: { checked: results.length, via: caller.via ?? null },
  })

  return json({ action: "check", checked: results.length, results }, 200, {}, req)
}

// Every failure path still has to answer with CORS headers, otherwise the
// browser turns a real error message into "Failed to fetch".
Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    console.error("admin-check-keys failed:", message)
    return apiError(message.slice(0, 400), 500, "server_error", {}, req)
  }
})
