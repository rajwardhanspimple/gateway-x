#!/usr/bin/env node
/* ==========================================================================
   keywatch-doctor — one command that tells you exactly why the watch is idle
   --------------------------------------------------------------------------
   Run it from the project root:

       npm run keywatch:doctor

   It checks the four things that must all be true, in the order they break,
   and stops at the first real problem with the exact command that fixes it:

     1. the Supabase function exists           (GET  /functions/v1/keywatch)
     2. the function holds a cron secret       (secret_set in that reply)
     3. Postgres holds the schedule            (cron.job via admin_keywatch_selftest)
     4. the database has recorded a pass       (admin_keywatch_selftest via RPC)

   v11.3 — CHECK 3 CHANGED. The scheduler used to be a Cloudflare worker, so
   this script asked <worker>/health over the public internet and could only
   check it if you had remembered to put KEYWATCH_WORKER_URL in .env. The
   schedule now lives in the same database as the state, so check 3 is a row
   lookup in cron.job with no extra configuration and no third party — and it
   can finally see the failure the worker version could not: a migration that
   was applied but never switched on.

   Everything it needs it reads from .env / .env.local, the same file Vite
   uses, so there is nothing extra to configure:

       VITE_SUPABASE_URL        required
       VITE_SUPABASE_ANON_KEY   required
       SUPABASE_SERVICE_ROLE    optional — enables checks 3 and 4

   No secret is ever printed. Exit code 0 means healthy, 1 means it found
   something you need to fix.
   ========================================================================== */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = process.cwd()
const TIMEOUT_MS = 15000

/* ------------------------------------------------------------------ paint */
const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
      amber: (s) => `\u001b[33m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s, amber: (s) => s }

const OK = paint.green("  ok ")
const BAD = paint.red(" fail")
const WARN = paint.amber(" skip")

function line(mark, label, detail) {
  console.log(`${mark}  ${label}${detail ? paint.dim(` — ${detail}`) : ""}`)
}

function fixLine(cmd) {
  console.log(`       ${paint.bold("fix:")} ${cmd}`)
}

/* -------------------------------------------------------------------- env */
function readEnvFile(name) {
  const path = resolve(ROOT, name)
  if (!existsSync(path)) return {}
  const out = {}
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const at = trimmed.indexOf("=")
    if (at < 1) continue
    const key = trimmed.slice(0, at).trim()
    let value = trimmed.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const env = {
  ...readEnvFile(".env"),
  ...readEnvFile(".env.local"),
  ...process.env,
}

const SUPABASE_URL = (env.VITE_SUPABASE_URL || "").replace(/\/+$/, "")
const ANON = env.VITE_SUPABASE_ANON_KEY || ""
const SERVICE = env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY || ""

async function get(url, headers = {}) {
  const stop = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined
  const started = Date.now()
  try {
    const res = await fetch(url, { headers, signal: stop })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, text, json, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, status: 0, text: String(err?.message || err), json: null, ms: Date.now() - started }
  }
}

async function post(url, body, headers = {}) {
  const stop = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: stop,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, text, json }
  } catch (err) {
    return { ok: false, status: 0, text: String(err?.message || err), json: null }
  }
}

function ago(iso) {
  if (!iso) return "never"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "never"
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

/* ------------------------------------------------------------------- main */
async function main() {
  console.log("")
  console.log(paint.bold("  keywatch doctor"))
  console.log(paint.dim("  four checks, in the order things break"))
  console.log("")

  const problems = []

  /* ---- 0. env ---------------------------------------------------------- */
  if (!SUPABASE_URL || !ANON) {
    line(BAD, "project settings", "VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing from .env")
    fixLine("cp .env.example .env   # then fill in the two VITE_SUPABASE_ values")
    console.log("")
    process.exit(1)
  }
  line(OK, "project settings", new URL(SUPABASE_URL).host)

  /* ---- 1. function deployed ------------------------------------------- */
  const fnUrl = `${SUPABASE_URL}/functions/v1/keywatch`
  const ping = await get(fnUrl, { apikey: ANON })

  if (ping.status === 404) {
    line(BAD, "edge function", "404 — keywatch is not deployed in this project")
    fixLine("supabase functions deploy keywatch --no-verify-jwt")
    problems.push("function not deployed")
  } else if (ping.status === 401 || ping.status === 403) {
    line(
      BAD,
      "edge function",
      `${ping.status} — Supabase rejected the call before the function ran (JWT verification is on)`,
    )
    fixLine("supabase functions deploy keywatch --no-verify-jwt")
    console.log(
      paint.dim(
        "       This is the usual cause of “the switch is on but the last pass was never”:\n" +
          "       the cron worker carries no user token, so the gateway turns it away.",
      ),
    )
    problems.push("function is jwt-gated")
  } else if (!ping.ok) {
    line(BAD, "edge function", `${ping.status || "no response"} — ${ping.text.slice(0, 120)}`)
    fixLine("supabase functions deploy keywatch --no-verify-jwt")
    problems.push("function unreachable")
  } else {
    line(OK, "edge function", `reachable in ${ping.ms}ms, version ${ping.json?.version ?? "?"}`)

    /* ---- 2. secret installed ------------------------------------------ */
    if (ping.json?.secret_set === false) {
      line(BAD, "cron secret", "the function holds no KEYWATCH_CRON_SECRET, so it refuses every scheduled call")
      fixLine('supabase secrets set KEYWATCH_CRON_SECRET="$(openssl rand -hex 32)"')
      problems.push("function secret missing")
    } else if (ping.json?.secret_set === true) {
      line(OK, "cron secret", "installed on the function")
    } else {
      line(WARN, "cron secret", "the function did not report secret_set")
    }
  }

  /* ---- 3 + 4. schedule and passes -------------------------------------- */
  /* Both now come from one RPC. Under Cloudflare these were two checks against
     two systems that could not see each other, which is why the old script
     could report a green worker and a dead beat in the same breath without
     noticing the contradiction. */
  if (!SERVICE) {
    line(WARN, "pg_cron schedule", "set SUPABASE_SERVICE_ROLE in .env to check it from here")
    line(WARN, "database", "set SUPABASE_SERVICE_ROLE in .env to read keywatch status from here")
  } else {
    const rpc = await post(
      `${SUPABASE_URL}/rest/v1/rpc/admin_keywatch_selftest`,
      {},
      { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    )

    if (rpc.status === 404 || rpc.json?.code === "PGRST202") {
      line(BAD, "pg_cron schedule", "admin_keywatch_selftest() is missing — the migration has not been applied")
      fixLine("npm run keywatch:migrate")
      problems.push("migration not applied")
    } else if (!rpc.ok) {
      line(BAD, "pg_cron schedule", `${rpc.status} — ${rpc.text.slice(0, 140)}`)
      problems.push("database check failed")
    } else {
      const s = rpc.json || {}

      /* ---- 3. does Postgres actually hold the schedule? ----------------- */
      /* The failure the Cloudflare-era script could not see: every migration
         applied, switch on, and keywatch_schedule() never called once. */
      if (s.scheduler !== "pg_cron") {
        line(
          WARN,
          "pg_cron schedule",
          "this database still has the v11.1 selftest, which cannot see cron.job",
        )
        fixLine("psql \"$DATABASE_URL\" -f supabase/upgrade-v11.3b-selftest-pg-cron.sql")
      } else if (s.cron_job_present === false) {
        line(BAD, "pg_cron schedule", "no job named ragestar-keywatch — the beat was never started")
        fixLine(
          "select public.keywatch_schedule('" +
            `${SUPABASE_URL}/functions/v1/keywatch` +
            "', '<KEYWATCH_CRON_SECRET>');",
        )
        problems.push("schedule not created")
      } else if (s.cron_job_present === null) {
        line(WARN, "pg_cron schedule", "cannot read cron.job from this role — check it in the SQL editor")
      } else if (s.cron_job_active === false) {
        line(BAD, "pg_cron schedule", "the job exists but is inactive, so it never fires")
        fixLine("update cron.job set active = true where jobname = 'ragestar-keywatch';")
        problems.push("schedule inactive")
      } else {
        const http = s.cron_last_http
        const fired = s.cron_last_fire_at ? ago(s.cron_last_fire_at) : "not yet"
        if (http && http !== 200) {
          line(BAD, "pg_cron schedule", `firing (${s.cron_schedule}) but the function answered HTTP ${http}`)
          fixLine(s.next_step || "select public.keywatch_cron_log(10);")
          problems.push(`scheduled call returned ${http}`)
        } else {
          line(OK, "pg_cron schedule", `job active on "${s.cron_schedule}", last fired ${fired}`)
        }
      }

      /* ---- 4. has a pass actually landed? ------------------------------- */
      const enabled = s.enabled === true
      const lastRun = s.last_run_at || null
      const fresh = typeof s.seconds_since_run === "number" && s.seconds_since_run < 180

      if (!enabled) {
        line(WARN, "database", "the watch switch is off — turn it on in Admin → Dashboard → Key watch")
      } else if (!lastRun) {
        line(BAD, "database", "switch is on, but no pass has ever been recorded")
        fixLine(s.next_step || "select public.keywatch_cron_log(10);")
        problems.push("no pass recorded")
      } else if (!fresh) {
        line(BAD, "database", `last pass ${ago(lastRun)} — the beat has stopped`)
        fixLine(s.next_step || "select public.keywatch_cron_log(10);")
        problems.push("beat stalled")
      } else if (s.cron_runs_last_hour === 0 && s.runs_last_hour > 0) {
        line(BAD, "database", "passes are landing, but only from a browser tab — not the schedule")
        fixLine(s.next_step || "select public.keywatch_cron_log(10);")
        problems.push("only tab fallback is running")
      } else {
        line(
          OK,
          "database",
          `last pass ${ago(lastRun)} · ${s.runs_last_hour ?? 0} runs in the last hour ` +
            `(${s.cron_runs_last_hour ?? 0} scheduled) · ${s.keys_total ?? 0} keys`,
        )
      }

      if (s.last_error) console.log(paint.dim(`       last error: ${String(s.last_error).slice(0, 160)}`))
    }
  }

  /* ---- verdict --------------------------------------------------------- */
  console.log("")
  if (problems.length) {
    console.log(
      `  ${paint.red("✗")} ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix: ${problems.join(", ")}`,
    )
    console.log(paint.dim("  Work top to bottom — the first failure usually causes the rest."))
    console.log("")
    process.exit(1)
  }

  console.log(`  ${paint.green("✓")} keywatch is healthy end to end.`)
  console.log("")
  process.exit(0)
}

main().catch((err) => {
  console.error(`\n  doctor crashed: ${err?.stack || err}\n`)
  process.exit(1)
})
