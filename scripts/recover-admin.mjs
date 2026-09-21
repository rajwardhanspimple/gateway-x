#!/usr/bin/env node
/**
 * RageStar — recover access to YOUR OWN project.
 * ---------------------------------------------------------------------------
 * Standard recovery script running through the Supabase SERVICE ROLE key.
 *
 * Credentials and settings are read from the environment, falling back to
 * ../supabase/.env.server:
 *   - SUPABASE_URL or SUPABASE_REF (constructs https://<ref>.supabase.co)
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - ROLE or DEFAULT_ROLE (defaults to 'admin')
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"

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
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
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

function genPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
  const lower = "abcdefghijkmnpqrstuvwxyz"
  const nums = "23456789"
  const syms = "!@#$%^&*-_=+?"
  const all = upper + lower + nums + syms
  const pick = (set) => set[randomBytes(1)[0] % set.length]
  const out = [pick(upper), pick(lower), pick(nums), pick(syms)]
  while (out.length < 20) out.push(pick(all))
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out.join("")
}

/* ------------------------------------------------------------------ args & env */

const argv = process.argv.slice(2)
let email
let password = process.env.NEW_PASSWORD || ""
let fullName = ""
let dryRun = false
let cliRole = ""

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--password" || a === "-p") password = argv[++i] || ""
  else if (a.startsWith("--password=")) password = a.slice("--password=".length)
  else if (a === "--name" || a === "-n") fullName = argv[++i] || ""
  else if (a.startsWith("--name=")) fullName = a.slice("--name=".length)
  else if (a === "--role" || a === "-r") cliRole = argv[++i] || ""
  else if (a.startsWith("--role=")) cliRole = a.slice("--role=".length)
  else if (a === "--dry-run") dryRun = true
  else if (!a.startsWith("-") && !email) email = a
}

if (!email) {
  die('Usage: node scripts/recover-admin.mjs <email> [--password "NewPass"] [--name "Full Name"] [--role "admin"] [--dry-run]')
}

const fileEnv = loadEnvFile(ENV_FILE)

// Resolve Supabase URL from URL or REF
const projectRef = process.env.SUPABASE_REF || fileEnv.SUPABASE_REF
const rawUrl = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL || (projectRef ? `https://${projectRef}.supabase.co` : "")
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY

// Resolve target role
const targetRole = cliRole || process.env.ROLE || fileEnv.ROLE || process.env.DEFAULT_ROLE || fileEnv.DEFAULT_ROLE || "admin"

if (!rawUrl || !KEY) {
  die(`Missing credentials. Provide SUPABASE_URL (or SUPABASE_REF) and SUPABASE_SERVICE_ROLE_KEY via env or ${ENV_FILE}.`)
}

let generated = false
if (!dryRun && !password) {
  password = genPassword()
  generated = true
}
if (!dryRun && password.length < 8) {
  die("Password must be at least 8 characters.")
}

const base = rawUrl.replace(/\/+$/, "")
const authHeaders = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
}
const restHeaders = { ...authHeaders, Prefer: "return=representation" }

async function http(method, url, headers, body) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    die(`Could not reach ${url} — ${err?.cause?.message || err.message}`)
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, json, text }
}

async function findUserByEmail(target) {
  const want = target.toLowerCase()
  const perPage = 1000
  for (let page = 1; page <= 50; page++) {
    const r = await http("GET", `${base}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, authHeaders)
    if (!r.ok) return { error: r }
    const users = Array.isArray(r.json?.users) ? r.json.users : Array.isArray(r.json) ? r.json : []
    const hit = users.find((u) => (u.email || "").toLowerCase() === want)
    if (hit) return { user: hit }
    if (users.length < perPage) return { user: null }
  }
  return { user: null }
}

async function ensureAdminEmail(target) {
  const r = await http("GET", `${base}/rest/v1/app_settings?id=eq.1&select=admin_emails`, authHeaders)
  if (!r.ok) return { ok: false, detail: `read app_settings HTTP ${r.status}: ${r.text}` }
  const row = Array.isArray(r.json) ? r.json[0] : null
  if (!row) return { ok: false, detail: "app_settings row id=1 not found" }
  const current = Array.isArray(row.admin_emails) ? row.admin_emails : []
  if (current.some((e) => (e || "").toLowerCase() === target.toLowerCase())) {
    return { ok: true, already: true }
  }
  const u = await http("PATCH", `${base}/rest/v1/app_settings?id=eq.1`, restHeaders, {
    admin_emails: [...current, target],
  })
  if (!u.ok) return { ok: false, detail: `update app_settings HTTP ${u.status}: ${u.text}` }
  return { ok: true, already: false }
}

async function ensureProfile(uid, target, role) {
  const patch = await http("PATCH", `${base}/rest/v1/profiles?id=eq.${uid}`, restHeaders, {
    role,
    status: "active",
  })
  if (patch.ok) {
    const rows = Array.isArray(patch.json) ? patch.json : []
    if (rows.length > 0) return { ok: true, mode: "updated" }
    const ins = await http("POST", `${base}/rest/v1/profiles`, restHeaders, {
      id: uid,
      email: target,
      role,
      status: "active",
    })
    if (ins.ok) return { ok: true, mode: "inserted" }
    return { ok: false, detail: `insert profile HTTP ${ins.status}: ${ins.text}` }
  }
  return { ok: false, detail: `update profile HTTP ${patch.status}: ${patch.text}` }
}

/* ------------------------------------------------------------------ run */

console.log(`\n  RageStar · access recovery`)
console.log(`  project : ${base}`)
console.log(`  account : ${email}`)
console.log(`  role    : ${targetRole}`)

const found = await findUserByEmail(email)
if (found.error) {
  const m = found.error.json?.msg || found.error.json?.message || found.error.text
  die(`Could not list users (HTTP ${found.error.status}): ${m}. Check SUPABASE_SERVICE_ROLE_KEY.`)
}
let user = found.user

if (dryRun) {
  console.log(`\n  [dry-run] auth user : ${user ? `EXISTS (id ${user.id}) — would reset password` : "NOT found — would create it"}`)
  const ae = await http("GET", `${base}/rest/v1/app_settings?id=eq.1&select=admin_emails`, authHeaders)
  console.log(`  [dry-run] app_settings read : ${ae.ok ? "ok" : `FAILED (HTTP ${ae.status})`}`)
  console.log(`  [dry-run] would set profiles.role='${targetRole}', status='active'`)
  console.log(`  [dry-run] no changes made.\n`)
  process.exit(0)
}

// 1) Whitelist admin email if role is admin
let adminEmailRes = { ok: true, skipped: true }
if (targetRole === "admin") {
  adminEmailRes = await ensureAdminEmail(email)
}

// 2) Create account or reset password
if (user) {
  const upd = await http("PUT", `${base}/auth/v1/admin/users/${user.id}`, authHeaders, {
    password,
    email_confirm: true,
    ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
  })
  if (!upd.ok) {
    const m = upd.json?.msg || upd.json?.message || upd.text
    die(`Failed to reset password (HTTP ${upd.status}): ${m}`)
  }
  user = upd.json || user
  console.log(`  ✓ password reset for existing account (id ${user.id})`)
} else {
  const cre = await http("POST", `${base}/auth/v1/admin/users`, authHeaders, {
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : {},
  })
  if (!cre.ok) {
    const m = cre.json?.msg || cre.json?.message || cre.json?.error_description || cre.text
    if (/only accepts|allowed_email_domains|22023/i.test(String(m))) {
      die(
        `Rejected by the domain trigger: ${m}\n` +
          `    Widen the allow-list first (service role, SQL editor):\n` +
          `      update public.app_settings set allowed_email_domains = allowed_email_domains || '{yourdomain.com}' where id = 1;`,
      )
    }
    die(`Failed to create account (HTTP ${cre.status}): ${m}`)
  }
  user = cre.json || {}
  console.log(`  ✓ account created (id ${user.id})`)
}

// 3) Update profile role and status
const profRes = await ensureProfile(user.id, email, targetRole)

if (targetRole === "admin") {
  console.log(`  ${adminEmailRes.ok ? "✓" : "⚠"} admin_emails : ${adminEmailRes.ok ? (adminEmailRes.already ? "already listed" : "added") : "skipped — " + adminEmailRes.detail}`)
}
console.log(`  ${profRes.ok ? "✓" : "⚠"} profile      : ${profRes.ok ? `role=${targetRole}, status=active (${profRes.mode})` : "NOT set — " + profRes.detail}`)

console.log(`\n  Done. Sign in at your site → /#/login`)
console.log(`      email     ${user.email || email}`)
if (generated) {
  console.log(`      password  ${password}`)
  console.log(`                ↑ shown once — store it, then change it after signing in.`)
} else {
  console.log(`      password  (the one you provided)`)
}
console.log("")
