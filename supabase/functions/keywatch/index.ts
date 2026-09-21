// ============================================================================
//  RageStar — keywatch (v11)
// ----------------------------------------------------------------------------
//  The key watcher used to be a setInterval in the admin's browser. Close the
//  tab and the watching stopped, which is exactly when you want it running.
//  This function is the server-side beat.
//
//  POST {SUPABASE_URL}/functions/v1/keywatch
//    x-keywatch-secret: <KEYWATCH_CRON_SECRET>     (what the cron worker sends)
//      ...or...
//    Authorization: Bearer <service role key>      (what a script sends)
//
//  Body (all optional):
//    { "source": "cron" | "manual" | "worker" | "pg_cron",
//      "trigger": "cron:* * * * *",
//      "passes": 4,            // passes inside this one invocation
//      "spacing_ms": 15000,    // gap between passes
//      "batch_size": 25,       // overrides the stored batch size, clamped
//      "force": false }        // ignore the enabled flag and the interval
//
//  Cloudflare cron can only fire once a minute, so one invocation runs several
//  spaced passes: 4 x 15s covers the minute and the next invocation takes over.
//  internal_keywatch_due() hands out the claim, so overlapping invocations
//  cannot double-check the same keys.
//
//  GET returns a deploy check and never touches the database.
//
//  Deploy with JWT verification OFF — callers are schedulers, not browsers,
//  and the secret check below is the gate:
//
//      supabase functions deploy keywatch --no-verify-jwt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import {
  apiError,
  assertPublicHttpsUrl,
  json,
  MAX_BODY_BYTES,
  preflight,
  safeJsonParse,
  scrubSecrets,
} from "../_shared/cors.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""
const CRON_SECRET = Deno.env.get("KEYWATCH_CRON_SECRET") ?? ""

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/* One invocation gets a wall-clock budget. Edge functions are killed at their
   own limit; stopping early on our own terms means the run is still recorded. */
const WALL_CLOCK_MS = 50_000
const POOL = 5

type Upstream = {
  id: string | null
  name: string | null
  base_url: string
  models_path: string | null
  health_path: string | null
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

const UPSTREAM_COLS =
  "id,name,base_url,models_path,health_path,auth_scheme,auth_header,auth_query_arg,extra_headers,timeout_ms,chat_path,wire_format"

/* ---------------------------------------------------------------- probing */
/* Deliberately a compact copy of the probe in admin-check-keys rather than a
   shared import: that function is the admin's interactive tool and carries a
   whole auth stack with it. The watcher only ever needs "did this key answer",
   and a scheduled job should not be able to break the admin panel when it is
   edited. The two are kept in step by the endpoint rules below. */

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
  assertPublicHttpsUrl(u.base_url || "", "base_url")
  const base = (u.base_url || "").replace(/\/+$/, "")
  const suffix = path.startsWith("/") ? path : "/" + path
  const url = new URL(base + suffix)
  if (u.auth_scheme === "query") url.searchParams.set(u.auth_query_arg || "key", key)
  return url.toString()
}

async function probe(u: Upstream, key: string) {
  const budget = Math.min(Math.max(Number(u.timeout_ms) || 20000, 3000), 20000)
  /* KIE ORIGINAL answers one POST shape only: it has no GET /models and no
     health path, so a GET probe would wrongly condemn a working key. Its keys
     are proven by real traffic instead. */
  const kieUpstream =
    String((u as { wire_format?: string | null }).wire_format ?? "") === "kie_responses" ||
    /api\.kie\.ai/i.test(String(u.base_url ?? ""))
  if (kieUpstream) {
    return { ok: true, status: 200, latency: 0, timedOut: false, message: null }
  }

  const paths = [u.health_path, u.models_path, "/models"]
    .map((p) => (p || "").trim())
    .filter((p, i, all) => p && all.indexOf(p) === i)

  let status = 0
  let latency = 0
  let ok = false
  let note: string | null = null
  let timedOut = false

  for (const path of paths.length ? paths : ["/models"]) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), budget)
    const t0 = Date.now()
    try {
      const res = await fetch(urlFor(u, path, key), {
        method: "GET",
        headers: headersFor(u, key),
        signal: ctrl.signal,
      })
      const text = await res.text().catch(() => "")
      ok = res.ok
      status = res.status
      latency = Date.now() - t0
      timedOut = false
      note = ok ? null : text || `HTTP ${res.status}`
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError"
      ok = false
      status = aborted ? 504 : 0
      latency = Date.now() - t0
      timedOut = aborted
      note = aborted
        ? `Upstream did not answer within ${budget} ms`
        : `Could not reach the upstream: ${String((err as Error)?.message ?? err)}`
    } finally {
      clearTimeout(timer)
    }

    // 404/405 means "wrong path", not "dead key" — try the next candidate.
    if (ok || (status !== 404 && status !== 405 && status !== 0)) break
  }

  return {
    ok,
    status,
    latency,
    timedOut,
    message: ok ? null : scrubSecrets(String(note ?? ""), [key]).slice(0, 400),
  }
}

/* --------------------------------------------------------------- one pass */

async function runPass(batchSize: number, activeOnly: boolean) {
  let q = admin
    .from("upstream_keys")
    .select(`id,label,api_key,upstream_id,is_active,upstreams(${UPSTREAM_COLS})`)
    // Oldest check first, so a key never starves however big the estate gets.
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(batchSize)

  if (activeOnly) q = q.eq("is_active", true)

  const { data, error } = await q
  if (error) throw new Error(error.message)

  const keys = (data ?? []) as unknown as KeyRow[]
  let working = 0
  let failing = 0

  let cursor = 0
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= keys.length) return
      const row = keys[i]
      const u = row.upstreams

      if (!u?.base_url) {
        failing++
        await admin.rpc("internal_record_key_result", {
          p_key_id: row.id,
          p_ok: false,
          p_status_code: null,
          p_latency_ms: 0,
          p_error: "This key's upstream has no base_url configured.",
          p_cost_usd: 0,
          p_source: "cron",
        })
        continue
      }

      try {
        const r = await probe(u, row.api_key)
        if (r.ok) working++
        else failing++
        await admin.rpc("internal_record_key_result", {
          p_key_id: row.id,
          p_ok: r.ok,
          p_status_code: r.status || null,
          p_latency_ms: r.latency,
          p_error: r.message,
          p_cost_usd: 0,
          p_source: "cron",
          p_timed_out: r.timedOut,
        })
      } catch (err) {
        // A bad base_url (SSRF guard) must sink one key, never the whole pass.
        failing++
        await admin.rpc("internal_record_key_result", {
          p_key_id: row.id,
          p_ok: false,
          p_status_code: null,
          p_latency_ms: 0,
          p_error: String((err as Error)?.message ?? err).slice(0, 400),
          p_cost_usd: 0,
          p_source: "cron",
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, keys.length || 1) }, worker))
  return { checked: keys.length, working, failing }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ entry */

Deno.serve(async (req: Request) => {
  const pre = preflight(req)
  if (pre) return pre

  if (req.method === "GET") {
    return json(
      {
        ok: true,
        function: "keywatch",
        version: "11.0",
        configured: Boolean(SUPABASE_URL && SERVICE_KEY),
        secret_set: Boolean(CRON_SECRET),
      },
      200,
      {},
      req,
    )
  }

  if (req.method !== "POST") return apiError("Use POST.", 405, "method_not_allowed", {}, req)

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return apiError(
      "keywatch is missing SUPABASE_URL or the service role key.",
      500,
      "server_error",
      {},
      req,
    )
  }

  /* Two accepted callers: the cron worker with the shared secret, or anything
     already holding the service role key. No admin JWT path — the panel's
     "check now" button goes through admin-check-keys, which is where the admin
     gate already lives. */
  const sent = req.headers.get("x-keywatch-secret") ?? ""
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  const bySecret = Boolean(CRON_SECRET) && sent === CRON_SECRET
  const byService = Boolean(SERVICE_KEY) && bearer === SERVICE_KEY

  if (!bySecret && !byService) {
    return apiError("keywatch requires the cron secret.", 403, "forbidden", {}, req)
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return apiError("Body too large.", 413, "payload_too_large", {}, req)
  }
  const body = safeJsonParse<Record<string, unknown>>(raw || "{}", {})

  const source = String(body.source ?? "cron")
  const trigger = body.trigger == null ? null : String(body.trigger)
  const force = body.force === true
  const passes = Math.min(Math.max(Number(body.passes) || 1, 1), 12)
  const spacing = Math.min(Math.max(Number(body.spacing_ms) || 0, 0), 60_000)

  const startedAt = Date.now()
  const passLog: Array<Record<string, unknown>> = []
  let totalChecked = 0

  for (let pass = 0; pass < passes; pass++) {
    if (Date.now() - startedAt > WALL_CLOCK_MS) {
      passLog.push({ pass, skipped: true, reason: "out of wall-clock budget" })
      break
    }

    const t0 = Date.now()
    const { data: claim, error: claimErr } = await admin.rpc("internal_keywatch_due", {
      p_force: force,
    })

    if (claimErr) {
      await admin.rpc("internal_keywatch_record_run", {
        p_source: source,
        p_trigger: trigger,
        p_duration_ms: Date.now() - t0,
        p_skipped: true,
        p_reason: "claim failed",
        p_error: claimErr.message,
      })
      return apiError(claimErr.message, 500, "server_error", {}, req)
    }

    const info = (claim ?? {}) as Record<string, unknown>

    if (info.due !== true) {
      // Not an error: the beat is off, or another invocation already took it.
      passLog.push({ pass, skipped: true, reason: info.reason ?? "not due" })
      if (info.enabled === false) break
      if (spacing && pass < passes - 1) await sleep(Math.min(spacing, 5_000))
      continue
    }

    const batch = Math.min(
      Math.max(Number(body.batch_size) || Number(info.batch_size) || 25, 1),
      500,
    )
    const activeOnly = info.active_only !== false

    try {
      const out = await runPass(batch, activeOnly)
      totalChecked += out.checked
      await admin.rpc("internal_keywatch_record_run", {
        p_source: source,
        p_trigger: trigger,
        p_checked: out.checked,
        p_working: out.working,
        p_failing: out.failing,
        p_duration_ms: Date.now() - t0,
        p_skipped: false,
        p_reason: out.checked ? null : "no keys matched",
      })
      passLog.push({ pass, ...out, ms: Date.now() - t0 })
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 400)
      await admin.rpc("internal_keywatch_record_run", {
        p_source: source,
        p_trigger: trigger,
        p_duration_ms: Date.now() - t0,
        p_skipped: false,
        p_error: message,
      })
      passLog.push({ pass, error: message })
    }

    const remaining = WALL_CLOCK_MS - (Date.now() - startedAt)
    if (spacing && pass < passes - 1 && remaining > spacing) await sleep(spacing)
  }

  return json(
    {
      ok: true,
      source,
      passes: passLog.length,
      checked: totalChecked,
      ms: Date.now() - startedAt,
      detail: passLog,
    },
    200,
    {},
    req,
  )
})
