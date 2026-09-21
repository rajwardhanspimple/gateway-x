// ============================================================================
//  RageStar — public API gateway (Supabase Edge Function)
// ----------------------------------------------------------------------------
//  Your users call:   POST {SUPABASE_URL}/functions/v1/router/v1/chat/completions
//                     Authorization: Bearer rs_live_…   (a key minted by YOU)
//
//  This function:
//    1. authenticates the rr_ key against public.api_keys (sha256 hash)
//    2. resolves the requested PUBLIC model id -> hidden upstream + real model id
//    3. picks the healthiest upstream API key you stored in upstream_keys
//    4. forwards the request to the original API, stripping every header that
//       could identify it, and rewrites the model id in the response
//    5. fails over to the next key / next route on error
//    6. logs usage + marks each upstream key working / failing / expired
//
//  The caller never receives the upstream host, name, model id, or key.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import {
  CORS_HEADERS,
  apiError,
  json,
  requestId,
  sha256Hex,
  assertPublicHttpsUrl,
  MAX_BODY_BYTES,
  bodyLimitLabel,
  clampStoredPayload,
} from "../_shared/cors.ts"
import { applyCompressors, type Compressor } from "../_shared/compress.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/* ---------------------------------------------------------------- client IP
   IP limits are only as good as the address they are fed, so the header we
   trust matters:

     - behind Cloudflare (gw.ragestar.bond) the real caller sits in
       `cf-connecting-ip`, which Cloudflare overwrites on every request
     - a client hitting the raw *.supabase.co URL can invent that header, so
       it is only trusted when the request also carries the shared secret the
       Cloudflare Worker injects (RS_EDGE_SECRET)
     - with RS_REQUIRE_EDGE_SECRET=true the gateway refuses anything that did
       not come through your own domain

   supabase secrets set RS_EDGE_SECRET="<long-random-string>"
   supabase secrets set RS_REQUIRE_EDGE_SECRET=true                        */
const EDGE_SECRET = Deno.env.get("RS_EDGE_SECRET") ?? ""
const REQUIRE_EDGE_SECRET =
  (Deno.env.get("RS_REQUIRE_EDGE_SECRET") ?? "").toLowerCase() === "true"

function fromEdge(req: Request) {
  return EDGE_SECRET.length > 0 && req.headers.get("x-rs-edge-secret") === EDGE_SECRET
}

function clientIpOf(req: Request): string | null {
  const cf = (req.headers.get("cf-connecting-ip") ?? "").trim()
  if (cf && (fromEdge(req) || !EDGE_SECRET)) return cf

  const xff = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (xff.length) return xff[0]

  const real = (req.headers.get("x-real-ip") ?? "").trim()
  return real || null
}

import {
  bridgeKie,
  dialectOf,
  harnessOf,
  toKiePayload,
} from "../_shared/kie.ts"

type Candidate = {
  model_id: string
  public_id: string
  upstream_model_id: string
  price_in_per_m: number
  price_out_per_m: number
  upstream_id: string
  base_url: string
  chat_path: string
  /* 'kie_responses' means KIE ORIGINAL: one shape, /codex/v1/responses. */
  wire_format?: string | null
  auth_scheme: string
  auth_header: string
  auth_query_arg: string | null
  extra_headers: Record<string, string>
  /* How long we wait for THIS model on THIS provider, in ms. The database
     resolves it as model.timeout_ms -> upstream.timeout_ms ->
     app_settings.default_timeout_ms, so the most specific setting wins. */
  timeout_ms: number
  /* How many DIFFERENT keys of this provider one request may try. */
  max_key_attempts: number
  /* Whether running out of time is allowed to rotate to another key. */
  retry_on_timeout: boolean
  keys_available: number
}

type UpstreamKey = {
  key_id: string
  api_key: string
  status: string
  label: string | null
  timeout_count: number
  cooling: boolean
}

/** Remove anything that could identify the original API from a string. */
function scrub(text: string, secrets: string[]) {
  let out = text ?? ""
  for (const s of secrets) {
    if (s && s.length > 3) out = out.split(s).join("[redacted]")
  }
  return out
}

function buildUpstreamUrl(c: Candidate, path: string, key: string) {
  /* SSRF guard: never forward to a loopback or private host, even if such a
     base_url was saved before the v5.5 database trigger existed. */
  assertPublicHttpsUrl(c.base_url, "upstream base_url")
  const base = c.base_url.replace(/\/+$/, "")
  const suffix = path.startsWith("/") ? path : "/" + path
  const url = new URL(base + suffix)
  if (c.auth_scheme === "query") url.searchParams.set(c.auth_query_arg || "key", key)
  return url.toString()
}

function buildUpstreamHeaders(c: Candidate, key: string) {
  const h = new Headers({ "content-type": "application/json", accept: "application/json" })
  for (const [k, v] of Object.entries(c.extra_headers ?? {})) h.set(k, String(v))
  switch (c.auth_scheme) {
    case "bearer":
      h.set(c.auth_header || "Authorization", `Bearer ${key}`)
      break
    case "x-api-key":
      h.set("x-api-key", key)
      break
    case "api-key":
      h.set("api-key", key)
      break
    case "header":
      h.set(c.auth_header || "Authorization", key)
      break
    case "query":
      break
    default:
      h.set("Authorization", `Bearer ${key}`)
  }
  return h
}

/** Rewrite the hidden model id back to the public one, everywhere. */
function maskBody(text: string, realModel: string, publicModel: string, secrets: string[]) {
  let out = realModel ? text.split(realModel).join(publicModel) : text
  return scrub(out, secrets)
}

function costOf(c: Candidate, inTok: number, outTok: number) {
  const a = (Number(c.price_in_per_m) || 0) * (inTok / 1_000_000)
  const b = (Number(c.price_out_per_m) || 0) * (outTok / 1_000_000)
  return Number((a + b).toFixed(6))
}

async function logRequest(payload: Record<string, unknown>) {
  try {
    /* v12.15: the two payload texts ride in their own named arguments so the
       database can store them in public.request_payloads; every other field
       stays in p_payload exactly as before. A call refused before it reached a
       model (auth, gate, IP, budget) passes neither text, so it writes no
       payload row — the log entry is all there is. */
    const { request_body, response_text, ...meta } = payload
    await admin.rpc("internal_log_request", {
      p_payload: meta,
      p_request_body: (request_body as string | null | undefined) ?? null,
      p_response_text: (response_text as string | null | undefined) ?? null,
    })
  } catch (_) {
    /* logging must never break a response */
  }
}

async function recordKey(
  keyId: string,
  ok: boolean,
  status: number | null,
  latency: number | null,
  error: string | null,
  cost = 0,
  timedOut = false,
) {
  try {
    await admin.rpc("internal_record_key_result", {
      p_key_id: keyId,
      p_ok: ok,
      p_status_code: status,
      p_latency_ms: latency,
      p_error: error,
      p_cost_usd: cost,
      p_source: "traffic",
      /* A stall is not a bad key: it is recorded separately and puts the key
         in a short cooldown so the next caller is not made to wait too. */
      p_timed_out: timedOut,
    })
  } catch (_) {
    /* ignore */
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const rid = requestId()
  const url = new URL(req.url)
  // strip the function name so both /functions/v1/router/v1/... and /v1/... work
  const path = url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/router/, "") || "/"

  if (path === "/" || path === "/health") {
    return json({ status: "ok", service: "RageStar gateway", request_id: rid })
  }

  /* Optional lock-down: only traffic proxied by your own domain is served, so
     nobody can bypass the Cloudflare edge (and its IP rules) by calling the
     raw Supabase function URL. */
  if (REQUIRE_EDGE_SECRET && !fromEdge(req)) {
    return apiError(
      "Call the gateway on its public domain (https://gw.ragestar.bond/v1).",
      403,
      "forbidden_endpoint",
      { "x-rs-request-id": rid },
    )
  }

  /* Every log line records the caller address: it powers the per-IP limits,
     the abuse report in the admin panel and the auto-ban list. */
  const clientIp = clientIpOf(req)
  /* Which dialect the caller speaks, and which harness it is. One KIE
     ORIGINAL upstream serves Claude Code, Codex and the SDKs at once, so
     this is the only way to tell the traffic apart afterwards. */
  const dialect = dialectOf(new URL(req.url).pathname)
  const harness = harnessOf(req, dialect)
  const log = (payload: Record<string, unknown>) =>
    logRequest({ ...payload, client_ip: clientIp, dialect, harness })

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return apiError("Gateway is not configured", 500, "server_error", { "x-rs-request-id": rid })
  }

  // ---- 1. authenticate the caller's rr_ key --------------------------------
  /* Claude Code sends x-api-key, Codex and the OpenAI SDKs send Authorization,
     other harnesses send anthropic-api-key. All carry the same rs_ key. */
  const auth =
    req.headers.get("authorization") ??
    req.headers.get("Authorization") ??
    req.headers.get("x-api-key") ??
    req.headers.get("anthropic-api-key") ??
    ""
  const presented = auth.replace(/^Bearer\s+/i, "").trim()
  if (!presented || !(presented.startsWith("rs_") || presented.startsWith("rr_"))) {
    return apiError(
      "Missing API key. Send `Authorization: Bearer rs_live_…`.",
      401,
      "invalid_api_key",
      { "x-rs-request-id": rid },
    )
  }

  const hash = await sha256Hex(presented)
  const { data: authData, error: authErr } = await admin.rpc("internal_auth_key", {
    p_key_hash: hash,
  })
  if (authErr || !authData) {
    return apiError("Invalid API key.", 401, "invalid_api_key", { "x-rs-request-id": rid })
  }

  const acct = authData as Record<string, any>
  if (acct.status !== "active") {
    /* v12.17: every refusal AFTER authentication is now logged — before this,
       a revoked key or an exhausted budget vanished without a trace, so the
       admin panel under-reported traffic the caller definitely made. The
       user/key ids are known here, so the row is attributed. */
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 401,
      error_code: "invalid_api_key",
      error_message: `API key is ${acct.status}.`,
    })
    return apiError(`API key is ${acct.status}.`, 401, "invalid_api_key", { "x-rs-request-id": rid })
  }
  if (acct.user_status !== "active") {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 403,
      error_code: "account_suspended",
      error_message: "Account is suspended.",
    })
    return apiError("Account is suspended.", 403, "account_suspended", { "x-rs-request-id": rid })
  }
  if (acct.expires_at && new Date(acct.expires_at) < new Date()) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 401,
      error_code: "api_key_expired",
      error_message: "API key has expired.",
    })
    return apiError("API key has expired.", 401, "api_key_expired", { "x-rs-request-id": rid })
  }

  const budget = Number(acct.monthly_budget_usd ?? acct.user_budget_usd ?? 0)
  if (budget > 0 && Number(acct.month_spend_usd ?? 0) >= budget) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 402,
      error_code: "budget_exceeded",
      error_message: "Monthly budget exhausted for this key.",
    })
    return apiError("Monthly budget exhausted for this key.", 402, "budget_exceeded", {
      "x-rs-request-id": rid,
    })
  }

  /* ---- credits -------------------------------------------------------------
     internal_auth_key reports the account's prepaid balance and whether this
     workspace enforces credits. When it does, refuse the call here — before a
     single token is bought upstream. overdraft_usd allows a configured amount
     of going negative (0 = hard stop at zero). Charging happens afterwards in
     internal_log_request(), which debits the exact metered cost. */
  const creditsEnabled = acct.credits_enabled === true
  const balance = Number(acct.credit_balance_usd ?? 0)
  const overdraft = Math.abs(Number(acct.credit_overdraft_usd ?? 0))
  if (creditsEnabled && balance <= -overdraft) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 402,
      error_code: "insufficient_credits",
      error_message: "Out of credits. Top up this account's balance to keep using the gateway.",
    })
    return apiError(
      "Out of credits. Top up this account's balance to keep using the gateway.",
      402,
      "insufficient_credits",
      { "x-rs-request-id": rid, "x-rs-credits-usd": balance.toFixed(6) },
    )
  }

  /* ---- Discord gate (v12.9) -------------------------------------------------
     When the workspace switches discord_required on, an account may only call
     the API with a linked Discord account that is also a member of the
     community server. The verdict lives in the database (discord_identities is
     written only by the discord-auth function), so membership cannot be forged
     from the browser. Same fail-open rule as the window check below: a missing
     migration must never take the API down. Refusal mirrors the credit check
     above — a named 403 before any upstream spend. */
  let gateVerdict: unknown = null;
  let gateErr: unknown = null;
  try {
    const gateRes = await admin.rpc("internal_discord_gate", {
      p_user_id: acct.user_id,
    });
    gateVerdict = gateRes.data;
    gateErr = gateRes.error;
  } catch (err) {
    gateErr = err;
  }
  const gate = (gateVerdict ?? {}) as Record<string, unknown>;
  if (!gateErr && gate.allowed === false) {
    /* v12.17: a Discord-gate refusal is the most common silent death when
       discord_required is on — log it so the caller can see why traffic
       stopped, in the same surface as every other refusal. */
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 403,
      error_code: String(gate.code ?? "discord_required"),
      error_message: String(
        gate.reason ??
          "This workspace requires a linked Discord account that is in the community server.",
      ),
    })
    return apiError(
      String(
        gate.reason ??
          "This workspace requires a linked Discord account that is in the community server.",
      ),
      403,
      String(gate.code ?? "discord_required"),
      { "x-rs-request-id": rid },
    )
  }

  /* ---- spend windows (v12.5) ------------------------------------------------
     Rolling caps per account: five_hour_limit_usd / weekly_limit_usd on
     app_settings, 0 = unlimited. The DB does the arithmetic in one round
     trip; we refuse before buying a token upstream, like the credit check
     above. If the RPC is missing (upgrade not applied) or errors we fail
     open - a broken gate must never take the API down.                  */
  let winVerdict: unknown = null;
  let winErr: unknown = null;
  try {
    const winRes = await admin.rpc("internal_window_check", {
      p_user_id: acct.user_id,
    });
    winVerdict = winRes.data;
    winErr = winRes.error;
  } catch (err) {
    winErr = err;
  }
  const winCheck = (winVerdict ?? {}) as Record<string, unknown>;
  if (!winErr && winCheck.ok === false) {
    const code = String(winCheck.code ?? "window_limit_exceeded");
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 429,
      error_code: code,
      error_message: String(winCheck.reason ?? code),
    });
    return apiError(
      String(winCheck.reason ?? "Spend window limit reached."),
      429,
      code,
      {
        "x-rs-request-id": rid,
        "x-rs-five-hour-usd": String(winCheck.five_hour_used_usd ?? ""),
        "x-rs-weekly-usd": String(winCheck.weekly_used_usd ?? ""),
      },
    );
  }

  /* ---- community participation ---------------------------------------------
     The workspace can require a daily check-in: open the portal, post a couple
     of messages, and the gateway answers. Until then it does not. The rule
     lives in the database (public.admin_save_community_gate), not here, so it
     can be relaxed or switched off without a redeploy. If the check itself
     errors we fail open - a broken gate must never take the API down.       */
  let commVerdict: unknown = null;
  let commErr: unknown = null;
  try {
    const commRes = await admin.rpc("internal_community_gate", {
      p_user_id: acct.user_id,
    });
    commVerdict = commRes.data;
    commErr = commRes.error;
  } catch (err) {
    commErr = err;
  }
  const commGate = (commVerdict ?? {}) as Record<string, unknown>;
  if (!commErr && commGate.allowed === false) {
    const commCode = String(commGate.code ?? "community_participation_required");
    const commWhy = String(
      commGate.reason ??
        "Post in the community portal today to keep using the gateway.",
    );
    /* v12.10: a policy denial, not an upstream failure — the health and
       success-rate queries exclude it, and it shows in its own surface
       instead of Request logs. v12.17: awaited, so the row is guaranteed to
       be written before the response goes back. */
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 403,
      error_code: commCode,
      error_message: commWhy,
      community_gate_denied: true,
    });
    return apiError(commWhy, 403, commCode, {
      "x-rs-request-id": rid,
      "x-rs-community-required": String(commGate.required ?? ""),
      "x-rs-community-sent": String(commGate.sent_today ?? ""),
    });
  }

  /* ---- IP limits -----------------------------------------------------------
     internal_ip_check() enforces, in one round trip: the ban list, the
     workspace denylist, this key's IP allowlist, the per-IP requests/minute
     ceiling and the "one key from too many addresses" guard. Nothing is
     enforced until you set a number, so an untouched workspace behaves exactly
     as before. */
  const { data: ipVerdict, error: ipErr } = await admin.rpc("internal_ip_check", {
    p_api_key_id: acct.api_key_id,
    p_ip: clientIp,
  })
  const ipCheck = (ipVerdict ?? {}) as Record<string, unknown>
  if (!ipErr && ipCheck.allowed === false) {
    const code = String(ipCheck.code ?? "ip_not_allowed")
    const status =
      code === "ip_rate_limit_exceeded" || code === "ip_fanout_exceeded" ? 429 : 403
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: status,
      error_code: code,
      error_message: String(ipCheck.reason ?? code),
    })
    return apiError(
      String(ipCheck.reason ?? "This IP address is not allowed to use this key."),
      status,
      code,
      {
        "x-rs-request-id": rid,
        ...(status === 429 ? { "retry-after": String(ipCheck.retry_after ?? 5) } : {}),
      },
    )
  }

  const { data: underLimit } = await admin.rpc("internal_rate_check", {
    p_api_key_id: acct.api_key_id,
    p_limit: acct.rate_limit_rpm ?? 120,
  })
  if (underLimit === false) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      ok: false,
      status_code: 429,
      error_code: "rate_limit_exceeded",
      error_message: "Rate limit exceeded. Slow down.",
    })
    return apiError("Rate limit exceeded. Slow down.", 429, "rate_limit_exceeded", {
      "x-rs-request-id": rid,
      "retry-after": "5",
    })
  }

  /* ---- early access (v12.4) ------------------------------------------------
     A model can be marked access_tier = 'early_access'. Only accounts whose
     role is early_access or admin may list or call it. The router runs as
     service_role, so auth.uid() is null here and entitlement has to be read
     from the key's owner. Wrapped in try/catch on purpose: if
     upgrade-v12.4-early-access.sql has not been applied the RPC is missing,
     and nothing is gated because nothing can be marked yet. */
  let earlyAccess = false
  let restrictedModels: string[] = []
  try {
    const { data: access } = await admin.rpc("internal_access_context", {
      p_user_id: acct.user_id,
    })
    if (access && typeof access === "object") {
      earlyAccess = Boolean((access as any).early_access)
      const list = (access as any).restricted
      if (Array.isArray(list)) restrictedModels = list.map((v: any) => String(v))
    }
  } catch (_) {
    /* early access not installed — every model stays public */
  }

  // ---- 2. model catalogue (public ids only) --------------------------------
  if (path === "/v1/models" || path === "/models") {
    let models: any[] | null = null
    try {
      const { data: mine } = await admin.rpc("internal_models_for_user", {
        p_user_id: acct.user_id,
      })
      if (Array.isArray(mine)) models = mine as any[]
    } catch (_) {
      /* fall through to the plain catalogue read */
    }
    if (!models) {
      const { data: rows } = await admin
        .from("public_models")
        .select("id,name,description,context_window,price_in_per_m,price_out_per_m,capabilities,status")
        .order("sort_order", { ascending: true })
      models = (rows ?? []).filter((m: any) => !restrictedModels.includes(m.id))
    }
    return json(
      {
        object: "list",
        data: (models ?? []).map((m: any) => ({
          id: m.id,
          object: "model",
          owned_by: "RageStar",
          created: 0,
          name: m.name,
          description: m.description,
          context_window: m.context_window,
          pricing: { input_per_million: m.price_in_per_m, output_per_million: m.price_out_per_m },
          capabilities: m.capabilities,
          status: m.status,
          access_tier: m.access_tier ?? "public",
        })),
      },
      200,
      { "x-rs-request-id": rid },
    )
  }

  /* Four dialects, one gateway: /chat/completions (SDKs, Cursor, Cline),
     /messages (Claude Code), /responses (Codex CLI), /completions. */
  const isChat = dialect === "chat" || dialect === "messages" || dialect === "responses"
  const isCompletion = dialect === "completions"
  const isEmbedding = dialect === "embeddings"
  const knownRoute =
    path.endsWith("/chat/completions") ||
    path.endsWith("/completions") ||
    path.endsWith("/embeddings") ||
    path.endsWith("/messages") ||
    path.endsWith("/responses")
  if (!knownRoute) {
    return apiError(`Unknown route ${path}`, 404, "not_found", { "x-rs-request-id": rid })
  }
  if (req.method !== "POST") {
    return apiError("Method not allowed", 405, "not_found", { "x-rs-request-id": rid })
  }

  // ---- 3. parse body -------------------------------------------------------
  let body: Record<string, any>
  /* Declared out here (v12.15) so both response logs can store the exact bytes
     the caller sent, without reading the request a second time. */
  let rawBody = ""
  try {
    rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return apiError(
        `Request body is too large (${bodyLimitLabel()} limit).`,
        413,
        "invalid_request_error",
        {
          "x-rs-request-id": rid,
        },
      )
    }
    body = JSON.parse(rawBody)
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not-an-object")
  } catch {
    return apiError("Body must be valid JSON.", 400, "invalid_request_error", {
      "x-rs-request-id": rid,
    })
  }

  const requested = String(body.model ?? req.headers.get("x-rs-policy") ?? "auto")
  const streaming = body.stream === true

  const allowed: string[] = acct.allowed_models ?? []
  if (allowed.length && !requested.startsWith("auto") && !allowed.includes(requested)) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      model_public_id: requested,
      policy: requested,
      ok: false,
      status_code: 403,
      error_code: "model_not_allowed",
      error_message: `Model \`${requested}\` is not enabled for this key.`,
    })
    return apiError(`Model \`${requested}\` is not enabled for this key.`, 403, "model_not_allowed", {
      "x-rs-request-id": rid,
    })
  }

  /* Named an early access model without the role? Say so, rather than letting
     it fall through to the generic "no route available" below. */
  if (!requested.startsWith("auto") && restrictedModels.includes(requested)) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      model_public_id: requested,
      policy: requested,
      ok: false,
      status_code: 403,
      error_code: "early_access_required",
      error_message: `Model \`${requested}\` is in early access.`,
    })
    return apiError(
      `Model \`${requested}\` is in early access. Ask an admin to enable early access for this account.`,
      403,
      "early_access_required",
      { "x-rs-request-id": rid, "x-rs-access-tier": earlyAccess ? "early_access" : "public" },
    )
  }

  /* ---- token compression ---------------------------------------------------
     Every enabled compressor row rewrites the prompt before it is forwarded,
     in priority order. Deterministic text stages only: no model call and no
     extra network hop, so this costs the request nothing but the CPU it takes
     to run a handful of regexes. Wrapped in try/catch on purpose — if
     upgrade-v9.0-token-compressors.sql has not been applied the RPC is simply
     missing, and the prompt forwards untouched rather than failing. */
  let tokensSaved = 0
  let compressorsApplied: string[] = []
  if (Array.isArray(body.messages) && body.messages.length) {
    try {
      const { data: comp } = await admin.rpc("internal_active_compressors", {
        p_model: requested,
      })
      if (Array.isArray(comp) && comp.length) {
        const res = applyCompressors(body.messages, comp as Compressor[])
        if (res.saved > 0) {
          body = { ...body, messages: res.messages }
          tokensSaved = res.saved
          compressorsApplied = res.applied
        }
      }
    } catch (_) {
      /* compression is optional; never let it cost the caller a request */
    }
  }

  const { data: candidates, error: routeErr } = await admin.rpc("internal_route_candidates", {
    p_model: requested,
  })
  if (routeErr) {
    return apiError("Routing table unavailable.", 503, "server_error", { "x-rs-request-id": rid })
  }

  let pool = (candidates ?? []) as Candidate[]
  if (allowed.length) pool = pool.filter((c) => allowed.includes(c.public_id))
  /* auto:* routing must not fail over into something this account cannot use */
  if (restrictedModels.length) pool = pool.filter((c) => !restrictedModels.includes(c.public_id))
  if (!pool.length) {
    await log({
      request_id: rid,
      user_id: acct.user_id,
      api_key_id: acct.api_key_id,
      model_public_id: requested,
      policy: requested,
      ok: false,
      status_code: 404,
      error_code: "model_not_found",
      error_message: `No route available for \`${requested}\`.`,
    })
    return apiError(
      `No route available for \`${requested}\`.`,
      404,
      "model_not_found",
      { "x-rs-request-id": rid },
    )
  }

  const { data: settings } = await admin
    .from("app_settings")
    .select(
      "failover_enabled,max_failover_hops,default_timeout_ms,max_key_attempts,retry_on_timeout",
    )
    .eq("id", 1)
    .maybeSingle()

  /* Two separate budgets, on purpose:
       maxRoutes  — how many model/provider routes may be tried
       keyBudget  — how many keys of one provider may be tried (computed below)
     Before v6.0 a single counter did both, so two slow keys used up the whole
     failover allowance and a healthy third key was never reached. */
  const failoverOn = settings?.failover_enabled !== false
  const maxRoutes = failoverOn ? Math.max(Number(settings?.max_failover_hops ?? 3), 1) : 1
  const fallbackTimeout = Math.max(Number(settings?.default_timeout_ms ?? 60000), 1000)
  const globalAttempts = Math.max(Number(settings?.max_key_attempts ?? 3), 1)
  const globalRetryOnTimeout = settings?.retry_on_timeout !== false

  const started = Date.now()
  let routesTried = 0
  let attempts = 0 // upstream calls made for this request
  let keysTried = 0 // distinct upstream keys used
  let lastStatus = 502
  let lastError = "No upstream responded."
  let lastTimedOut = false
  let lastTimeout = fallbackTimeout

  // ---- 4. try routes, newest healthiest key first --------------------------
  for (const cand of pool) {
    if (routesTried >= maxRoutes) break
    const { data: keys } = await admin.rpc("internal_pick_keys", { p_upstream_id: cand.upstream_id })
    const keyList = (keys ?? []) as UpstreamKey[]
    if (!keyList.length) continue
    routesTried++

    const secrets = [cand.base_url, new URL(cand.base_url).host, cand.upstream_model_id]

    /* The deadline for this model on this provider, and how many of this
       provider's keys this request may spend before moving on. Keys arrive
       healthiest-first, with recently stalled ones last. */
    const deadline = Math.max(Number(cand.timeout_ms) || fallbackTimeout, 1000)
    const retryOnTimeout =
      cand.retry_on_timeout === undefined || cand.retry_on_timeout === null
        ? globalRetryOnTimeout
        : cand.retry_on_timeout !== false
    const keyBudget = Math.min(
      Math.max(Number(cand.max_key_attempts) || globalAttempts, 1),
      keyList.length,
    )
    lastTimeout = deadline
    let usedKeys = 0

    for (const k of keyList) {
      if (usedKeys >= keyBudget) break
      usedKeys++
      attempts++
      keysTried++

      /* KIE ORIGINAL only understands its own shape:
         { model, stream, input, tools?, reasoning? } on /codex/v1/responses. */
      const isKie =
        String(cand.wire_format ?? "") === "kie_responses" ||
        /api\.kie\.ai/i.test(String(cand.base_url ?? "")) ||
        /codex\/v1\/responses/i.test(String(cand.chat_path ?? ""))

      if ((dialect === "messages" || dialect === "responses") && !isKie) {
        lastStatus = 404
        lastError = "This route is served by KIE ORIGINAL only."
        continue
      }
      if (isEmbedding && isKie) {
        lastStatus = 404
        lastError = "KIE ORIGINAL has no embeddings endpoint."
        continue
      }

      const suffix = isKie
        ? cand.chat_path || "/codex/v1/responses"
        : isChat
          ? cand.chat_path || "/chat/completions"
          : isCompletion
            ? "/completions"
            : "/embeddings"

      const outBody = isKie
        ? toKiePayload(body, dialect, cand.upstream_model_id)
        : { ...body, model: cand.upstream_model_id }
      const t0 = Date.now()

      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), deadline)
        const upstreamRes = await fetch(buildUpstreamUrl(cand, suffix, k.api_key), {
          method: "POST",
          headers: buildUpstreamHeaders(cand, k.api_key),
          body: JSON.stringify(outBody),
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        const latency = Date.now() - t0

        // -- upstream error: mark the key, then fail over ---------------------
        if (!upstreamRes.ok) {
          const raw = await upstreamRes.text().catch(() => "")
          lastStatus = upstreamRes.status
          lastError = scrub(raw.slice(0, 400), [...secrets, k.api_key])
          await recordKey(k.key_id, false, upstreamRes.status, latency, lastError)
          if (upstreamRes.status === 400 || upstreamRes.status === 422) {
            // caller's fault — do not burn other keys
            await log({
              request_id: rid,
              user_id: acct.user_id,
              api_key_id: acct.api_key_id,
              model_public_id: cand.public_id,
              policy: requested,
              upstream_id: cand.upstream_id,
              upstream_key_id: k.key_id,
              ok: false,
              status_code: upstreamRes.status,
              latency_ms: latency,
              failover_count: attempts - 1,
              attempts,
              keys_tried: keysTried,
              timed_out: false,
              timeout_ms: deadline,
              streamed: streaming,
              error_code: "invalid_request_error",
              error_message: lastError,
            })
            return apiError(
              "The request was rejected: check your parameters.",
              upstreamRes.status,
              "invalid_request_error",
              { "x-rs-request-id": rid, "x-rs-model": cand.public_id },
            )
          }
          continue
        }

        const headers: Record<string, string> = {
          ...CORS_HEADERS,
          "x-rs-request-id": rid,
          "x-rs-model": cand.public_id,
          "x-rs-policy": requested,
          "x-rs-failover": String(attempts - 1),
          "x-rs-attempts": String(attempts),
          "x-rs-keys-tried": String(keysTried),
          "x-rs-timeout-ms": String(deadline),
          "x-rs-latency-ms": String(latency),
          "x-rs-credits-usd": balance.toFixed(6),
          "x-rs-tokens-saved": String(tokensSaved),
          "x-rs-compressors": compressorsApplied.join(","),
          "x-rs-dialect": dialect,
          "x-rs-harness": harness,
        }

        /* KIE ORIGINAL: read its codex /responses stream once and re-emit it in
           whatever dialect the caller used, then record the usage. */
        if (isKie) {
          return await bridgeKie(upstreamRes, {
            dialect,
            publicModel: cand.public_id,
            requestId: rid,
            streaming,
            headers,
            secrets: [...secrets, k.api_key],
            promptText:
              typeof (outBody as { input?: unknown }).input === "string"
                ? String((outBody as { input?: unknown }).input)
                : "",
            onDone: async (usage) => {
              const total = Date.now() - started
              const cost = costOf(cand, usage.tokensIn, usage.tokensOut)
              const okRun = !usage.error
              await recordKey(k.key_id, okRun, usage.status, latency, usage.error, cost)
              /* v12.15: bridgeKie already accumulated the whole assistant answer
                 into usage.text, so both sides of a KIE call are stored too. */
              const kieReqClamp = clampStoredPayload(rawBody)
              const kieResClamp = clampStoredPayload(usage.text)
              await log({
                request_id: rid,
                user_id: acct.user_id,
                api_key_id: acct.api_key_id,
                model_public_id: cand.public_id,
                policy: requested,
                upstream_id: cand.upstream_id,
                upstream_key_id: k.key_id,
                ok: okRun,
                status_code: usage.status,
                latency_ms: total,
                tokens_in: usage.tokensIn,
                tokens_out: usage.tokensOut,
                cost_usd: cost,
                failover_count: attempts - 1,
                attempts,
                keys_tried: keysTried,
                timeout_ms: deadline,
                streamed: streaming,
                tokens_saved: tokensSaved,
                compressors_applied: compressorsApplied,
                error_code: usage.error ? "upstream_error" : null,
                error_message: usage.error,
                request_body: kieReqClamp.text,
                response_text: kieResClamp.text,
                request_bytes: kieReqClamp.bytes,
                response_bytes: kieResClamp.bytes,
                truncated: kieReqClamp.truncated || kieResClamp.truncated,
              })
            },
          })
        }

        // -- streaming: rewrite model id chunk by chunk -----------------------
        if (streaming && upstreamRes.body) {
          const decoder = new TextDecoder()
          const encoder = new TextEncoder()
          let inTok = 0
          let outTok = 0
          /* v12.15: the text actually streamed back to the caller, accumulated
             here (next to the token counters this block already keeps) so flush()
             can store it beside the request in public.request_payloads. */
          let streamedText = ""
          const stream = new TransformStream({
            transform(chunk, controller) {
              const text = decoder.decode(chunk, { stream: true })
              const m = text.match(/"prompt_tokens"\s*:\s*(\d+)/)
              const n = text.match(/"completion_tokens"\s*:\s*(\d+)/)
              if (m) inTok = Number(m[1])
              if (n) outTok = Number(n[1])
              const masked = maskBody(text, cand.upstream_model_id, cand.public_id, secrets)
              streamedText += masked
              controller.enqueue(encoder.encode(masked))
            },
            async flush() {
              const total = Date.now() - started
              const cost = costOf(cand, inTok, outTok)
              const streamReqClamp = clampStoredPayload(rawBody)
              const streamResClamp = clampStoredPayload(streamedText)
              await recordKey(k.key_id, true, 200, latency, null, cost)
              await log({
                request_id: rid,
                user_id: acct.user_id,
                api_key_id: acct.api_key_id,
                model_public_id: cand.public_id,
                policy: requested,
                upstream_id: cand.upstream_id,
                upstream_key_id: k.key_id,
                ok: true,
                status_code: 200,
                latency_ms: total,
                tokens_in: inTok,
                tokens_out: outTok,
                cost_usd: cost,
                failover_count: attempts - 1,
                attempts,
                keys_tried: keysTried,
                timed_out: false,
                timeout_ms: deadline,
                streamed: true,
                tokens_saved: tokensSaved,
                compressors_applied: compressorsApplied,
                request_body: streamReqClamp.text,
                response_text: streamResClamp.text,
                request_bytes: streamReqClamp.bytes,
                response_bytes: streamResClamp.bytes,
                truncated: streamReqClamp.truncated || streamResClamp.truncated,
              })
            },
          })
          headers["content-type"] = "text/event-stream; charset=utf-8"
          headers["cache-control"] = "no-cache"
          headers["connection"] = "keep-alive"
          return new Response(upstreamRes.body.pipeThrough(stream), { status: 200, headers })
        }

        // -- normal JSON response ---------------------------------------------
        const raw = await upstreamRes.text()
        const clean = maskBody(raw, cand.upstream_model_id, cand.public_id, secrets)
        let parsed: any = null
        try {
          parsed = JSON.parse(clean)
        } catch {
          /* pass through as-is */
        }
        const inTok = Number(parsed?.usage?.prompt_tokens ?? 0)
        const outTok = Number(parsed?.usage?.completion_tokens ?? 0)
        const cost = costOf(cand, inTok, outTok)
        if (parsed) parsed.model = cand.public_id

        /* v12.15: the exact body the caller sent and the exact JSON returned.
           `finalText` is the very string the Response below is built from, so
           what is stored is what the caller actually received. */
        const finalText = parsed ? JSON.stringify(parsed) : clean
        const nonStreamReqClamp = clampStoredPayload(rawBody)
        const nonStreamResClamp = clampStoredPayload(finalText)

        await recordKey(k.key_id, true, 200, latency, null, cost)
        await log({
          request_id: rid,
          user_id: acct.user_id,
          api_key_id: acct.api_key_id,
          model_public_id: cand.public_id,
          policy: requested,
          upstream_id: cand.upstream_id,
          upstream_key_id: k.key_id,
          ok: true,
          status_code: 200,
          latency_ms: Date.now() - started,
          tokens_in: inTok,
          tokens_out: outTok,
          cost_usd: cost,
          failover_count: attempts - 1,
          attempts,
          keys_tried: keysTried,
          timed_out: false,
          timeout_ms: deadline,
          streamed: false,
          tokens_saved: tokensSaved,
          compressors_applied: compressorsApplied,
          request_body: nonStreamReqClamp.text,
          response_text: nonStreamResClamp.text,
          request_bytes: nonStreamReqClamp.bytes,
          response_bytes: nonStreamResClamp.bytes,
          truncated: nonStreamReqClamp.truncated || nonStreamResClamp.truncated,
        })

        headers["content-type"] = "application/json"
        headers["x-rs-tokens-in"] = String(inTok)
        headers["x-rs-tokens-out"] = String(outTok)
        headers["x-rs-cost-usd"] = cost.toFixed(6)
        headers["x-rs-credits-remaining"] = (balance - cost).toFixed(6)
        return new Response(finalText, { status: 200, headers })
      } catch (err) {
        /* Either the provider did not answer inside this model's deadline
           (AbortController fires an AbortError) or the connection itself
           failed. Both mean this key did not deliver, so it is marked and the
           request moves on to the NEXT key of the same provider while the key
           budget lasts — that is the "use another key when the first one runs
           out of time" path. */
        const latency = Date.now() - t0
        const name = (err as Error)?.name ?? ""
        const timedOut = name === "AbortError" || name === "TimeoutError"
        lastTimedOut = timedOut
        lastStatus = 504
        lastError = timedOut
          ? `No response within ${deadline} ms.`
          : scrub(String((err as Error)?.message ?? err), [...secrets, k.api_key])
        await recordKey(k.key_id, false, 504, latency, lastError, 0, timedOut)
        if (timedOut && !retryOnTimeout) break // this provider opts out of key rotation
        continue
      }
    }
  }

  // ---- 5. everything failed -------------------------------------------------
  await log({
    request_id: rid,
    user_id: acct.user_id,
    api_key_id: acct.api_key_id,
    model_public_id: pool[0]?.public_id ?? null,
    policy: requested,
    ok: false,
    status_code: lastStatus,
    latency_ms: Date.now() - started,
    failover_count: Math.max(attempts - 1, 0),
    attempts: Math.max(attempts, 1),
    keys_tried: keysTried,
    timed_out: lastTimedOut,
    timeout_ms: lastTimeout,
    streamed: streaming,
    error_code: lastTimedOut ? "upstream_timeout" : "upstream_unavailable",
    error_message: lastError,
  })

  return apiError(
    lastTimedOut
      ? `No key answered within ${lastTimeout} ms (${keysTried} tried). Try again shortly.`
      : `No healthy route is available for this model right now. Try again shortly. (${attempts} attempt${attempts === 1 ? "" : "s"} across ${routesTried} route${routesTried === 1 ? "" : "s"} failed${lastError ? `: ${lastError.slice(0, 200)}` : ""})`,
    lastTimedOut ? 504 : 503,
    lastTimedOut ? "upstream_timeout" : "upstream_unavailable",
    {
      "x-rs-request-id": rid,
      "x-rs-failover": String(Math.max(attempts - 1, 0)),
      "x-rs-attempts": String(attempts),
      "x-rs-keys-tried": String(keysTried),
      "x-rs-timeout-ms": String(lastTimeout),
    },
  )
})
