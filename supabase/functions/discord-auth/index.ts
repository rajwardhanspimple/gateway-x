// ============================================================================
//  discord-auth — Discord OAuth2 sign-in, account connect and guild join
// ----------------------------------------------------------------------------
//  Firebase Authentication has no Discord provider, so Discord sign-in is a
//  custom OAuth2 flow that ENDS as a Firebase sign-in:
//
//    browser ──POST {action:"start"}──▶ this function ──▶ discord.com authorize
//    discord.com ──redirect──▶ <site>/?code=…&state=…
//    browser ──POST {action:"exchange"}──▶ this function
//        verifies the HMAC-signed state, swaps the code for a Discord token
//        (the client secret never leaves the server), reads /users/@me,
//        finds or creates the Supabase auth user, links the Discord identity,
//        joins the guild, pays the one-time join credit (v12.7), and mints a
//        Firebase CUSTOM TOKEN
//    browser ──signInWithCustomToken()──▶ the v10 bridge (firebase-auth)
//        mints the Supabase JWT, and every RLS policy keeps working untouched
//
//  Actions (POST {action}):
//    start     build the authorize URL with a signed state parameter
//    exchange  finish a sign-in (state mode "signin")
//    connect   attach Discord to the signed-in caller (state mode "connect",
//              bound to the caller's uid, so a Discord identity cannot be
//              grafted onto someone else's account)
//
//  Deploy without JWT verification — sign-in callers have no session yet:
//    supabase functions deploy discord-auth --no-verify-jwt
//
//  Required secrets:
//    DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET    OAuth2 app credentials
//    DISCORD_REDIRECT_URI                         e.g. https://ragestar.bond/
//    FIREBASE_PROJECT_ID                          existing
//    FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY service account (custom tokens)
//    JWT_SECRET    Project Settings -> API -> JWT Secret (legacy)
//  Optional:
//    DISCORD_BOT_TOKEN / DISCORD_GUILD_ID   guild auto-join (skipped when unset)
//    DISCORD_STATE_SECRET                   state HMAC key (falls back to JWT_SECRET)
//    DISCORD_EXTRA_REDIRECTS                comma-separated extra redirect URIs
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import {
  apiError,
  json,
  MAX_BODY_BYTES,
  preflight,
  requestId,
  safeJsonParse,
} from "../_shared/cors.ts"
import {
  AuthTokenError,
  bearerToken,
  firebaseIdTokenHeader,
  resolveJwtSecret,
  verifyFirebaseIdToken,
  verifySupabaseAccessToken,
} from "../_shared/firebase.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? ""
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") ?? ""
/* Service-account keys pasted into a CLI env var arrive with literal "\n"
   sequences; PEM parsing needs real newlines. */
const FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") ?? "").replace(
  /\\n/g,
  "\n",
)
const FIREBASE_PRIVATE_KEY_ID = Deno.env.get("FIREBASE_PRIVATE_KEY_ID") ?? ""

const DISCORD_CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID") ?? ""
const DISCORD_CLIENT_SECRET = Deno.env.get("DISCORD_CLIENT_SECRET") ?? ""
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") ?? ""
const DISCORD_GUILD_ID = Deno.env.get("DISCORD_GUILD_ID") ?? ""
const DISCORD_REDIRECT_URI = Deno.env.get("DISCORD_REDIRECT_URI") ?? ""

/* The only redirect targets a state parameter may ever carry. The production
   URI comes from the secret; the two localhost entries keep `npm run dev`
   working without a second Discord app. */
const ALLOWED_REDIRECTS = [
  DISCORD_REDIRECT_URI,
  ...(Deno.env.get("DISCORD_EXTRA_REDIRECTS") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
  "http://localhost:5173/",
  "http://localhost:4173/",
].filter(Boolean)

const DISCORD_API = "https://discord.com/api/v10"
const STATE_TTL_SEC = 600

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function clean(value: unknown, max = 200): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max)
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------- base64url */

function b64urlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = ""
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i])
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function textToB64url(text: string): string {
  return bytesToB64url(new TextEncoder().encode(text))
}

/* ------------------------------------------------------- signed OAuth state */

type StatePayload = {
  mode: "signin" | "connect"
  uid?: string
  nonce: string
  exp: number
  ru: string
}

let stateKeyPromise: Promise<CryptoKey> | null = null

function stateKey(): Promise<CryptoKey> {
  if (!stateKeyPromise) {
    const secret =
      (Deno.env.get("DISCORD_STATE_SECRET") ?? "").trim() || resolveJwtSecret()
    if (!secret) {
      throw new AuthTokenError(
        'No state-signing secret is set. Run: supabase secrets set DISCORD_STATE_SECRET="<32+ random chars>" (or set JWT_SECRET, which it falls back to).',
        "not_configured",
        500,
      )
    }
    stateKeyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
  }
  return stateKeyPromise
}

async function signState(payload: StatePayload): Promise<string> {
  const key = await stateKey()
  const body = textToB64url(JSON.stringify(payload))
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v1.${body}`),
  )
  return `v1.${body}.${bytesToB64url(new Uint8Array(sig))}`
}

async function verifyState(raw: unknown): Promise<StatePayload> {
  const parts = String(raw ?? "").split(".")
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new AuthTokenError(
      "That Discord link is malformed. Start the sign-in again.",
      "bad_state",
      400,
    )
  }
  const key = await stateKey()
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!ok) {
    throw new AuthTokenError(
      "That Discord link failed its signature check. Start the sign-in again.",
      "bad_state",
      400,
    )
  }
  let payload: StatePayload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])))
  } catch {
    throw new AuthTokenError("That Discord link is malformed.", "bad_state", 400)
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSec()) {
    throw new AuthTokenError(
      "That Discord link expired. Start the sign-in again.",
      "state_expired",
      400,
    )
  }
  if (!payload.ru || !ALLOWED_REDIRECTS.includes(payload.ru)) {
    throw new AuthTokenError(
      "That Discord link carries a redirect this deployment does not allow.",
      "bad_state",
      400,
    )
  }
  if (payload.mode !== "signin" && payload.mode !== "connect") {
    throw new AuthTokenError("That Discord link is malformed.", "bad_state", 400)
  }
  return payload
}

/* --------------------------------------------------------- domain allowlist */

/**
 * The database is the real gate (enforce_allowed_email on auth.users) and the
 * firebase-auth bridge checks again when the custom token is exchanged, but
 * checking here too means a blocked Discord address gets a clear message
 * instead of a trigger error. Written defensively: if app_settings has no
 * such column, the check is skipped rather than locking everyone out.
 */
async function allowedDomains(): Promise<string[]> {
  try {
    const { data } = await admin.from("app_settings").select("*").limit(1).maybeSingle()
    const raw = (data as Record<string, unknown> | null)?.allowed_email_domains
    if (!raw) return []
    const list = Array.isArray(raw) ? raw : String(raw).split(",")
    return list.map((d) => clean(d, 190).toLowerCase()).filter(Boolean)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------- Discord API */

type DiscordToken = { access_token: string }

type DiscordUser = {
  id: string
  username?: string
  global_name?: string | null
  avatar?: string | null
  email?: string | null
  verified?: boolean
}

async function discordTokenExchange(code: string, redirectUri: string): Promise<DiscordToken> {
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) {
    /* Codes are single-use and short-lived; the usual cause is a replayed or
       stale link, so the message points at starting over, not at the secret. */
    console.error("discord token exchange failed", res.status, await res.text())
    throw new AuthTokenError(
      "Discord refused that sign-in code. Start the sign-in again.",
      "discord_exchange_failed",
      400,
    )
  }
  return (await res.json()) as DiscordToken
}

async function discordMe(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    console.error("discord /users/@me failed", res.status, await res.text())
    throw new AuthTokenError(
      "Could not read your Discord profile. Try again.",
      "discord_profile_failed",
      502,
    )
  }
  return (await res.json()) as DiscordUser
}

function discordAvatarUrl(me: DiscordUser): string {
  if (!me.avatar) return ""
  return `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
}

/**
 * Adds the Discord user to the community guild with the bot token. 201 means
 * joined, 204 means already a member. Every other outcome is logged and
 * reported as false — a chat server must never hold API access hostage, so
 * the caller treats false as "record it and carry on".
 */
async function joinGuild(discordUserId: string, userAccessToken: string): Promise<boolean> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return false
  try {
    const res = await fetch(
      `${DISCORD_API}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: userAccessToken }),
      },
    )
    if (res.status === 201 || res.status === 204) return true
    console.error("guild join failed", res.status, await res.text())
    return false
  } catch (err) {
    console.error("guild join failed", err)
    return false
  }
}

/* ------------------------------------------------------------- join credit */

/**
 * Pays the one-time Discord join credit (app_settings.discord_join_credit_usd,
 * v12.7) through the billing system's single mover. Called ONLY after Discord
 * confirmed the membership (201/204) — never on a failed join. The database
 * enforces once per account in discord_join_grants, a table that survives a
 * disconnect, so a re-connect or a repeated sign-in can never collect twice.
 * Never fatal: a missing migration, a disabled offer (0) and an already-paid
 * account all read as 0 and the flow carries on.
 */
async function grantJoinCredit(userId: string, discordId: string): Promise<number> {
  try {
    const { data, error } = await admin.rpc("internal_grant_discord_join_credit", {
      p_user_id: userId,
      p_discord_id: discordId,
    })
    if (error) {
      const msg = String((error as { message?: unknown })?.message ?? "")
      if (/could not find|does not exist|schema cache/i.test(msg)) {
        console.warn(
          "join credit skipped — run supabase/upgrade-v12.7-announcements-discord-credit.sql",
        )
        return 0
      }
      console.error("join credit grant failed", error)
      return 0
    }
    return Number(data ?? 0) || 0
  } catch (err) {
    console.error("join credit grant failed", err)
    return 0
  }
}

/* --------------------------------------------------------- identity storage */

async function upsertIdentity(userId: string, me: DiscordUser, guildMember: boolean) {
  const { error } = await admin.from("discord_identities").upsert(
    {
      user_id: userId,
      discord_id: me.id,
      username: clean(me.username, 64),
      global_name: clean(me.global_name, 120),
      avatar: clean(me.avatar, 120),
      email: clean(me.email, 254).toLowerCase(),
      guild_member: guildMember,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  )
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "")
    if (code === "42P01" || code === "PGRST205") {
      throw new AuthTokenError(
        "The discord_identities table does not exist yet. Run supabase/upgrade-v12.6-discord.sql in the SQL editor, then try again.",
        "not_installed",
        500,
      )
    }
    console.error("discord_identities upsert failed", error)
    throw new AuthTokenError(
      "Could not save the Discord link. Try again.",
      "link_failed",
      500,
    )
  }
}

/* ------------------------------------------------------------- user lookup */

/** Finds an existing auth user by email, paging through the admin list. */
async function findAuthUserByEmail(email: string): Promise<string> {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return ""
    const hit = data?.users?.find(
      (u) => (u.email ?? "").toLowerCase() === email.toLowerCase(),
    )
    if (hit?.id) return hit.id
    if (!data?.users?.length || data.users.length < 200) break
  }
  return ""
}

async function lookupProfileId(column: string, value: string): Promise<string> {
  if (!value) return ""
  try {
    const { data } = await admin
      .from("profiles")
      .select("id")
      .eq(column, value)
      .maybeSingle()
    return String((data as { id?: string } | null)?.id ?? "")
  } catch {
    return ""
  }
}

/**
 * Maps a Discord account onto a Supabase auth user, mirroring resolveUser in
 * firebase-auth:
 *   1. already linked   -> discord_identities.discord_id matches
 *   2. existing account -> same email, so the Discord identity attaches to it
 *   3. brand new        -> create the auth user; handle_new_user() fills in
 *                          the profile row exactly as before
 */
async function resolveDiscordUser(
  me: DiscordUser,
  email: string,
): Promise<{ id: string; created: boolean }> {
  const linked = await admin
    .from("discord_identities")
    .select("user_id")
    .eq("discord_id", me.id)
    .maybeSingle()
  if (linked.data?.user_id) {
    return { id: String(linked.data.user_id), created: false }
  }

  const byProfile = await lookupProfileId("email", email)
  if (byProfile) return { id: byProfile, created: false }

  /* A profile row can be missing even though the auth user exists (a failed
     signup, a manually deleted row). Check auth.users before creating. */
  const existingAuthId = await findAuthUserByEmail(email)
  if (existingAuthId) return { id: existingAuthId, created: false }

  const { data: made, error: makeError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true, // Discord already verified it
    user_metadata: {
      full_name: clean(me.global_name || me.username, 120),
      avatar_url: discordAvatarUrl(me),
      discord_id: me.id,
    },
  })

  if (makeError || !made?.user?.id) {
    throw new AuthTokenError(
      makeError?.message || "Could not create your account. Try again.",
      "create_failed",
      400,
    )
  }
  return { id: made.user.id, created: true }
}

/* ------------------------------------------- Firebase custom token (no SDK) */

let rsaKeyPromise: Promise<CryptoKey> | null = null

function serviceAccountKey(): Promise<CryptoKey> {
  if (!rsaKeyPromise) {
    if (!FIREBASE_PRIVATE_KEY) {
      throw new AuthTokenError(
        "FIREBASE_PRIVATE_KEY is not set on this function. Download the service-account JSON (Firebase console -> Project settings -> Service accounts) and run: " +
          'supabase secrets set FIREBASE_CLIENT_EMAIL="<client_email>" FIREBASE_PRIVATE_KEY="<private_key>"',
        "not_configured",
        500,
      )
    }
    const der = FIREBASE_PRIVATE_KEY.replace(
      /-----BEGIN PRIVATE KEY-----/,
      "",
    )
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "")
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(der), (c) => c.charCodeAt(0))
    } catch {
      throw new AuthTokenError(
        "FIREBASE_PRIVATE_KEY is not a readable PEM key. Paste the private_key value from the service-account JSON exactly, \\n sequences and all.",
        "not_configured",
        500,
      )
    }
    rsaKeyPromise = crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )
  }
  return rsaKeyPromise
}

async function signRs256(payload: Record<string, unknown>): Promise<string> {
  const key = await serviceAccountKey()
  const head = textToB64url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      ...(FIREBASE_PRIVATE_KEY_ID ? { kid: FIREBASE_PRIVATE_KEY_ID } : {}),
    }),
  )
  const body = textToB64url(JSON.stringify(payload))
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(`${head}.${body}`),
  )
  return `${head}.${body}.${bytesToB64url(new Uint8Array(sig))}`
}

/** Google OAuth2 access token via the JWT-bearer grant (service account). */
async function googleAccessToken(): Promise<string> {
  if (!FIREBASE_CLIENT_EMAIL) {
    throw new AuthTokenError(
      'FIREBASE_CLIENT_EMAIL is not set on this function. Run: supabase secrets set FIREBASE_CLIENT_EMAIL="<service account email>"',
      "not_configured",
      500,
    )
  }
  const now = nowSec()
  const jwt = await signRs256({
    iss: FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/identitytoolkit",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  })
  if (!res.ok) {
    console.error("google token grant failed", res.status, await res.text())
    throw new AuthTokenError(
      "Google refused the service account. Check FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are a matching pair.",
      "google_auth_failed",
      500,
    )
  }
  return String((await res.json())?.access_token ?? "")
}

/**
 * Finds the Firebase account for this email or creates it, and returns its
 * localId. The account MUST carry emailVerified: true — the firebase-auth
 * bridge refuses unverified sessions by default, so a Discord sign-in that
 * created an unverified record would be rejected one step later.
 */
async function findOrCreateFirebaseUser(
  googleToken: string,
  email: string,
  displayName: string,
  photoUrl: string,
): Promise<string> {
  if (!FIREBASE_PROJECT_ID) {
    throw new AuthTokenError(
      "FIREBASE_PROJECT_ID is not set on this function. Run: supabase secrets set FIREBASE_PROJECT_ID=your-project",
      "not_configured",
      500,
    )
  }
  const base = `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}`
  const headers = {
    authorization: `Bearer ${googleToken}`,
    "content-type": "application/json",
  }

  const lookup = async (): Promise<string> => {
    const res = await fetch(`${base}/accounts:lookup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: [email] }),
    })
    if (!res.ok) return ""
    const body = await res.json()
    const hit = Array.isArray(body?.users) ? body.users[0] : null
    return String(hit?.localId ?? "")
  }

  const existing = await lookup()
  if (existing) {
    /* Make sure the record satisfies the bridge: verified email, plus a name
       and photo if the account never got them. Best-effort — the custom
       token works even if this patch is refused. */
    await fetch(`${base}/accounts:update`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        localId: existing,
        emailVerified: true,
        ...(displayName ? { displayName } : {}),
        ...(photoUrl ? { photoUrl } : {}),
      }),
    }).catch(() => {})
    return existing
  }

  const made = await fetch(`${base}/accounts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      emailVerified: true,
      ...(displayName ? { displayName } : {}),
      ...(photoUrl ? { photoUrl } : {}),
    }),
  })
  if (!made.ok) {
    const text = await made.text()
    /* Raced with another sign-in method: the account appeared between the
       lookup and the create. Read it back and carry on. */
    if (/EMAIL_EXISTS/i.test(text)) {
      const again = await lookup()
      if (again) return again
    }
    console.error("identitytoolkit accounts:create failed", made.status, text)
    throw new AuthTokenError(
      "Could not create your sign-in. Try again.",
      "create_failed",
      400,
    )
  }
  return String((await made.json())?.localId ?? "")
}

/** The custom token the browser trades for a real Firebase session. */
async function mintFirebaseCustomToken(uid: string, discordId: string): Promise<string> {
  const now = nowSec()
  return signRs256({
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600,
    uid,
    claims: { discord_id: discordId, provider: "discord" },
  })
}

/* ------------------------------------------------------- caller identity */

/**
 * Who is calling, for connect mode. The same two-credential pattern as the
 * admin gate: the bridge-minted Supabase JWT first, then the raw Firebase ID
 * token from the x-firebase-token header.
 */
async function callerUid(req: Request): Promise<string> {
  const bearer = bearerToken(req)
  if (bearer) {
    try {
      const claims = await verifySupabaseAccessToken(bearer)
      if (claims.sub) return claims.sub
    } catch {
      /* fall through to the Firebase credential */
    }
  }
  const fb = firebaseIdTokenHeader(req)
  if (fb && FIREBASE_PROJECT_ID) {
    const claims = await verifyFirebaseIdToken(fb, FIREBASE_PROJECT_ID)
    const id =
      (await lookupProfileId("firebase_uid", claims.sub)) ||
      (await lookupProfileId("email", String(claims.email ?? "").toLowerCase()))
    if (id) return id
  }
  throw new AuthTokenError("Sign in required.", "unauthorized", 401)
}

/* ------------------------------------------------------------------ serve */

Deno.serve(async (req: Request) => {
  /* Preflight ONLY. Every other method falls through to the real handler. */
  const pre = preflight(req)
  if (pre) return pre

  const rid = requestId()

  if (req.method !== "POST") {
    return apiError("Use POST.", 405, "method_not_allowed", {}, req)
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return apiError(
      "This function is missing its Supabase service credentials.",
      500,
      "not_configured",
      {},
      req,
    )
  }

  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return apiError(
      'Discord sign-in is not configured. Run: supabase secrets set DISCORD_CLIENT_ID="…" DISCORD_CLIENT_SECRET="…" DISCORD_REDIRECT_URI="https://<your site>/" ' +
        "then redeploy: supabase functions deploy discord-auth --no-verify-jwt",
      500,
      "not_configured",
      {},
      req,
    )
  }

  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) {
    return apiError("That request is too large.", 413, "payload_too_large", {}, req)
  }

  const body = safeJsonParse<Record<string, unknown>>(text, {})
  const action = clean(body.action, 16)

  try {
    /* ------------------------------------------------------------- start */
    if (action === "start") {
      const mode = clean(body.mode, 12) === "connect" ? "connect" : "signin"
      let uid = ""
      if (mode === "connect") {
        uid = await callerUid(req)
      }

      const requested = clean(body.redirect, 300)
      const ru = requested || DISCORD_REDIRECT_URI
      if (!ru || !ALLOWED_REDIRECTS.includes(ru)) {
        return apiError(
          "That redirect URL is not allowed here. Add it to DISCORD_REDIRECT_URI (or DISCORD_EXTRA_REDIRECTS) and to the Discord app's OAuth2 redirect list.",
          400,
          "bad_redirect",
          {},
          req,
        )
      }

      const state = await signState({
        mode,
        ...(uid ? { uid } : {}),
        nonce: crypto.randomUUID(),
        exp: nowSec() + STATE_TTL_SEC,
        ru,
      })

      const url =
        "https://discord.com/api/oauth2/authorize?" +
        new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          redirect_uri: ru,
          response_type: "code",
          /* guilds.join is what lets the bot add the member during sign-in */
          scope: "identify email guilds.join",
          state,
        })

      return json({ url }, 200, { "x-request-id": rid }, req)
    }

    /* ------------------------------------------- exchange (sign-in) */
    if (action === "exchange") {
      const state = await verifyState(body.state)
      if (state.mode !== "signin") {
        return apiError("That link is not a sign-in link.", 400, "bad_state", {}, req)
      }
      const code = clean(body.code, 2048)
      if (!code) {
        return apiError("Missing code.", 400, "invalid_request_error", {}, req)
      }

      const token = await discordTokenExchange(code, state.ru)
      const me = await discordMe(token.access_token)
      if (!me.id) {
        return apiError(
          "Discord returned an unreadable profile. Try again.",
          502,
          "discord_profile_failed",
          {},
          req,
        )
      }

      const email = clean(me.email, 254).toLowerCase()
      if (!email) {
        return apiError(
          "That Discord account has no email address, so no account can be linked to it.",
          400,
          "no_email",
          {},
          req,
        )
      }
      if (me.verified !== true) {
        return apiError(
          "Verify your Discord email address first, then sign in again.",
          403,
          "email_unverified",
          {},
          req,
        )
      }

      const domains = await allowedDomains()
      if (domains.length) {
        const domain = email.split("@")[1] ?? ""
        if (!domains.includes(domain)) {
          return apiError(
            `Only ${domains.join(", ")} addresses can be used here.`,
            403,
            "domain_blocked",
            {},
            req,
          )
        }
      }

      const { id, created } = await resolveDiscordUser(me, email)

      const prof = await admin
        .from("profiles")
        .select("id,status")
        .eq("id", id)
        .maybeSingle()
      const status = String((prof.data as { status?: string } | null)?.status ?? "")
      if (status && status !== "active") {
        return apiError(
          "This account is suspended. Contact support if you think that is wrong.",
          403,
          "suspended",
          {},
          req,
        )
      }

      /* Guild join before the upsert so the row records the real outcome. */
      const guildJoined = await joinGuild(me.id, token.access_token)
      await upsertIdentity(id, me, guildJoined)
      /* The join credit rides on a REAL membership only (Discord answered
         201/204) and pays once per account — a disconnect + reconnect or a
         daily sign-in cannot collect twice. Never fatal. */
      const creditGranted = guildJoined ? await grantJoinCredit(id, me.id) : 0

      const googleToken = await googleAccessToken()
      const localId = await findOrCreateFirebaseUser(
        googleToken,
        email,
        clean(me.global_name || me.username, 120),
        discordAvatarUrl(me),
      )
      const customToken = await mintFirebaseCustomToken(localId, me.id)

      return json(
        {
          custom_token: customToken,
          created,
          guild_joined: guildJoined,
          credit_granted_usd: creditGranted,
          discord: {
            discord_id: me.id,
            username: clean(me.username, 64),
            global_name: clean(me.global_name, 120),
            avatar: clean(me.avatar, 120),
          },
        },
        200,
        { "x-request-id": rid },
        req,
      )
    }

    /* --------------------------------------------- connect (signed in) */
    if (action === "connect") {
      const uid = await callerUid(req)
      const state = await verifyState(body.state)
      if (state.mode !== "connect" || !state.uid || state.uid !== uid) {
        return apiError(
          "That connect link belongs to a different session. Start again from your profile.",
          403,
          "bad_state",
          {},
          req,
        )
      }
      const code = clean(body.code, 2048)
      if (!code) {
        return apiError("Missing code.", 400, "invalid_request_error", {}, req)
      }

      const token = await discordTokenExchange(code, state.ru)
      const me = await discordMe(token.access_token)
      if (!me.id) {
        return apiError(
          "Discord returned an unreadable profile. Try again.",
          502,
          "discord_profile_failed",
          {},
          req,
        )
      }

      /* One Discord account, one RageStar account. Connecting is identity
         proof only, so the email gate does not apply here — a sign-in through
         this link still runs the full verified-email and domain checks. */
      const existing = await admin
        .from("discord_identities")
        .select("user_id")
        .eq("discord_id", me.id)
        .maybeSingle()
      if (existing.data?.user_id && String(existing.data.user_id) !== uid) {
        return apiError(
          "That Discord account is already connected to a different RageStar account.",
          409,
          "discord_already_linked",
          {},
          req,
        )
      }

      const guildJoined = await joinGuild(me.id, token.access_token)
      await upsertIdentity(uid, me, guildJoined)
      /* Same one-time join credit as sign-in, same guard: real join only. */
      const creditGranted = guildJoined ? await grantJoinCredit(uid, me.id) : 0

      return json(
        {
          connected: true,
          guild_joined: guildJoined,
          credit_granted_usd: creditGranted,
          discord: {
            discord_id: me.id,
            username: clean(me.username, 64),
            global_name: clean(me.global_name, 120),
            avatar: clean(me.avatar, 120),
          },
        },
        200,
        { "x-request-id": rid },
        req,
      )
    }

    return apiError("Unknown action.", 400, "invalid_request_error", {}, req)
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return apiError(err.message, err.status, err.code, { "x-request-id": rid }, req)
    }
    console.error("discord-auth failed", rid, err)
    return apiError(
      "Could not complete the Discord step. Try again.",
      500,
      "discord_error",
      { "x-request-id": rid },
      req,
    )
  }
})
