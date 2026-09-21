#!/usr/bin/env node
/**
 * RageStar — create an account WITHOUT sending any email.
 * ---------------------------------------------------------------------------
 * Use this instead of Dashboard -> Authentication -> Users -> "Invite user"
 * when you hit:
 *
 *   Failed to invite user: ... /auth/v1/invite ... email rate limit exceeded
 *
 * That error is GoTrue's hourly email quota (tiny on Supabase's shared SMTP),
 * not an IP limit. This script calls the Admin API's create-user endpoint,
 * which sends nothing at all, and marks the address confirmed so the person
 * can sign in immediately with the password you set.
 *
 * Usage:
 *   node scripts/create-user.mjs someone@gmail.com 'TempPass123!'
 *   node scripts/create-user.mjs someone@gmail.com 'TempPass123!' --name "Ada L"
 *   node scripts/create-user.mjs someone@gmail.com 'TempPass123!' --reset-link
 *
 *   --name <text>    stored as user_metadata.full_name (profiles.full_name)
 *   --reset-link     also print a one-time recovery link so they can pick
 *                    their own password. Generated, not emailed.
 *
 * Credentials are read from the environment, falling back to
 * supabase/.env.server (gitignored):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Notes
 *   · The v5.5 trigger on auth.users rejects addresses outside
 *     app_settings.allowed_email_domains (default: gmail.com).
 *   · handle_new_user() creates the profile row, grants signup credit and
 *     promotes the address to admin if it is in app_settings.admin_emails.
 *   · Never run this in a browser or commit the service role key.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ENV_FILE = resolve(here, "..", "supabase", ".env.server")

function loadEnvFile(path) {
  try {
    const out = {}
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq < 1) continue
      out[line.slice(0, eq).trim()] = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
    }
    return out
  } catch {
    return {}
  }
}

function die(message) {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith("--")))
const positional = argv.filter((a) => !a.startsWith("--"))
const nameAt = argv.indexOf("--name")
const fullName = nameAt > -1 ? argv[nameAt + 1] : ""
const [email, password] = positional.filter((a) => a !== fullName)

if (!email || !password) {
  die("Usage: node scripts/create-user.mjs <email> <password> [--name \"Full Name\"] [--reset-link]")
}
if (password.length < 8) die("Password must be at least 8 characters (the app asks for 8+, mixed case, a number and a symbol).")

const fileEnv = loadEnvFile(ENV_FILE)
const URL_ = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY

if (!URL_ || !KEY) {
  die(`Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (env or ${ENV_FILE}).`)
}

const base = URL_.replace(/\/+$/, "")
const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
}

async function callAuth(path, body) {
  let res
  try {
    res = await fetch(`${base}/auth/v1${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  } catch (err) {
    die(`Could not reach ${base} — ${err?.cause?.message || err.message}`)
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, json, text }
}

/* ------------------------------------------------------------------ run */

console.log(`\n  RageStar · creating ${email} (no email will be sent)`)

const created = await callAuth("/admin/users", {
  email,
  password,
  email_confirm: true,
  user_metadata: fullName ? { full_name: fullName } : {},
})

if (!created.ok) {
  const msg = created.json?.msg || created.json?.message || created.json?.error_description || created.text
  if (/only accepts|allowed_email_domains|22023/i.test(String(msg))) {
    die(
      `Rejected by the v5.5 domain trigger: ${msg}\n` +
        `    Allow the domain first:\n` +
        `      select public.admin_save_settings('{"allowed_email_domains":["gmail.com","yourdomain.com"]}'::jsonb);`,
    )
  }
  die(`create-user failed (HTTP ${created.status}): ${msg}`)
}

const user = created.json || {}
console.log(`  ✓ account created`)
console.log(`      id     ${user.id ?? "?"}`)
console.log(`      email  ${user.email ?? email} (confirmed)`)
if (fullName) console.log(`      name   ${fullName}`)
console.log(`  → they can sign in now at /#/login with the password you passed.`)

if (flags.has("--reset-link")) {
  const link = await callAuth("/admin/generate_link", { type: "recovery", email })
  if (link.ok) {
    const url = link.json?.action_link || link.json?.properties?.action_link
    console.log(`\n  One-time link to set their own password (valid ~1h, send it yourself):\n      ${url}`)
  } else {
    console.log(`\n  (recovery link unavailable: HTTP ${link.status} — the password above still works)`)
  }
}

console.log("")
