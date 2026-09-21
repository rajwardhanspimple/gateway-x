import {
  supabase,
  niceError,
  GATEWAY_URL,
  FUNCTIONS_URL,
  SUPABASE_ANON_KEY,
} from "./supabase"
import { edgeHeaders, getSupabaseAccessToken } from "./firebaseBridge"
import { sanitizeHeaderMap, safeJsonParse, validateUpstreamBaseUrl } from "./sanitize"
import { PRESETS, slugify } from "./compress"

function unwrap({ data, error }, fallback) {
  if (error) throw new Error(niceError(error))
  return data ?? fallback
}

/* ------------------------------------------------------------------ public */

export async function listPublicModels() {
  return unwrap(
    await supabase
      .from("public_models")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true }),
    [],
  )
}

const SETTINGS_BASE =
  "brand_name,gateway_url,signup_enabled,default_policy,failover_enabled,max_failover_hops,log_retention_days"
const SETTINGS_CREDITS = "credits_enabled,signup_credit_usd,low_balance_usd,overdraft_usd"
const SETTINGS_WINDOWS = "five_hour_limit_usd,weekly_limit_usd"
const SETTINGS_DISCORD = "discord_join_credit_usd,discord_required"


/** Workspace settings. Falls back to the pre-credit column list when
 *  supabase/upgrade-v5.4.sql has not been applied yet, so the admin panel and
 *  the marketing pages keep working either way. */
export async function getSettings() {
  /* public_settings is a view over app_settings that deliberately omits
     admin_emails. Reading the base table directly used to be granted to anon,
     which handed anyone the list of emails that get auto-promoted to admin. */

  /* v12.7: the view gained the Discord join credit */
  const v127 = await supabase
    .from("public_settings")
    .select(`${SETTINGS_BASE},${SETTINGS_CREDITS},${SETTINGS_WINDOWS},${SETTINGS_DISCORD},allowed_email_domains`)
    .eq("id", 1)
    .maybeSingle()
  if (!v127.error) return v127.data ?? null

  /* v12.5: the view gained the spend-window caps */
  const win = await supabase
    .from("public_settings")
    .select(`${SETTINGS_BASE},${SETTINGS_CREDITS},${SETTINGS_WINDOWS},allowed_email_domains`)
    .eq("id", 1)
    .maybeSingle()
  if (!win.error) return win.data ?? null

  /* pre-v12.5: the same view without the window columns */
  const view = await supabase
    .from("public_settings")
    .select(`${SETTINGS_BASE},${SETTINGS_CREDITS},allowed_email_domains`)
    .eq("id", 1)
    .maybeSingle()
  if (!view.error) return view.data ?? null

  /* databases that have not run upgrade-v5.5-security.sql yet */
  const full = await supabase
    .from("app_settings")
    .select(`${SETTINGS_BASE},${SETTINGS_CREDITS}`)
    .eq("id", 1)
    .maybeSingle()
  if (!full.error) return full.data ?? null

  return unwrap(
    await supabase.from("app_settings").select(SETTINGS_BASE).eq("id", 1).maybeSingle(),
    null,
  )
}

/* -------------------------------------------------------- announcements
   Site-wide banners (v12.7). Active rows are world-readable — the landing
   page is public — and every write goes through the admin_*_announcement
   RPCs so each change lands in audit_logs. */

function announcementsMissing(error) {
  return /announcements|could not find|does not exist|schema cache/i.test(
    String(error?.message || ""),
  )
}

/** Active announcements, newest first. Public: anon can read active rows. */
export async function listAnnouncements() {
  const res = await supabase
    .from("announcements")
    .select("id,title,body,tone,created_at")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
  if (res.error) {
    /* a missing v12.7 table must never break the public pages */
    if (announcementsMissing(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data ?? []
}

/** Every announcement, active or not — the admin list. */
export async function adminListAnnouncements() {
  const res = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false })
  if (res.error) {
    if (announcementsMissing(res.error)) {
      throw new Error(
        "The announcements table does not exist yet. Run supabase/upgrade-v12.7-announcements-discord-credit.sql in the SQL editor, then reload.",
      )
    }
    throw new Error(niceError(res.error))
  }
  return res.data ?? []
}

export async function adminCreateAnnouncement({ title, body, tone, is_active }) {
  const res = await supabase.rpc("admin_create_announcement", {
    p_title: title,
    p_body: body,
    p_tone: tone,
    p_is_active: is_active,
  })
  if (res.error) throw new Error(niceError(res.error))
  return res.data
}

export async function adminUpdateAnnouncement(id, patch) {
  const res = await supabase.rpc("admin_update_announcement", {
    p_id: id,
    p_patch: patch,
  })
  if (res.error) throw new Error(niceError(res.error))
  return res.data
}

export async function adminDeleteAnnouncement(id) {
  const res = await supabase.rpc("admin_delete_announcement", { p_id: id })
  if (res.error) throw new Error(niceError(res.error))
}

export async function routeHealth() {
  return unwrap(await supabase.from("route_health").select("*"), [])
}

export async function dailyHealth() {
  return unwrap(await supabase.from("gateway_daily_health").select("*"), [])
}

/* ------------------------------------------------------------------- user */

export async function listMyKeys() {
  return unwrap(
    await supabase.from("my_api_keys").select("*").order("created_at", { ascending: false }),
    [],
  )
}

export async function createKey({ name, environment = "live", budget = null, expiresAt = null }) {
  const rows = unwrap(
    await supabase.rpc("create_api_key", {
      p_name: name || "default",
      p_environment: environment,
      p_monthly_budget_usd: budget,
      /* Sent only when the user actually picked a date. create_api_key gained
         p_expires_at in v12.11; passing it to a database that has not run that
         upgrade would be an unknown argument and fail the whole call. */
      ...(expiresAt ? { p_expires_at: expiresAt } : {}),
    }),
    [],
  )
  return Array.isArray(rows) ? rows[0] : rows
}

export async function revokeKey(id) {
  unwrap(await supabase.rpc("revoke_api_key", { p_key_id: id }), null)
}

export async function renameKey(id, name) {
  unwrap(await supabase.rpc("update_api_key", { p_key_id: id, p_name: name }), null)
}

export async function setKeyBudget(id, budget) {
  unwrap(
    await supabase.rpc("update_api_key", { p_key_id: id, p_monthly_budget_usd: budget }),
    null,
  )
}

/** Move a key's expiry. `expiresAt` is an ISO-8601 string, or null to make the
 *  key non-expiring again. The date is validated server-side by
 *  set_api_key_expiry() — it must be in the future. */
export async function setKeyExpiry(id, expiresAt) {
  unwrap(
    await supabase.rpc("set_api_key_expiry", { p_key_id: id, p_expires_at: expiresAt }),
    null,
  )
}

/* ---------------------------------------------------------------- IP limits */

/** Lock a key to a list of IPs / CIDR ranges and cap requests per minute per
 *  address. `ips = []` removes the allowlist, `rpm = 0` falls back to the
 *  workspace default. Validated server-side by set_api_key_ip_rules(). */
export async function setKeyIpRules(id, { ips = null, rpm = null } = {}) {
  return unwrap(
    await supabase.rpc("set_api_key_ip_rules", {
      p_key_id: id,
      p_allowed_ips: ips,
      p_ip_rate_limit_rpm: rpm,
    }),
    null,
  )
}

/** Addresses that used the caller's own keys recently. */
export async function myIpActivity(hours = 24) {
  return unwrap(await supabase.rpc("my_ip_activity", { p_hours: hours }), [])
}

/** Admin: busiest addresses across the whole gateway. */
export async function adminIpActivity(hours = 24) {
  return unwrap(await supabase.rpc("admin_ip_activity", { p_hours: hours }), [])
}

/** Admin: current bans (manual + automatic), newest first. */
export async function listBlockedIps() {
  return unwrap(
    await supabase.from("blocked_ips").select("*").order("created_at", { ascending: false }),
    [],
  )
}

/** Admin: ban an address or range. `minutes = 0` or null bans it permanently. */
export async function blockIp(cidr, reason = null, minutes = null) {
  return unwrap(
    await supabase.rpc("admin_block_ip", {
      p_cidr: cidr,
      p_reason: reason,
      p_minutes: minutes,
    }),
    null,
  )
}

export async function unblockIp(cidr) {
  return unwrap(await supabase.rpc("admin_unblock_ip", { p_cidr: cidr }), null)
}

/* ------------------------------------------- IP limits: admin control plane
   Driven by supabase/upgrade-v5.7-ip-admin.sql. v5.6 shipped the IP columns
   but admin_save_settings() rejected every one of them, so the panel could
   not write a single setting; admin_save_ip_settings() is that missing door. */

/** The workspace-wide IP settings, as stored. Admin only. */
export async function getIpSettings() {
  return unwrap(await supabase.rpc("admin_get_ip_settings"), null)
}

/** Patch any subset of the IP settings. Addresses are validated and
 *  normalised to CIDR server-side, so a typo fails at save time instead of
 *  silently never matching a real request. */
export async function saveIpSettings(patch) {
  return unwrap(await supabase.rpc("admin_save_ip_settings", { p_patch: patch }), null)
}

/** Every address the gateway has recorded, newest activity first. Comes from
 *  ip_registry, so it outlives request-log retention. */
export async function adminIpRegistry({ hours = 168, search = null, limit = 200 } = {}) {
  return unwrap(
    await supabase.rpc("admin_ip_registry", {
      p_hours: hours,
      p_search: search || null,
      p_limit: limit,
    }),
    [],
  )
}

/** Per-account IP rules.
 *  `exempt: true` -> no IP limit ever applies to this account.
 *  `rpm: 0`       -> inherit the workspace default; any other number wins. */
export async function setUserIpRules(userId, { exempt = null, rpm = null } = {}) {
  return unwrap(
    await supabase.rpc("admin_set_user_ip_rules", {
      p_user_id: userId,
      p_exempt: exempt,
      p_rpm: rpm,
    }),
    null,
  )
}

/** The same escape hatch, one API key only. */
export async function setKeyIpExempt(keyId, exempt) {
  return unwrap(
    await supabase.rpc("admin_set_key_ip_exempt", { p_key_id: keyId, p_exempt: !!exempt }),
    null,
  )
}

/** Add or remove one address on the always-allow list. Returns the whole
 *  settings object, so the caller never read-modify-writes the array itself
 *  and cannot lose a concurrent edit doing so. */
export async function exemptIp(cidr, on = true) {
  return unwrap(await supabase.rpc("admin_exempt_ip", { p_cidr: cidr, p_on: on }), null)
}

/** Drop an address from the record. Scoped to one account when given. */
export async function forgetIp(ip, userId = null) {
  return unwrap(await supabase.rpc("admin_forget_ip", { p_ip: ip, p_user_id: userId }), null)
}

/** Label an address so the next person knows why it is on a list. */
export async function noteIp(ip, userId, note) {
  return unwrap(
    await supabase.rpc("admin_note_ip", { p_ip: ip, p_user_id: userId, p_note: note }),
    null,
  )
}

/** The signed-in account's own recorded addresses, for the console. */
export async function myIpRegistry() {
  return unwrap(await supabase.rpc("my_ip_registry"), [])
}

export async function usageSummary(days = 30) {
  return unwrap(await supabase.rpc("my_usage_summary", { p_days: days }), null)
}

export async function usageSeries(days = 14) {
  return unwrap(await supabase.rpc("my_usage_series", { p_days: days }), [])
}

export async function listMyLogs(limit = 40, days = null) {
  let query = supabase
    .from("my_request_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (days != null) {
    const since = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86400000)
    query = query.gte("created_at", since.toISOString())
  }
  return unwrap(await query, [])
}

/* ---------------------------------------------------------------- payloads */

/** The stored request/response pair for one call the account made
 *  (supabase/upgrade-v12.15-request-payloads.sql). Ownership is enforced by
 *  RLS on request_payloads, so there is no user filter here: a request_id
 *  that is not yours comes back as no row, not as a row belonging to someone
 *  else. Returns null - rather than throwing - when the upgrade has not been
 *  applied, or when nothing was stored for that call (a refusal before the
 *  model never stores a payload). */
export async function myRequestPayload(requestId) {
  if (!requestId) return null
  const res = await supabase
    .from("request_payloads")
    .select("*")
    .eq("request_id", requestId)
    .maybeSingle()
  if (res.error) {
    if (missingSchema(res.error)) return null
    throw new Error(niceError(res.error))
  }
  return res.data ?? null
}


/* ---------------------------------------------------------------- credits */

/** True when the credit objects from upgrade-v5.4.sql are not installed yet. */
function creditsMissing(error) {
  const code = error?.code || ""
  const msg = `${error?.message || ""} ${error?.details || ""}`.toLowerCase()
  return (
    code === "PGRST202" ||
    code === "PGRST205" ||
    code === "42883" ||
    code === "42P01" ||
    code === "42703" ||
    msg.includes("my_credits") ||
    msg.includes("credit_ledger") ||
    msg.includes("credit_balance_usd")
  )
}

/** Balance + burn rate for the signed-in account. `unavailable` means the SQL
 *  upgrade has not been run, which the Credits tab explains instead of erroring. */
export async function myCredits() {
  const res = await supabase.rpc("my_credits")
  if (res.error) {
    if (creditsMissing(res.error)) return { unavailable: true }
    throw new Error(niceError(res.error))
  }
  return { unavailable: false, ...(res.data || {}) }
}

/** Rolling spend windows for the signed-in account: how much has been spent in
 *  the last 5 hours and last 7 days, against the caps set by the workspace.
 *  `unavailable` means supabase/upgrade-v12.5-window-limits.sql has not been
 *  run, which the dashboard explains instead of erroring. */
export async function myWindowUsage() {
  const res = await supabase.rpc("my_window_usage")
  if (res.error) {
    const msg = `${res.error.message || ""} ${res.error.details || ""}`.toLowerCase()
    if (res.error.code === "42883" || msg.includes("my_window_usage")) return { unavailable: true }
    throw new Error(niceError(res.error))
  }
  return { unavailable: false, ...(res.data || {}) }
}

export async function myCreditLedger(limit = 50) {
  const res = await supabase
    .from("my_credit_ledger")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (res.error) {
    if (creditsMissing(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data || []
}

/** Positive amount adds credit, negative amount takes it away. Admin only. */
export async function adjustUserCredits(userId, amountUsd, note = null) {
  return unwrap(
    await supabase.rpc("admin_adjust_credits", {
      p_user_id: userId,
      p_amount_usd: Number(amountUsd),
      p_note: note || null,
    }),
    null,
  )
}

/** Sets an exact balance instead of nudging it. Admin only. */
export async function setUserCredits(userId, balanceUsd, note = null) {
  return unwrap(
    await supabase.rpc("admin_set_credit_balance", {
      p_user_id: userId,
      p_balance_usd: Number(balanceUsd),
      p_note: note || null,
    }),
    null,
  )
}

export async function listCreditLedger(limit = 100) {
  const res = await supabase
    .from("admin_credit_ledger")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (res.error) {
    if (creditsMissing(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data || []
}

/* ----------------------------------------------------------------- privacy */

/* The acceptance columns arrive with
   supabase/upgrade-v12.14-privacy-acceptance.sql. A database that has not run
   that file answers with a schema-cache error rather than a row, so this returns
   `unavailable: true` and the sign-in gate stands down instead of locking every
   account in the workspace out of its own dashboard. */
export async function myPrivacyAcceptance(userId) {
  if (!userId) return { unavailable: true }
  const res = await supabase
    .from("profiles")
    .select("privacy_accepted_at,privacy_version")
    .eq("id", userId)
    .maybeSingle()
  if (res.error) {
    if (missingSchema(res.error) || /privacy_/i.test(res.error.message || "")) {
      return { unavailable: true }
    }
    throw new Error(niceError(res.error))
  }
  return {
    unavailable: false,
    privacy_accepted_at: res.data?.privacy_accepted_at ?? null,
    privacy_version: res.data?.privacy_version ?? null,
  }
}

/** Record that the signed-in account has accepted `version` of the Privacy
 *  Policy. Writes through the accept_privacy() SECURITY DEFINER RPC: the
 *  profiles row is not directly updatable from the browser, and these two
 *  columns are no exception. */
export async function acceptPrivacy(version) {
  if (!version) throw new Error("A privacy policy version is required.")
  const { error } = await supabase.rpc("accept_privacy", { p_version: version })
  if (error) throw new Error(niceError(error))
}

/* ------------------------------------------------------------------ admin */

export async function adminDashboard() {
  return unwrap(await supabase.rpc("admin_dashboard"), null)
}

export async function listUpstreams() {
  return unwrap(
    await supabase.from("upstreams").select("*").order("priority").order("name"),
    [],
  )
}

export async function saveUpstream(payload) {
  const urlProblem = validateUpstreamBaseUrl(payload?.base_url)
  if (urlProblem) throw new Error(urlProblem)
  const row = {
    name: payload.name?.trim(),
    slug: (payload.slug || payload.name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    base_url: payload.base_url?.trim().replace(/\/+$/, ""),
    chat_path: payload.chat_path?.trim() || "/chat/completions",
    models_path: payload.models_path?.trim() || "/models",
    health_path: payload.health_path?.trim() || payload.models_path?.trim() || "/models",
    auth_scheme: payload.auth_scheme || "bearer",
    auth_header: payload.auth_header?.trim() || "Authorization",
    auth_query_arg: payload.auth_query_arg?.trim() || null,
    priority: Number(payload.priority) || 100,
    timeout_ms: Number(payload.timeout_ms) || 60000,
    is_active: payload.is_active !== false,
    notes: payload.notes?.trim() || null,
  }
  if (payload.extra_headers !== undefined) {
    row.extra_headers =
      typeof payload.extra_headers === "string"
        ? JSON.parse(payload.extra_headers || "{}")
        : payload.extra_headers || {}
  }
  if (payload.id) {
    return unwrap(
      await supabase.from("upstreams").update(row).eq("id", payload.id).select().single(),
      null,
    )
  }
  return unwrap(await supabase.from("upstreams").insert(row).select().single(), null)
}

export async function deleteUpstream(id) {
  unwrap(await supabase.from("upstreams").delete().eq("id", id), null)
}

export async function listUpstreamKeys() {
  return unwrap(await supabase.from("admin_upstream_keys").select("*"), [])
}

export async function addUpstreamKey({ upstream_id, label, api_key, weight, notes, expires_at }) {
  return unwrap(
    await supabase
      .from("upstream_keys")
      .insert({
        upstream_id,
        label: label?.trim() || "key",
        api_key: api_key.trim(),
        weight: Number(weight) || 100,
        notes: notes?.trim() || null,
        expires_at: expires_at || null,
      })
      .select("id")
      .single(),
    null,
  )
}

export async function updateUpstreamKey(id, patch) {
  unwrap(await supabase.from("upstream_keys").update(patch).eq("id", id), null)
}

export async function deleteUpstreamKey(id) {
  unwrap(await supabase.from("upstream_keys").delete().eq("id", id), null)
}

export async function setUpstreamKeyStatus(id, status, note = null) {
  unwrap(
    await supabase.rpc("admin_set_upstream_key_status", {
      p_key_id: id,
      p_status: status,
      p_note: note,
    }),
    null,
  )
}

export async function revealUpstreamKey(id) {
  return unwrap(await supabase.rpc("admin_reveal_upstream_key", { p_key_id: id }), "")
}

export async function listKeyChecks(keyId, limit = 10) {
  return unwrap(
    await supabase
      .from("upstream_key_checks")
      .select("*")
      .eq("upstream_key_id", keyId)
      .order("created_at", { ascending: false })
      .limit(limit),
    [],
  )
}

/* --------------------------------------------------- deadlines & rotation */

/* Driven by supabase/upgrade-v6.0-timeouts.sql. Every reader below returns
   null — instead of throwing — when that file has not been run yet, because
   the admin panel uses null to mean "not installed" and renders itself
   read-only next to an install hint rather than breaking. An empty array
   still means "installed, nothing to show". */

export const TIMEOUTS_UPGRADE_FILE = "upgrade-v6.0-timeouts.sql"

/** True when a failure is really "this view/function does not exist here yet"
 *  rather than an error worth putting in front of the operator. */
function missingSchema(error) {
  if (!error) return false
  const code = String(error.code || "")
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return true
  }
  const msg = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`
  return /does not exist|could not find|schema cache/i.test(msg)
}

/** Read one of the v6.0 admin views. null = upgrade not installed. */
async function readTimeoutView(view) {
  const { data, error } = await supabase.from(view).select("*")
  if (!error) return data ?? []
  if (missingSchema(error)) return null
  throw new Error(niceError(error))
}

/** Call one of the v6.0 admin RPCs, with the same null contract. */
async function callTimeoutRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (!error) return data ?? null
  if (missingSchema(error)) return null
  throw new Error(niceError(error))
}

/** Blank stays blank: the RPCs treat null as "inherit", and sending "" would
 *  fail their ::int cast instead. */
function intOrNull(value, lo, hi) {
  if (value === "" || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(Math.trunc(n), lo), hi)
}

function boolOrNull(value) {
  if (value === "" || value === null || value === undefined) return null
  return Boolean(value)
}

/** One row per model: the deadline that applies, where it came from, and how
 *  the last 24h actually went. Backs the routing table. */
export async function listRouteTimeouts() {
  return readTimeoutView("admin_route_timeouts")
}

/** One row per provider: the deadline and key budget it hands its models,
 *  plus key-pool health. */
export async function listProviderHealth() {
  return readTimeoutView("admin_provider_health")
}

/** One row per upstream key: stalls, cooldown and last result. */
export async function listKeyRotation() {
  return readTimeoutView("admin_key_rotation")
}

/** The workspace-wide deadline defaults. Admin only. */
export async function getTimeoutSettings() {
  return callTimeoutRpc("admin_get_timeout_settings", {})
}

/* Bounds mirror admin_save_timeout_settings(); clamping here just keeps the
   form honest before the round trip. */
const TIMEOUT_SETTING_RANGES = {
  default_timeout_ms: [1000, 600000],
  max_key_attempts: [1, 10],
  key_cooldown_seconds: [0, 3600],
  max_failover_hops: [1, 10],
}
const TIMEOUT_SETTING_FLAGS = ["retry_on_timeout", "failover_enabled"]

/** Patch any subset of the defaults. Returns the saved settings, or null when
 *  the upgrade has not been run. */
export async function saveTimeoutSettings(patch) {
  const clean = {}
  for (const [key, [lo, hi]] of Object.entries(TIMEOUT_SETTING_RANGES)) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, key)) continue
    const n = intOrNull(patch[key], lo, hi)
    if (n !== null) clean[key] = n
  }
  for (const key of TIMEOUT_SETTING_FLAGS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      clean[key] = Boolean(patch[key])
    }
  }
  if (!Object.keys(clean).length) return null
  return callTimeoutRpc("admin_save_timeout_settings", { p_patch: clean })
}

/** Per-model deadline. Blank or null means inherit the provider's value. */
export async function setModelTimeout(modelId, timeoutMs = null, maxKeyAttempts = null) {
  return callTimeoutRpc("admin_set_model_timeout", {
    p_model_id: modelId,
    p_timeout_ms: intOrNull(timeoutMs, 1000, 600000),
    p_max_key_attempts: intOrNull(maxKeyAttempts, 1, 10),
  })
}

/** Per-provider deadline, key budget, and whether a stall may rotate keys. */
export async function setUpstreamTimeout(
  upstreamId,
  timeoutMs = null,
  maxKeyAttempts = null,
  retryOnTimeout = null,
) {
  return callTimeoutRpc("admin_set_upstream_timeout", {
    p_upstream_id: upstreamId,
    p_timeout_ms: intOrNull(timeoutMs, 1000, 600000),
    p_max_key_attempts: intOrNull(maxKeyAttempts, 1, 10),
    p_retry_on_timeout: boolOrNull(retryOnTimeout),
  })
}

/** Let a cooling key back into rotation now. */
export async function clearKeyCooldown(keyId) {
  return callTimeoutRpc("admin_clear_key_cooldown", { p_key_id: keyId })
}

/* ------------------------------------------------- admin edge function io */

const FN_NAME = "admin-check-keys"
const DEPLOY_HINT = `supabase functions deploy ${FN_NAME} --no-verify-jwt`

/**
 * `TypeError: Failed to fetch` is all the browser will ever tell JavaScript:
 * the request was blocked or dropped before a response existed, so there is no
 * status code to report. These are the four things that actually cause it.
 */
function networkDiagnosis(url) {
  return [
    `Could not reach ${url} — the browser dropped the request before any response came back.`,
    "",
    "Check in this order:",
    `1. The function is deployed:  ${DEPLOY_HINT}`,
    `2. It was deployed WITHOUT --no-verify-jwt. Supabase then rejects the browser's CORS preflight itself, before your code runs, and the browser shows it as "Failed to fetch". Redeploy with the flag.`,
    "3. VITE_SUPABASE_URL in .env matches your project URL — and the dev server was restarted after editing .env.",
    "4. No ad blocker, offline tab, or corporate proxy is eating the call.",
  ].join("\n")
}

/**
 * One POST to an admin Edge Function.
 *
 * `force` re-mints the bridge session before building the headers, which is
 * what makes the 401 retry below work: the old behaviour reused a stale cached
 * token and reported "Your session is not valid. Sign in again, then retry."
 * even though the tab was signed in the whole time.
 */
async function postEdgeFn(url, body, { timeoutMs = 30000, force = false } = {}) {
  let headers
  try {
    headers = await edgeHeaders({ force })
  } catch (err) {
    const signedOut = new Error(
      err?.message || "Your session expired. Sign in again, then retry.",
    )
    signedOut.signedOut = true
    throw signedOut
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: "POST",
      // `apikey` gets you past Supabase's edge gateway, `authorization` and
      // `x-firebase-token` tell the function which admin is calling.
      headers,
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function callAdminFn(body, { timeoutMs = 45000 } = {}) {
  if (!FUNCTIONS_URL) {
    throw new Error(
      "Supabase is not configured. Add VITE_SUPABASE_URL to .env and restart the dev server.",
    )
  }

  /* v10: the access token is minted by the firebase-auth bridge, not by
     GoTrue, so it comes from firebaseBridge rather than supabase.auth. Same
     bearer-token contract on the wire - the functions still receive a
     Supabase-signed JWT whose `sub` is this user's uuid. */
  const url = `${FUNCTIONS_URL}/${FN_NAME}`

  /* Retry once with a freshly minted session. A 401/403 here is almost never
     "this person is not an admin" - it is a token that went stale while the
     tab sat open, or one minted before the function could read its secret. */
  let res
  try {
    res = await postEdgeFn(url, body, { timeoutMs })
    if (res.status === 401 || res.status === 403) {
      res = await postEdgeFn(url, body, { timeoutMs, force: true })
    }
  } catch (err) {
    if (err?.signedOut) throw err
    if (err?.name === "AbortError") {
      throw new Error(
        `Gave up after ${Math.round(timeoutMs / 1000)}s — the upstream never answered.`,
      )
    }
    throw new Error(networkDiagnosis(url))
  }

  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    /* keep raw text */
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`${FN_NAME} is not deployed on this project yet. Run:\n${DEPLOY_HINT}`)
    }
    if ((res.status === 401 || res.status === 403) && !payload?.error) {
      throw new Error(
        `Supabase rejected the call before it reached your function (${res.status}). Redeploy with:\n${DEPLOY_HINT}`,
      )
    }
    throw new Error(
      payload?.error?.message || text?.slice(0, 300) || `Request failed (${res.status}).`,
    )
  }
  return payload ?? {}
}

/** Liveness probe — proves whether the function is deployed and reachable. */
export async function pingAdminFn() {
  const started = performance.now()
  const res = await callAdminFn({ action: "ping" }, { timeoutMs: 12000 })
  return { ...res, elapsed: Math.round(performance.now() - started) }
}

/** Health-checks STORED keys: `{}` = all, or `{ key_id }` / `{ upstream_id }`. */
export async function testUpstreamKeys(body = {}) {
  return callAdminFn({ action: "check", ...body })
}

/** Tests a pasted key that is not in the database yet. Writes nothing. */
export async function probeUpstreamKey({ upstream_id, api_key, label }) {
  if (!upstream_id) throw new Error("Choose which upstream this key belongs to first.")
  if (!String(api_key || "").trim()) throw new Error("Paste the API key you want to test.")
  return callAdminFn(
    { action: "probe", upstream_id, api_key: String(api_key).trim(), label },
    { timeoutMs: 30000 },
  )
}

/** Reads an upstream's own model catalogue, normalised into importable rows. */
export async function scanUpstreamModels({ upstream_id, api_key, key_id }) {
  if (!upstream_id) throw new Error("Choose an upstream to scan.")
  return callAdminFn(
    {
      action: "scan",
      upstream_id,
      api_key: String(api_key || "").trim() || undefined,
      key_id: key_id || undefined,
    },
    { timeoutMs: 40000 },
  )
}

/** Upstream model id -> the public alias your users will send. */
export function publicIdFor(modelId, prefix = "") {
  const slug = String(modelId || "")
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const head = String(prefix || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return head ? `${head}-${slug}` : slug
}

const round4 = (x) => Number((Number(x) || 0).toFixed(4))

/** Bulk-creates model mappings from a scan result. */
export async function importScannedModels({
  upstream_id,
  models = [],
  prefix = "",
  markup = 1,
  fallbackPriceIn = 0,
  fallbackPriceOut = 0,
  status = "active",
  overwrite = false,
}) {
  if (!upstream_id) throw new Error("Choose an upstream first.")
  if (!models.length) throw new Error("Select at least one model to import.")

  const mult = Number(markup) > 0 ? Number(markup) : 1
  const rows = models.map((m, i) => ({
    public_id: publicIdFor(m.id, prefix),
    display_name: m.display_name || m.id,
    upstream_id,
    upstream_model_id: m.id,
    description: m.description || null,
    context_window: m.context_window ?? null,
    max_output_tokens: m.max_output_tokens ?? null,
    price_in_per_m: round4(((m.price_in_per_m ?? Number(fallbackPriceIn)) || 0) * mult),
    price_out_per_m: round4(((m.price_out_per_m ?? Number(fallbackPriceOut)) || 0) * mult),
    capabilities: m.capabilities?.length ? m.capabilities : ["chat"],
    status,
    is_active: status === "active",
    sort_order: 100 + i,
  }))

  const written = unwrap(
    await supabase
      .from("models")
      .upsert(rows, { onConflict: "public_id", ignoreDuplicates: !overwrite })
      .select("id,public_id"),
    [],
  )
  const count = written?.length ?? 0
  return { requested: rows.length, written: count, skipped: Math.max(rows.length - count, 0) }
}

export async function listAdminModels() {
  return unwrap(
    await supabase
      .from("models")
      .select("*, upstreams(name,slug)")
      .order("sort_order")
      .order("public_id"),
    [],
  )
}

export async function saveModel(payload) {
  const row = {
    public_id: payload.public_id?.trim(),
    display_name: payload.display_name?.trim() || payload.public_id?.trim(),
    upstream_id: payload.upstream_id,
    upstream_model_id: payload.upstream_model_id?.trim(),
    description: payload.description?.trim() || null,
    context_window: payload.context_window ? Number(payload.context_window) : null,
    max_output_tokens: payload.max_output_tokens ? Number(payload.max_output_tokens) : null,
    price_in_per_m: Number(payload.price_in_per_m) || 0,
    price_out_per_m: Number(payload.price_out_per_m) || 0,
    capabilities: Array.isArray(payload.capabilities)
      ? payload.capabilities
      : String(payload.capabilities || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
    status: payload.status || "active",
    is_active: payload.is_active !== false,
    sort_order: Number(payload.sort_order) || 100,
    /* Per-model response deadline (v6.0). Empty means "inherit the provider",
       which is why it is written as null rather than 0. */
    timeout_ms: payload.timeout_ms ? clampInt(payload.timeout_ms, 1000, 600000) : null,
    max_key_attempts: payload.max_key_attempts
      ? clampInt(payload.max_key_attempts, 1, 10)
      : null,
    /* Who may call it (v12.4). 'early_access' hides the model from everyone
       whose role is not early_access or admin, in the catalogue and at the
       gateway. */
    access_tier: payload.access_tier === "early_access" ? "early_access" : "public",
    access_note: payload.access_note?.trim() || null,
  }

  const write = (r) =>
    payload.id
      ? supabase.from("models").update(r).eq("id", payload.id).select().single()
      : supabase.from("models").insert(r).select().single()

  let res = await write(row)
  /* The two access columns only exist once upgrade-v12.4-early-access.sql has
     been applied. Save the rest rather than refusing the edit. */
  if (res.error && (missingSchema(res.error) || /access_tier|access_note/i.test(res.error.message || ""))) {
    const { access_tier: _t, access_note: _n, ...rest } = row
    res = await write(rest)
  }
  return unwrap(res, null)
}

export async function deleteModel(id) {
  unwrap(await supabase.from("models").delete().eq("id", id), null)
}

export async function listUsers() {
  return unwrap(await supabase.from("admin_users").select("*"), [])
}

/* v12.4 roles. early_access sits between the two: a normal account that can
   also see and call models marked access_tier = 'early_access'. */
export const EARLY_ACCESS_UPGRADE_FILE = "upgrade-v12.4-early-access.sql"

export const ROLES = [
  { value: "user", label: "User", hint: "Public models only" },
  { value: "early_access", label: "Early access", hint: "Public + early access models" },
  { value: "admin", label: "Admin", hint: "Everything, including this panel" },
]

export function roleLabel(role) {
  return ROLES.find((r) => r.value === role)?.label || role || "user"
}

export async function setUserRole(id, role) {
  if (!ROLES.some((r) => r.value === role)) throw new Error(`Unknown role "${role}".`)
  const { error } = await supabase.rpc("admin_set_user_role", { p_user_id: id, p_role: role })
  if (error) {
    /* The old function only accepted user/admin. */
    if (role === "early_access" && /invalid role|profiles_role_check/i.test(error.message || "")) {
      throw new Error(`Run supabase/${EARLY_ACCESS_UPGRADE_FILE} first — early access is not installed yet.`)
    }
    throw new Error(niceError(error))
  }
}

/** Flip early access on one account without walking the whole role menu. */
export async function setEarlyAccess(id, on) {
  const { error } = await supabase.rpc("admin_set_early_access", {
    p_user_id: id,
    p_on: Boolean(on),
  })
  if (error) {
    if (missingSchema(error)) {
      throw new Error(`Run supabase/${EARLY_ACCESS_UPGRADE_FILE} first — early access is not installed yet.`)
    }
    throw new Error(niceError(error))
  }
}

/** Put a published model behind early access, or hand it back to everyone. */
export async function setModelAccess(modelId, tier, note = null) {
  const { error } = await supabase.rpc("admin_set_model_access", {
    p_model_id: modelId,
    p_tier: tier === "early_access" ? "early_access" : "public",
    p_note: note,
  })
  if (error) {
    if (missingSchema(error)) {
      throw new Error(`Run supabase/${EARLY_ACCESS_UPGRADE_FILE} first — early access is not installed yet.`)
    }
    throw new Error(niceError(error))
  }
}

/** { teaser, tier, models } — or null when the upgrade has not been run. */
export async function earlyAccessConfig() {
  const { data, error } = await supabase.rpc("early_access_config")
  if (error) return missingSchema(error) ? null : Promise.reject(new Error(niceError(error)))
  return data ?? null
}

/** Show or hide locked models in the public catalogue. */
export async function saveEarlyAccessConfig(teaser) {
  const { data, error } = await supabase.rpc("admin_save_early_access", {
    p_teaser: Boolean(teaser),
  })
  if (error) {
    if (missingSchema(error)) {
      throw new Error(`Run supabase/${EARLY_ACCESS_UPGRADE_FILE} first — early access is not installed yet.`)
    }
    throw new Error(niceError(error))
  }
  return data ?? null
}

export async function setUserStatus(id, status) {
  unwrap(await supabase.rpc("admin_set_user_status", { p_user_id: id, p_status: status }), null)
}

export async function listIssuedKeys(limit = 100) {
  return unwrap(
    await supabase
      .from("api_keys")
      .select("id,user_id,name,environment,key_prefix,key_last4,status,spend_usd,request_count,last_used_at,created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    [],
  )
}

export async function listAllLogs(limit = 100) {
  /* Request logs exclude community-gate refusals (v12.10): those are policy
     denials, not routed traffic, and live in their own surface.

     The exclusion is `community_gate_denied = false`, never `neq` on
     error_code. PostgREST renders neq as SQL `<>`, and `null <> 'x'` is null,
     not true - so filtering on error_code silently discarded every SUCCESSFUL
     call (error_code is null on those) and the tab read "No traffic yet"
     while request_logs was full. The boolean marker is not null (default
     false), so eq() keeps successes and still drops the denials. */
  const res = await supabase
    .from("admin_request_logs")
    .select("*")
    .eq("community_gate_denied", false)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (res.error) {
    /* A database older than v12.10 has no community_gate_denied column; read
       unfiltered and drop the denials here instead of failing the tab. */
    if (!missingObject(res.error)) throw new Error(niceError(res.error))
    const plain = await supabase
      .from("admin_request_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit)
    if (plain.error) {
      if (missingObject(plain.error)) return []
      throw new Error(niceError(plain.error))
    }
    return (plain.data ?? []).filter((r) => !r.community_gate_denied)
  }

  return res.data ?? []
}

/* Community-gate refusals (v12.10). Reads come back empty (not an error) until
   upgrade-v12.10-community-gate-visibility.sql has been applied. */
export async function listGateDenials(limit = 200) {
  const res = await supabase
    .from("admin_gate_denials")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (res.error) {
    if (missingObject(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data ?? []
}

export async function myGateDenials(limit = 100) {
  const res = await supabase
    .from("my_gate_denials")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (res.error) {
    if (missingObject(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data ?? []
}

export async function listAudit(limit = 50) {
  return unwrap(
    await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(limit),
    [],
  )
}

/* Only these settings may be written from the browser. Anything else in the
   payload is dropped before it reaches the database, so a tampered form (or a
   console one-liner) cannot touch admin_emails-adjacent columns by accident. */
const SETTINGS_WRITABLE = {
  brand_name: "text",
  gateway_url: "text",
  signup_enabled: "bool",
  default_policy: "text",
  failover_enabled: "bool",
  max_failover_hops: "int",
  log_retention_days: "int",
  credits_enabled: "bool",
  signup_credit_usd: "num",
  low_balance_usd: "num",
  overdraft_usd: "num",
  topup_note: "text",
  admin_emails: "emails",
  allowed_email_domains: "domains",
  five_hour_limit_usd: "num",
  weekly_limit_usd: "num",
  discord_join_credit_usd: "num",
  /* v12.9 — the Discord API gate switch (Admin → Settings → Discord) */
  discord_required: "bool",
}

function coerceSetting(kind, value) {
  if (kind === "bool") return value === true || value === "yes" || value === "true" || value === "on"
  if (kind === "int") return Math.trunc(Number(value) || 0)
  if (kind === "num") return Number(value) || 0
  if (kind === "emails" || kind === "domains") {
    const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/)
    return list.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
  }
  return String(value ?? "").replace(/[<>]/g, "").slice(0, 500)
}

function pickSettings(patch) {
  const out = {}
  for (const [key, kind] of Object.entries(SETTINGS_WRITABLE)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = coerceSetting(kind, patch[key])
    }
  }
  return out
}

/** Settings are written through admin_save_settings(), a SECURITY DEFINER RPC
 *  that re-checks admin rights and validates every value server-side. Direct
 *  table writes are revoked by upgrade-v5.5-security.sql. */
export async function saveSettings(patch) {
  const clean = pickSettings(patch)
  if (!Object.keys(clean).length) return

  const rpc = await supabase.rpc("admin_save_settings", { p_patch: clean })
  if (!rpc.error) return

  const msg = String(rpc.error.message || "")
  const notInstalled = /admin_save_settings|could not find|does not exist|schema cache/i.test(msg)
  if (!notInstalled) throw new Error(niceError(rpc.error))

  /* database has not run upgrade-v5.5-security.sql yet */
  unwrap(await supabase.from("app_settings").update(clean).eq("id", 1), null)
}

/* ------------------------------------------------------------- playground */

/** Calls YOUR gateway with a customer key — exactly what an end user would do. */
export async function callGateway({ apiKey, model, prompt, signal }) {
  if (!GATEWAY_URL) throw new Error("Gateway URL is not configured.")
  const started = performance.now()
  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    signal,
  })
  const elapsed = Math.round(performance.now() - started)
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* keep raw */
  }
  return {
    ok: res.ok,
    status: res.status,
    elapsed,
    headers: {
      model: res.headers.get("x-rs-model"),
      failover: res.headers.get("x-rs-failover"),
      latency: res.headers.get("x-rs-latency-ms"),
      cost: res.headers.get("x-rs-cost-usd"),
      credits:
        res.headers.get("x-rs-credits-remaining") ?? res.headers.get("x-rs-credits-usd"),
      requestId: res.headers.get("x-rs-request-id"),
    },
    content: body?.choices?.[0]?.message?.content ?? null,
    error: body?.error?.message ?? (res.ok ? null : text.slice(0, 300)),
    raw: body ?? text,
  }
}

/**
 * Streaming variant of callGateway — the same request an OpenAI SDK would
 * make, read as server-sent events.
 *
 * `onDelta(text)` fires per chunk so the caller can paint tokens as they
 * arrive. Resolves with the timing the playground shows: time to first token,
 * output tokens and wall clock. Token counts come from the final `usage`
 * chunk when the router sends one (stream_options), otherwise they are
 * estimated from the characters actually streamed — a number labelled as an
 * estimate is better than nothing, but it is never presented as exact.
 */
export async function streamGateway({
  apiKey,
  model,
  messages,
  temperature,
  topP,
  maxTokens,
  signal,
  onDelta,
}) {
  if (!GATEWAY_URL) throw new Error("Gateway URL is not configured.")
  const started = performance.now()

  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      /* Ask for a usage chunk; harmless when the router ignores it. */
      stream_options: { include_usage: true },
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
    }),
    signal,
  })

  if (!res.ok || !res.body) {
    const text = await res.text()
    let msg = text.slice(0, 300)
    try {
      msg = JSON.parse(text)?.error?.message ?? msg
    } catch {
      /* keep the raw slice */
    }
    throw new Error(msg || `Gateway returned ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let ttft = null
  let chars = 0
  let usageTokens = null

  /* SSE frames are separated by a blank line; a chunk may be split across
     reads, so everything waits in `buffer` until a full frame lands. */
  const flush = (line) => {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith("data:")) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      return /* keep-alive or a frame we do not understand */
    }
    if (chunk?.usage?.completion_tokens != null) usageTokens = chunk.usage.completion_tokens
    const delta = chunk?.choices?.[0]?.delta?.content
    if (delta) {
      if (ttft == null) ttft = Math.round(performance.now() - started)
      chars += delta.length
      onDelta?.(delta)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split("\n\n")
    /* the last element may be an incomplete frame — put it back */
    buffer = frames.pop() ?? ""
    for (const frame of frames) {
      for (const line of frame.split("\n")) flush(line)
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) flush(line)
  }

  return {
    ttft: ttft ?? Math.round(performance.now() - started),
    tokens: usageTokens ?? Math.max(1, Math.round(chars / 4)),
    tokensEstimated: usageTokens == null,
    total: Math.round(performance.now() - started),
    headers: {
      model: res.headers.get("x-rs-model"),
      failover: res.headers.get("x-rs-failover"),
      cost: res.headers.get("x-rs-cost-usd"),
      credits: res.headers.get("x-rs-credits-remaining") ?? res.headers.get("x-rs-credits-usd"),
      requestId: res.headers.get("x-rs-request-id"),
    },
  }
}

/* ==========================================================================
   REFERRALS  (supabase/upgrade-v5.9-referrals.sql)
   ========================================================================== */

/* Where invite and referral links point.
 *
 * A dev server hands out http://localhost:5173/... which is useless to anybody
 * but the person running it, so localhost and every other private address is
 * never used in a link. Order of preference:
 *
 *   1. VITE_SITE_URL                 - say it once, in the env
 *   2. the gateway host, de-prefixed - gw.example.com -> https://example.com
 *   3. the current origin            - only when it is publicly reachable
 *   4. PUBLIC_SITE_FALLBACK          - last resort
 */
export const PUBLIC_SITE_FALLBACK = "https://ragestar.bond"

function isLocalHost(host) {
  const h = String(host || "")
    .toLowerCase()
    .replace(/:\d+$/, "")
  if (!h) return true
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true
  if (h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".test")) return true
  if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.")) return true
  return /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

function publicOrigin(raw) {
  const value = String(raw || "").trim()
  if (!value) return ""
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value)
    if (isLocalHost(url.hostname)) return ""
    const scheme = url.protocol === "http:" ? "https:" : url.protocol
    return scheme + "//" + url.host
  } catch (e) {
    return ""
  }
}

/* gw.ragestar.bond/v1 -> https://ragestar.bond */
function gatewaySiteOrigin() {
  const base = publicOrigin(import.meta.env?.VITE_GATEWAY_URL)
  if (!base) return ""
  try {
    const url = new URL(base)
    return "https://" + url.hostname.replace(/^(gw|api|gateway)\./i, "")
  } catch (e) {
    return ""
  }
}

export function siteOrigin() {
  const declared = publicOrigin(import.meta.env?.VITE_SITE_URL)
  if (declared) return declared

  const derived = gatewaySiteOrigin()
  if (derived) return derived

  const here = typeof window === "undefined" ? "" : window.location?.origin
  const live = publicOrigin(here)
  if (live) return live

  return PUBLIC_SITE_FALLBACK
}

/** The link a user shares. `?ref=` is read by Signup.jsx. */
export function referralLink(code) {
  const clean = String(code || "").trim().toUpperCase()
  if (!clean) return ""
  return `${siteOrigin()}/#/signup?ref=${encodeURIComponent(clean)}`
}

/* A database that has not run upgrade-v5.9 yet should degrade quietly rather
   than red-banner the whole console, exactly like myCredits() does for v5.4. */
function notInstalled(error) {
  return /my_referral|referrals|admin_referrals|admin_settle_referral|could not find|does not exist|schema cache/i.test(
    String(error?.message || ""),
  )
}

/** Code + totals for the Referrals tab. */
export async function myReferral() {
  const res = await supabase.rpc("my_referral")
  if (res.error) {
    if (notInstalled(res.error)) return { unavailable: true }
    throw new Error(niceError(res.error))
  }
  return res.data ?? { unavailable: true }
}

/** Who accepted, with the invitee's address partly masked by the view. */
export async function listMyReferrals() {
  const res = await supabase.from("my_referrals").select("*")
  if (res.error) {
    if (notInstalled(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data ?? []
}

/* ------------------------------------------------------------ admin side */

export async function adminReferrals() {
  const res = await supabase.from("admin_referrals").select("*").limit(500)
  if (res.error) {
    if (notInstalled(res.error)) return []
    throw new Error(niceError(res.error))
  }
  return res.data ?? []
}

/** Pays a held referral. Only needed when referral_reward_on = 'manual'. */
export async function settleReferral(id) {
  return unwrap(await supabase.rpc("admin_settle_referral", { p_referral_id: id }), null)
}

/** Kills a referral: self-invites, throwaways, obvious farming. */
export async function voidReferral(id, note = null) {
  return unwrap(
    await supabase.rpc("admin_void_referral", { p_referral_id: id, p_note: note }),
    null,
  )
}

export async function getReferralSettings() {
  const cols =
    "referrals_enabled,referral_reward_usd,referral_bonus_usd,referral_reward_on,referral_max_per_user"
  const res = await supabase.from("app_settings").select(cols).eq("id", 1).maybeSingle()
  if (res.error) {
    if (notInstalled(res.error)) return null
    throw new Error(niceError(res.error))
  }
  return res.data ?? null
}

export async function saveReferralSettings(patch) {
  const clean = {}
  if ("referrals_enabled" in patch) clean.referrals_enabled = !!patch.referrals_enabled
  if ("referral_reward_usd" in patch) clean.referral_reward_usd = Number(patch.referral_reward_usd) || 0
  if ("referral_bonus_usd" in patch) clean.referral_bonus_usd = Number(patch.referral_bonus_usd) || 0
  if ("referral_reward_on" in patch) {
    clean.referral_reward_on = patch.referral_reward_on === "manual" ? "manual" : "signup"
  }
  if ("referral_max_per_user" in patch) {
    clean.referral_max_per_user = Math.max(0, Math.trunc(Number(patch.referral_max_per_user) || 0))
  }
  if (!Object.keys(clean).length) return null
  return unwrap(await supabase.rpc("admin_save_referral_settings", { p_patch: clean }), null)
}

/* ==========================================================================
   ADMIN ACCOUNT RECOVERY
   --------------------------------------------------------------------------
   There is no "read this user's password" call here, and there cannot be one.
   Supabase Auth keeps a bcrypt hash in auth.users.encrypted_password; hashing
   is one-way, so the plaintext was never stored and nothing can return it —
   not the service role, not raw SQL. What an admin actually needs when someone
   is locked out is covered below: a one-time reset link, a temporary password
   the admin sets (and therefore knows), and the ability to end every session.
   All three write an audit_logs row naming the admin who ran them.
   ========================================================================== */

const ACCOUNT_FN = "admin-account"
const ACCOUNT_HINT = `supabase functions deploy ${ACCOUNT_FN} --no-verify-jwt`

async function callAccountFn(body, { timeoutMs = 25000 } = {}) {
  if (!FUNCTIONS_URL) {
    throw new Error(
      "Supabase is not configured. Add VITE_SUPABASE_URL to .env and restart the dev server.",
    )
  }

  /* v10: the access token is minted by the firebase-auth bridge, not by
     GoTrue, so it comes from firebaseBridge rather than supabase.auth. Same
     bearer-token contract on the wire - the functions still receive a
     Supabase-signed JWT whose `sub` is this user's uuid. */
  const url = `${FUNCTIONS_URL}/${ACCOUNT_FN}`

  /* Same one-shot retry as callAdminFn: mint a new session and replay before
     telling the admin their session is invalid. */
  let res
  try {
    res = await postEdgeFn(url, body, { timeoutMs })
    if (res.status === 401 || res.status === 403) {
      res = await postEdgeFn(url, body, { timeoutMs, force: true })
    }
  } catch (err) {
    if (err?.signedOut) throw err
    if (err?.name === "AbortError") throw new Error("Timed out waiting for the auth API.")
    throw new Error(
      `Could not reach ${url}. Deploy it with:\n${ACCOUNT_HINT}\n\nDeploying without --no-verify-jwt makes Supabase reject the browser's CORS preflight, which shows up as "Failed to fetch".`,
    )
  }

  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    /* keep raw text */
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`${ACCOUNT_FN} is not deployed yet. Run:\n${ACCOUNT_HINT}`)
    }
    if ((res.status === 401 || res.status === 403) && !payload?.error) {
      throw new Error(
        `Supabase rejected the call before it reached the function (${res.status}). Redeploy with:\n${ACCOUNT_HINT}`,
      )
    }
    throw new Error(payload?.error?.message || text?.slice(0, 300) || `Failed (${res.status}).`)
  }
  return payload ?? {}
}

/** Is the recovery function deployed? */
export async function pingAccountFn() {
  return callAccountFn({ action: "ping" }, { timeoutMs: 12000 })
}

/** Credential facts an admin may legitimately see. Never a password value. */
export async function accountSecurity(userId) {
  const res = await supabase.rpc("admin_account_security", { p_user_id: userId })
  if (!res.error) return res.data ?? null
  if (!notInstalled(res.error)) throw new Error(niceError(res.error))
  /* v5.9 not applied — the edge function can answer from the auth admin API */
  return callAccountFn({ action: "security", user_id: userId })
}

/** One-time recovery link to hand to the account owner. */
export async function passwordResetLink(userId) {
  const out = await callAccountFn({ action: "reset_link", user_id: userId })
  if (!out?.link) throw new Error("The auth API did not return a link. Check the function logs.")
  return out
}

/** Sets a password the admin chooses (or a generated one) and returns it once.
 *  The previous password is never revealed — it is replaced. */
export async function setTempPassword(userId, password = null) {
  const body = { action: "temp_password", user_id: userId }
  if (password) body.password = String(password)
  return callAccountFn(body)
}

/** Ends every live session for an account, immediately. */
export async function forceSignOut(userId) {
  const res = await supabase.rpc("admin_force_signout", { p_user_id: userId })
  if (!res.error) return res.data ?? { ok: true }
  if (!notInstalled(res.error)) throw new Error(niceError(res.error))
  return callAccountFn({ action: "signout_all", user_id: userId })
}

/* ------------------------------------------------------- token compressors */
/* The table arrives with supabase/upgrade-v9.0-token-compressors.sql. Before
   that file is run the tab still has to be usable — otherwise you cannot see
   what you are about to install — so rows fall back to this browser and each
   one is flagged `_local`. The tab reads that flag and says out loud that the
   router is not applying them yet. */

export const COMPRESSOR_UPGRADE_FILE = "upgrade-v9.0-token-compressors.sql"

/* v9 shipped these columns; v11 adds the ponytail ones. PostgREST rejects the
   whole select if a single named column is unknown, so the wide list is tried
   first and the answer is remembered for the rest of the session — a v10
   database keeps working, it just cannot edit ponytail settings. */
export const KEYWATCH_UPGRADE_FILE = "upgrade-v11.0-keywatch-and-ponytail.sql"
/* v11.3 moved the schedule out of Cloudflare and into pg_cron. The card names
   this file when the beat is installed but nothing is scheduling it. */
export const KEYWATCH_SCHEDULE_FILE = "upgrade-v11.3-keywatch-in-postgres.sql"

const COMPRESSOR_COLS_BASE =
  "id,slug,name,description,stages,scope,min_tokens,max_chars,preserve_code,priority,is_active,model_ids"

const PONYTAIL_FIELDS = [
  "mode",
  "head_messages",
  "keep_system",
  "tail_chars",
  "tail_digest",
  "keep_entities",
]

const COMPRESSOR_COLS_V11 = `${COMPRESSOR_COLS_BASE},${PONYTAIL_FIELDS.join(",")}`

let ponytailColumns = true

function compressorCols() {
  return ponytailColumns ? COMPRESSOR_COLS_V11 : COMPRESSOR_COLS_BASE
}

/** "That column does not exist" — 42703 from Postgres, PGRST204 from the
 *  PostgREST schema cache. Distinct from compressorMissing(), which means the
 *  whole v9 table is absent and the browser fallback should take over. */
function ponytailColumnMissing(error) {
  const code = String(error?.code || "")
  const message = String(error?.message || "")
  if (!PONYTAIL_FIELDS.some((f) => message.includes(f))) return false
  return code === "42703" || code === "PGRST204" || /column|schema cache|could not find/i.test(message)
}

function withoutPonytail(row) {
  const out = { ...row }
  for (const field of PONYTAIL_FIELDS) delete out[field]
  return out
}

/** Fill in what a v10 database cannot store, so the editor always has values. */
function withPonytailDefaults(row) {
  return {
    ...row,
    stages: row?.stages ?? [],
    model_ids: row?.model_ids ?? [],
    mode: row?.mode === "ponytail" ? "ponytail" : "stages",
    head_messages: Number.isFinite(Number(row?.head_messages)) ? Number(row.head_messages) : 4,
    keep_system: row?.keep_system !== false,
    tail_chars: Number(row?.tail_chars) || 700,
    tail_digest: row?.tail_digest !== false,
    keep_entities: row?.keep_entities !== false,
    _ponytail_ready: ponytailColumns,
  }
}

const COMPRESSOR_LOCAL_KEY = "rs-compressors"
const COMPRESSION_OFF_KEY = "rs-compression-off"
const COMPRESSOR_SCOPES = ["all", "user", "system", "history"]

/** True when the failure means "the upgrade has not been run" rather than
 *  something that deserves an error. Postgres answers 42P01, PostgREST
 *  answers PGRST205 for an unknown table and PGRST204 for an unknown column. */
function compressorMissing(error) {
  const code = String(error?.code || "")
  if (code === "42P01" || code === "PGRST205" || code === "PGRST204") return true
  return /token_compressors|compression_enabled|does not exist|schema cache|could not find/i.test(
    String(error?.message || ""),
  )
}

/** Everything the table will accept, coerced. The editor lets you type freely
 *  and this is where that becomes a row: a blank name is still nameable, a
 *  stageless pipeline gets the harmless whitespace pass, and the character
 *  budget cannot be set so low that middle-out truncation eats the prompt. */
function cleanCompressor(payload) {
  const stages = Array.isArray(payload?.stages)
    ? payload.stages.map((s) => String(s).trim()).filter(Boolean)
    : []
  const modelIds = Array.isArray(payload?.model_ids)
    ? payload.model_ids.map((s) => String(s).trim()).filter(Boolean)
    : []
  return {
    name: String(payload?.name || "").trim() || "Untitled compressor",
    slug: slugify(payload?.slug || payload?.name) || "compressor",
    description: String(payload?.description || "").trim() || null,
    stages: stages.length ? stages : ["whitespace"],
    scope: COMPRESSOR_SCOPES.includes(payload?.scope) ? payload.scope : "all",
    min_tokens: Math.max(0, Math.round(Number(payload?.min_tokens) || 0)),
    max_chars: Math.max(200, Math.round(Number(payload?.max_chars) || 6000)),
    preserve_code: payload?.preserve_code !== false,
    priority: Math.round(Number(payload?.priority) || 100),
    is_active: payload?.is_active !== false,
    model_ids: modelIds,
    /* v11 — a ponytail reads the conversation whole. Clamped here so a typed
       "5" in the head field cannot mean five hundred kept turns. */
    mode: payload?.mode === "ponytail" ? "ponytail" : "stages",
    head_messages: Math.min(50, Math.max(0, Math.round(Number(payload?.head_messages ?? 4)))),
    keep_system: payload?.keep_system !== false,
    tail_chars: Math.min(20000, Math.max(120, Math.round(Number(payload?.tail_chars) || 700))),
    tail_digest: payload?.tail_digest !== false,
    keep_entities: payload?.keep_entities !== false,
  }
}

function byPriority(a, b) {
  return (Number(a.priority) || 0) - (Number(b.priority) || 0)
}

/* -- the browser-local fallback ------------------------------------------- */

function localRead() {
  try {
    const raw = window.localStorage.getItem(COMPRESSOR_LOCAL_KEY)
    if (raw) {
      const parsed = safeJsonParse(raw, null)
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    /* private mode, or no window at all */
  }
  /* A first visit shows the shipped presets instead of an empty screen, so the
     shape of the feature is legible before anything is installed. */
  return PRESETS.map((p) => ({ ...cleanCompressor(p), id: `local:${p.slug}` }))
}

function localWrite(list) {
  try {
    window.localStorage.setItem(COMPRESSOR_LOCAL_KEY, JSON.stringify(list))
  } catch {
    /* nothing persistent available; the session still works */
  }
  return list
}

function localFlag(list) {
  return [...list].sort(byPriority).map((row) => ({ ...row, _local: true }))
}

/* -- reads ---------------------------------------------------------------- */

/** Every compressor, lowest priority number first — the order they run in. */
export async function listCompressors() {
  const read = () =>
    supabase
      .from("token_compressors")
      .select(compressorCols())
      .order("priority", { ascending: true })
      .order("name", { ascending: true })

  let res = await read()

  /* A v10 database has the table but not the ponytail columns. Narrow the
     select once and carry on rather than dropping to the local fallback,
     which would silently hide rows the router is really applying. */
  if (res.error && ponytailColumns && ponytailColumnMissing(res.error)) {
    ponytailColumns = false
    res = await read()
  }

  if (!res.error) return (res.data ?? []).map(withPonytailDefaults)
  if (!compressorMissing(res.error)) throw new Error(niceError(res.error))
  return localFlag(localRead()).map(withPonytailDefaults)
}

/** The master switch. Off means the router forwards prompts untouched, while
 *  the compressors keep their own state so nothing is lost by pausing. */
export async function getCompressionEnabled() {
  const res = await supabase
    .from("app_settings")
    .select("compression_enabled")
    .eq("id", 1)
    .maybeSingle()
  if (!res.error) return res.data?.compression_enabled !== false
  if (!compressorMissing(res.error)) throw new Error(niceError(res.error))
  try {
    return window.localStorage.getItem(COMPRESSION_OFF_KEY) !== "1"
  } catch {
    return true
  }
}

/* -- writes --------------------------------------------------------------- */

export async function setCompressionEnabled(on) {
  const next = !!on
  const res = await supabase
    .from("app_settings")
    .update({ compression_enabled: next })
    .eq("id", 1)
  if (!res.error) return next
  if (!compressorMissing(res.error)) throw new Error(niceError(res.error))
  try {
    window.localStorage.setItem(COMPRESSION_OFF_KEY, next ? "0" : "1")
  } catch {
    /* ignored: the switch is then per-session */
  }
  return next
}

/** Upsert by id. A duplicate slug is reported in words rather than as a
 *  Postgres constraint name, because the slug is what the logs show. */
export async function saveCompressor(payload) {
  const row = cleanCompressor(payload)
  const id = payload?.id

  const stored = id && !String(id).startsWith("local:")
  const write = (values) =>
    stored
      ? supabase.from("token_compressors").update(values).eq("id", id).select(compressorCols()).single()
      : supabase.from("token_compressors").insert(values).select(compressorCols()).single()

  let res = await write(ponytailColumns ? row : withoutPonytail(row))

  if (res.error && ponytailColumns && ponytailColumnMissing(res.error)) {
    ponytailColumns = false
    res = await write(withoutPonytail(row))
  }

  if (!res.error) return withPonytailDefaults(res.data)
  if (String(res.error.code) === "23505" || /duplicate key/i.test(String(res.error.message))) {
    throw new Error(`A compressor with the slug "${row.slug}" already exists.`)
  }
  if (!compressorMissing(res.error)) throw new Error(niceError(res.error))

  const list = localRead()
  const localId = id ? String(id) : `local:${row.slug}`
  if (list.some((c) => c.id !== localId && c.slug === row.slug)) {
    throw new Error(`A compressor with the slug "${row.slug}" already exists.`)
  }
  const index = list.findIndex((c) => c.id === localId)
  const saved = { ...row, id: localId }
  if (index >= 0) list[index] = saved
  else list.push(saved)
  localWrite(list)
  return { ...saved, _local: true }
}

export async function setCompressorActive(id, isActive) {
  const next = !!isActive
  if (!String(id).startsWith("local:")) {
    const res = await supabase
      .from("token_compressors")
      .update({ is_active: next })
      .eq("id", id)
      .select(compressorCols())
      .single()
    if (!res.error) return res.data
    if (!compressorMissing(res.error)) throw new Error(niceError(res.error))
  }
  const list = localRead().map((c) => (c.id === id ? { ...c, is_active: next } : c))
  localWrite(list)
  return { ...(list.find((c) => c.id === id) || {}), _local: true }
}

export async function deleteCompressor(id) {
  if (!String(id).startsWith("local:")) {
    const res = await supabase.from("token_compressors").delete().eq("id", id)
    if (!res.error) return
    if (!compressorMissing(res.error)) throw new Error(niceError(res.error))
  }
  localWrite(localRead().filter((c) => c.id !== id))
}

/* ------------------------------------------------------------- key watch */
/* Until v11 the key watcher lived in a setInterval in this browser, which
   meant the keys were only watched while an admin had the tab open — the
   opposite of what a watcher is for. The beat now runs server-side
   (supabase/functions/keywatch, scheduled by pg_cron inside Supabase as of
   v11.3); these helpers are the panel’s window onto it.

   Every one of them degrades: on a database that has not run the v11 upgrade
   the status call returns `installed: false` instead of throwing, so the card
   can say what to run rather than showing a red error. */

function keywatchMissing(error) {
  const code = String(error?.code || "")
  if (code === "42883" || code === "PGRST202" || code === "42P01" || code === "PGRST205") return true
  return /admin_keywatch_status|admin_save_keywatch_settings|keywatch_runs|does not exist|schema cache|could not find/i.test(
    String(error?.message || ""),
  )
}

const KEYWATCH_EMPTY = {
  installed: false,
  upgrade_file: KEYWATCH_UPGRADE_FILE,
  settings: {
    enabled: false,
    interval_seconds: 15,
    batch_size: 25,
    active_only: true,
    retention_days: 7,
  },
  keys: { total: 0, active: 0, stale: 0, by_status: {} },
  runs: [],
}

/** Settings, the last pass, key health and the last 20 runs — one round trip. */
export async function getKeywatchStatus() {
  const res = await supabase.rpc("admin_keywatch_status")
  if (!res.error) return { ...KEYWATCH_EMPTY, ...(res.data || {}), installed: true }
  if (keywatchMissing(res.error)) return { ...KEYWATCH_EMPTY, reason: res.error.message }
  throw new Error(niceError(res.error))
}

/** Save the switch, the interval, the batch size. Clamped again in Postgres. */
export async function saveKeywatchSettings(patch = {}) {
  const body = {}
  if (patch.enabled !== undefined) body.enabled = !!patch.enabled
  if (patch.interval_seconds !== undefined) {
    body.interval_seconds = Math.min(3600, Math.max(5, Math.round(Number(patch.interval_seconds) || 15)))
  }
  if (patch.batch_size !== undefined) {
    body.batch_size = Math.min(500, Math.max(1, Math.round(Number(patch.batch_size) || 25)))
  }
  if (patch.active_only !== undefined) body.active_only = !!patch.active_only
  if (patch.retention_days !== undefined) {
    body.retention_days = Math.min(365, Math.max(1, Math.round(Number(patch.retention_days) || 7)))
  }
  if (patch.clear_error) body.clear_error = true

  const res = await supabase.rpc("admin_save_keywatch_settings", { p: body })
  if (!res.error) return { ...KEYWATCH_EMPTY, ...(res.data || {}), installed: true }
  if (keywatchMissing(res.error)) {
    throw new Error(`Run supabase/${KEYWATCH_UPGRADE_FILE} first — the key watch tables are not installed yet.`)
  }
  throw new Error(niceError(res.error))
}

/** Recent passes, newest first. Empty (not an error) before the upgrade. */
export async function listKeywatchRuns(limit = 25) {
  const res = await supabase
    .from("keywatch_runs")
    .select("id,started_at,duration_ms,source,trigger,checked,working,failing,skipped,reason,error")
    .order("started_at", { ascending: false })
    .limit(Math.min(200, Math.max(1, Math.round(Number(limit) || 25))))
  if (!res.error) return res.data ?? []
  if (keywatchMissing(res.error)) return []
  throw new Error(niceError(res.error))
}

/** "Check now" from the panel. Deliberately routed through admin-check-keys:
 *  that function already holds the admin gate, and the browser must never be
 *  given the cron secret the scheduler uses. The results are recorded as a
 *  manual check, which is what they are. */
export async function runKeywatchNow(body = {}) {
  return testUpstreamKeys(body)
}

/** Is the scheduled function actually deployed? GET answers without auth. */
export async function pingKeywatchFn() {
  const started = performance.now()
  try {
    const res = await fetch(`${FUNCTIONS_URL}/keywatch`, {
      method: "GET",
      headers: { apikey: SUPABASE_ANON_KEY },
    })
    const text = await res.text()
    const payload = safeJsonParse(text, null)
    return {
      ok: res.ok && payload?.ok !== false,
      status: res.status,
      elapsed: Math.round(performance.now() - started),
      deployed: res.status !== 404,
      secret_set: payload?.secret_set ?? null,
      message: res.ok ? null : text.slice(0, 200),
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      elapsed: Math.round(performance.now() - started),
      deployed: false,
      message: String(err?.message || err),
    }
  }
}


/* ==========================================================================
   Community chat  (v11.4)
   Rooms + messages backed by chat_groups / chat_feed and the
   post_chat_message / delete_chat_message RPCs. The feed view already hides
   deleted rows and never exposes emails, so these helpers stay thin.
   ========================================================================== */

export async function listChatGroups() {
  return unwrap(
    await supabase
      .from("chat_groups")
      .select("slug, name, description, is_active, is_locked, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    [],
  )
}

/* v12.3 gave chat_feed reply and reaction columns. Read the wide shape, and
   fall back to the v11 shape when the upgrade has not been applied yet, so an
   un-migrated database shows old messages instead of an error wall. */
export const CHAT_FEED_COLS =
  "id, group_slug, user_id, author_name, author_role, body, created_at, edited_at, reply_to, reply_body, reply_author, reactions, is_mine, is_staff"
export const CHAT_FEED_COLS_V11 =
  "id, group_slug, user_id, author_name, author_role, body, created_at, edited_at, is_mine"

/* "not installed yet" rather than "broken": a missing table, view, column or
   RPC means supabase/upgrade-v12.3-community-plus.sql is still unapplied. */
function communityMissing(error) {
  const code = String(error?.code || "")
  const msg = String(error?.message || "")
  if (["42P01", "42703", "42883", "PGRST202", "PGRST204"].includes(code)) return true
  return /does not exist|could not find|schema cache|unknown function/i.test(msg)
}

export async function listChatMessages(groupSlug, limit = 200) {
  const grab = (cols) =>
    supabase
      .from("chat_feed")
      .select(cols)
      .eq("group_slug", groupSlug)
      .order("created_at", { ascending: true })
      .limit(limit)

  let res = await grab(CHAT_FEED_COLS)
  if (res.error && /column|reply_to|reactions|is_staff/i.test(res.error.message || "")) {
    res = await grab(CHAT_FEED_COLS_V11)
  }
  if (res.error) throw new Error(niceError(res.error))
  return res.data || []
}

/* replyTo is optional. A database that still has the two-argument RPC is
   retried with the original call shape. */
export async function postChatMessage(groupSlug, body, replyTo = null) {
  const text = String(body || "").trim()
  let res = await supabase.rpc("post_chat_message", {
    p_group_slug: groupSlug,
    p_body: text,
    p_reply_to: replyTo || null,
  })
  if (res.error && communityMissing(res.error)) {
    res = await supabase.rpc("post_chat_message", { p_group_slug: groupSlug, p_body: text })
  }
  if (res.error) throw new Error(niceError(res.error))
  return res.data
}


export async function deleteChatMessage(id) {
  return unwrap(await supabase.rpc("delete_chat_message", { p_id: id }))
}

export async function saveChatGroup(patch) {
  return unwrap(await supabase.rpc("admin_save_chat_group", { p_patch: patch ?? {} }))
}

/* ==========================================================================
   Kie API provider  (v11.5 — codex /responses only)
   One category ('codex') in kie_providers, secret keys in kie_provider_keys
   (revealed only through an audited RPC), and streaming tests that run inside
   the `kie` edge function so the browser never sees the secret.

   Kie accepts exactly one request shape, so that is all we ever send:
     POST https://api.kie.ai/codex/v1/responses
     { model, stream: true, input, tools?: [{type:"web_search"}],
       reasoning?: { effort: "low"|"medium"|"high" } }
   ========================================================================== */

const KIE_FN = "kie"
const KIE_HINT =
  "Deploy it with:  npm run fn:deploy   (runs `supabase functions deploy kie --no-verify-jwt`)."

function cleanKiePatch(patch = {}) {
  const clean = {}
  const str = (k) => {
    if (typeof patch[k] === "string") clean[k] = patch[k].trim()
  }
  const bool = (k) => {
    if (typeof patch[k] === "boolean") clean[k] = patch[k]
  }
  str("label")
  str("endpoint")
  str("content_type")
  str("delta_event_type")
  str("default_model")
  str("notes")
  bool("stream")
  bool("is_active")
  if (patch.models !== undefined) {
    const list = Array.isArray(patch.models)
      ? patch.models
      : String(patch.models || "").split(/[\n,]/)
    clean.models = list.map((m) => m.trim()).filter(Boolean)
  }
  if (patch.extra_headers !== undefined) {
    clean.extra_headers =
      typeof patch.extra_headers === "string"
        ? safeJsonParse(patch.extra_headers, {})
        : patch.extra_headers || {}
  }
  return clean
}

export async function listKieProviders() {
  return unwrap(
    await supabase.from("kie_providers").select("*").order("category", { ascending: true }),
    [],
  )
}

export async function saveKieProvider(category, patch) {
  return unwrap(
    await supabase.rpc("admin_save_kie_provider", {
      p_category: category,
      p_patch: cleanKiePatch(patch),
    }),
  )
}

export async function listKieKeys() {
  return unwrap(
    await supabase
      .from("admin_kie_provider_keys")
      .select("*")
      .order("created_at", { ascending: false }),
    [],
  )
}

export async function addKieKey({ kie_provider_id, label, api_key }) {
  const key = String(api_key ?? "").trim()
  if (!key) throw new Error("Paste an API key first.")
  return unwrap(
    await supabase
      .from("kie_provider_keys")
      .insert({
        kie_provider_id,
        label: (label || "key").trim() || "key",
        api_key: key,
      })
      .select("id")
      .single(),
  )
}

export async function updateKieKey(id, patch) {
  return unwrap(
    await supabase
      .from("kie_provider_keys")
      .update(patch)
      .eq("id", id)
      .select("id")
      .single(),
  )
}

export async function deleteKieKey(id) {
  return unwrap(await supabase.from("kie_provider_keys").delete().eq("id", id), null)
}

export async function revealKieKey(id) {
  return unwrap(await supabase.rpc("admin_reveal_kie_key", { p_key_id: id }))
}

/**
 * Ask the kie function for one streamed call and the full analysis of what Kie
 * returned (text, reasoning, tool calls, event tally, usage, credits).
 *
 * Only fields of the supported shape are accepted:
 *   model, prompt|input, image_url|images, web_search, reasoning_effort
 */
export async function testKie({
  model,
  prompt,
  input,
  image_url,
  images,
  web_search,
  reasoning_effort,
} = {}) {
  const payload = { action: "test" }
  if (model && String(model).trim()) payload.model = String(model).trim()
  if (input !== undefined && input !== null && input !== "") payload.input = input
  if (prompt && String(prompt).trim()) payload.prompt = String(prompt).trim()
  if (image_url && String(image_url).trim()) payload.image_url = String(image_url).trim()
  if (Array.isArray(images) && images.length) payload.images = images
  if (web_search) payload.web_search = true
  if (reasoning_effort && String(reasoning_effort).trim()) {
    payload.reasoning_effort = String(reasoning_effort).trim()
  }
  return callKieFn(payload)
}

/** Run the two canonical doc tests (A: minimal stream, B: image + web_search). */
export async function probeKie({ model } = {}) {
  const payload = { action: "probe" }
  if (model && String(model).trim()) payload.model = String(model).trim()
  return callKieFn(payload)
}

async function callKieFn(payload) {
  const url = `${FUNCTIONS_URL}/${KIE_FN}`

  let res
  try {
    res = await postEdgeFn(url, payload, { timeoutMs: 180000 })
    if (res.status === 401 || res.status === 403) {
      res = await postEdgeFn(url, payload, { timeoutMs: 180000, force: true })
    }
  } catch (err) {
    if (err?.signedOut) throw err
    throw new Error(err?.message || "Could not reach the kie function.")
  }

  const text = await res.text()
  let out = null
  try {
    out = text ? JSON.parse(text) : null
  } catch {
    /* keep raw text below */
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`The kie function is not deployed yet. ${KIE_HINT}`)
    }
    if ((res.status === 401 || res.status === 403) && !out?.error) {
      throw new Error(
        `Supabase rejected the call before it reached the kie function (${res.status}). ${KIE_HINT}`,
      )
    }
    throw new Error(out?.error?.message || text?.slice(0, 300) || `Test failed (${res.status}).`)
  }
  return out
}

/* ---- v11.6 KIE ORIGINAL: model mapping + usage sheets -------------------- */

const missingObject = (err) => {
  const s = `${err?.code || ""} ${err?.message || ""}`.toLowerCase()
  return /42p01|42883|42703|pgrst202|pgrst205|does not exist|could not find/.test(s)
}

export async function listKieModelMap() {
  const { data, error } = await supabase
    .from("admin_kie_model_map")
    .select("*")
    .order("is_catch_all", { ascending: false })
    .order("public_id", { ascending: true })
  if (error) {
    if (missingObject(error)) return []
    throw new Error(niceError(error))
  }
  return data ?? []
}

export async function syncKieModels() {
  const { data, error } = await supabase.rpc("admin_sync_kie_models")
  if (error) throw new Error(niceError(error))
  return Number(data?.models ?? 0)
}

/* Returns null when the migration has not been applied yet. */
export async function usageSheet({ days = 30, limit = 2000 } = {}) {
  const { data, error } = await supabase.rpc("my_usage_sheet", { p_days: days, p_limit: limit })
  if (error) {
    if (missingObject(error)) return null
    throw new Error(niceError(error))
  }
  return data ?? []
}

export async function adminUsageSheet({ days = 30, limit = 2000, kieOnly = false } = {}) {
  const { data, error } = await supabase.rpc("admin_usage_sheet", {
    p_days: days,
    p_limit: limit,
    p_kie_only: kieOnly,
  })
  if (error) {
    if (missingObject(error)) return null
    throw new Error(niceError(error))
  }
  return data ?? []
}

/* ==========================================================================
   Member ↔ admin messages  (v12.1)
   Members open one private thread from the community portal; admins answer it
   from the panel's Messages inbox. Reads go through three views, writes go
   through security-definer RPCs — a member can never set from_admin or reach
   another thread.

   Everything degrades quietly. If supabase/upgrade-v12.1-admin-messages.sql
   has not been applied, reads come back empty with a hint instead of throwing
   a wall of Postgres at someone trying to say hello.
   ========================================================================== */

export const ADMIN_DM_HINT =
  "Direct messages are not installed yet — apply supabase/upgrade-v12.1-admin-messages.sql in the Supabase SQL editor."

const DM_FEED_COLS =
  "id, thread_id, author_id, from_admin, body, created_at, author_name, is_mine"
const DM_THREAD_COLS =
  "id, subject, status, last_sender, last_message_at, created_at, unread"
const DM_INBOX_COLS =
  "id, user_id, subject, status, last_sender, last_message_at, created_at, member_name, member_email, member_plan, messages, unread, last_body"

/* a write cannot be silently swallowed, but it can say something useful */
const dmWriteError = (error) =>
  new Error(missingObject(error) ? ADMIN_DM_HINT : niceError(error))

export async function listAdminMessages(threadId, limit = 300) {
  if (!threadId) return []
  const { data, error } = await supabase
    .from("admin_message_feed")
    .select(DM_FEED_COLS)
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) {
    if (missingObject(error)) return []
    throw new Error(niceError(error))
  }
  return (data ?? []).slice().reverse()
}

/** The signed-in member's own lane, oldest message first.
 *  Returns { unavailable, hint, thread, messages } so the portal can show the
 *  feature as "not installed yet" rather than as an error. */
export async function myAdminThread() {
  const { data, error } = await supabase
    .from("my_admin_thread")
    .select(DM_THREAD_COLS)
    .maybeSingle()
  if (error) {
    if (missingObject(error)) {
      return { unavailable: true, hint: ADMIN_DM_HINT, thread: null, messages: [] }
    }
    throw new Error(niceError(error))
  }
  if (!data) return { unavailable: false, thread: null, messages: [] }
  const messages = await listAdminMessages(data.id)
  return { unavailable: false, thread: data, messages }
}

/* The thread is created on the first message, and reopened if the team had
   closed it — the caller never picks a thread id. */
export async function sendAdminMessage(body, subject = null) {
  const text = String(body ?? "").trim()
  if (!text) throw new Error("Message is empty.")
  const { data, error } = await supabase.rpc("send_admin_message", {
    p_body: text,
    p_subject: subject,
  })
  if (error) throw dmWriteError(error)
  return data ?? null
}

/* Opening the lane is reading it. Never fatal: a read receipt is not worth an
   error message. */
export async function markAdminThreadRead(threadId = null) {
  const { error } = await supabase.rpc("mark_admin_thread_read", {
    p_thread_id: threadId,
  })
  if (error && !missingObject(error)) throw new Error(niceError(error))
  return true
}

export async function deleteAdminMessage(id) {
  const { error } = await supabase.rpc("delete_admin_message", { p_id: id })
  if (error) throw dmWriteError(error)
  return true
}

/* ---- admin side ---------------------------------------------------------- */

/* Unread first, then most recent — the order you actually work an inbox in. */
export async function listAdminThreads(limit = 200) {
  const { data, error } = await supabase
    .from("admin_thread_inbox")
    .select(DM_INBOX_COLS)
    .order("unread", { ascending: false })
    .order("last_message_at", { ascending: false })
    .limit(limit)
  if (error) {
    if (missingObject(error)) return []
    throw new Error(niceError(error))
  }
  return data ?? []
}

export async function replyAdminThread(threadId, body) {
  const text = String(body ?? "").trim()
  if (!text) throw new Error("Reply is empty.")
  const { data, error } = await supabase.rpc("admin_reply_message", {
    p_thread_id: threadId,
    p_body: text,
  })
  if (error) throw dmWriteError(error)
  return data ?? null
}

export async function setAdminThreadStatus(threadId, status) {
  const { error } = await supabase.rpc("admin_set_thread_status", {
    p_thread_id: threadId,
    p_status: status,
  })
  if (error) throw dmWriteError(error)
  return true
}


/* ==========================================================================
   v12.3 - community plus
   Direct messages, reactions, presence, unread counts, and the daily
   check-in standing that decides whether the gateway answers.

   Names and bodies pass through verbatim in both directions: the views hand
   back sender_id + sender_name and recipient_id + recipient_name, and nothing
   here rewrites, hashes or masks a message.
   ========================================================================== */

export const COMMUNITY_HINT =
  "The chat upgrade is not installed yet - apply supabase/upgrade-v12.3-community-plus.sql in the Supabase SQL editor."

export const DM_LIST_COLS =
  "id, other_id, other_name, other_role, last_message_at, created_at, last_body, last_sender_name, unread, other_last_seen"
export const DM_LINE_COLS =
  "id, thread_id, sender_id, sender_name, recipient_id, recipient_name, body, reply_to, reply_body, reply_author, created_at, edited_at, is_mine, is_staff"
export const MEMBER_COLS = "id, name, role, last_seen_at, online, is_me"

/* a read that treats "not installed yet" as empty rather than as a failure */
async function communityRead(query, fallback) {
  const res = await query
  if (res.error) {
    if (communityMissing(res.error)) return fallback
    throw new Error(niceError(res.error))
  }
  return res.data || fallback
}

async function communityCall(name, args) {
  const res = await supabase.rpc(name, args || {})
  if (res.error) {
    throw new Error(communityMissing(res.error) ? COMMUNITY_HINT : niceError(res.error))
  }
  return res.data
}

/* a write whose failure should never block the UI (read marks, presence) */
async function communityPing(name, args) {
  const res = await supabase.rpc(name, args || {})
  if (res.error && !communityMissing(res.error)) throw new Error(niceError(res.error))
  return res.data === true
}

/* ---- the daily check-in -------------------------------------------------- */

export async function communityStanding() {
  const res = await supabase.rpc("my_community_standing")
  if (res.error) {
    if (communityMissing(res.error)) return null
    throw new Error(niceError(res.error))
  }
  return res.data || null
}

export async function recordCommunityVisit(room = null) {
  return communityPing("record_community_visit", { p_room: room })
}

export async function saveCommunityGate(patch) {
  return communityCall("admin_save_community_gate", { p_patch: patch || {} })
}

/* ---- rooms -------------------------------------------------------------- */

export async function listRoomUnread() {
  return communityRead(
    supabase.from("my_chat_unread").select("group_id, slug, name, unread, last_message_at"),
    [],
  )
}

export async function markRoomRead(groupSlug) {
  return communityPing("mark_room_read", { p_group_slug: groupSlug })
}

export async function editChatMessage(id, body) {
  return communityCall("edit_chat_message", { p_id: id, p_body: String(body || "").trim() })
}

export async function toggleChatReaction(id, emoji) {
  return communityCall("toggle_chat_reaction", { p_id: id, p_emoji: emoji })
}

/* ---- direct messages ---------------------------------------------------- */

export async function listDmThreads(limit = 100) {
  return communityRead(
    supabase
      .from("my_dm_threads")
      .select(DM_LIST_COLS)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limit),
    [],
  )
}

export async function listDmMessages(threadId, limit = 300) {
  if (!threadId) return []
  return communityRead(
    supabase
      .from("dm_feed")
      .select(DM_LINE_COLS)
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(limit),
    [],
  )
}

export async function openDmThread(otherId) {
  return communityCall("open_dm_thread", { p_other: otherId })
}

export async function sendDm(recipientId, body, replyTo = null) {
  return communityCall("send_dm", {
    p_recipient: recipientId,
    p_body: String(body || "").trim(),
    p_reply_to: replyTo || null,
  })
}

export async function markDmRead(threadId) {
  return communityPing("mark_dm_read", { p_thread_id: threadId })
}

export async function editDmMessage(id, body) {
  return communityCall("edit_dm_message", { p_id: id, p_body: String(body || "").trim() })
}

export async function deleteDmMessage(id) {
  return communityCall("delete_dm_message", { p_id: id })
}

/* ---- who is around ------------------------------------------------------ */

export async function listCommunityMembers(limit = 200) {
  return communityRead(
    supabase
      .from("community_members")
      .select(MEMBER_COLS)
      .order("online", { ascending: false })
      .order("name", { ascending: true })
      .limit(limit),
    [],
  )
}
