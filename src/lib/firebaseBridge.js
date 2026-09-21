/* ==========================================================================
   Firebase → Supabase token bridge
   --------------------------------------------------------------------------
   The point of this file is that ONLY authentication moved to Firebase.

   Supabase Postgres still holds every row, and every policy in schema.sql is
   written against auth.uid(). Rather than rewrite 27 RLS policies (and change
   profiles.id away from a uuid), the browser swaps its Firebase ID token for a
   short-lived Supabase-signed access token:

       Firebase ID token  ──POST──>  /functions/v1/firebase-auth
                                        │  verifies the token against Google
                                        │  finds / links the Supabase user
                                        │  mints a Supabase JWT (sub = uuid)
       Supabase access token  <────────┘

   lib/supabase.js hands that token to supabase-js as its `accessToken`, so
   PostgREST, RPCs and RLS behave exactly as they did before the migration.

   The cache below keeps one token in memory (never localStorage — the Firebase
   SDK owns the durable session) and refreshes it a minute before it expires.
   ========================================================================== */

import {
  BRIDGE_FUNCTION,
  FUNCTIONS_URL,
  SUPABASE_ANON_KEY,
  isSupabaseConfigured,
} from "./config"
import { firebaseAuth, firebaseIdToken } from "./firebase"

const REFRESH_SKEW_MS = 60_000
const EXCHANGE_TIMEOUT_MS = 20_000
const PENDING_KEY = "ragestar-pending-profile"

/** { access_token, expires_at (ms), user } — in memory only. */
let cached = null
let inflight = null
const listeners = new Set()

function emit() {
  for (const fn of listeners) {
    try {
      fn(cached)
    } catch {
      /* a listener must never break the auth flow */
    }
  }
}

/** Subscribe to bridge-session changes. Returns an unsubscribe function. */
export function onBridgeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function bridgeSession() {
  return cached
}

export function clearBridgeSession() {
  cached = null
  inflight = null
  emit()
}

function isFresh(session) {
  return Boolean(session?.access_token) && session.expires_at - REFRESH_SKEW_MS > Date.now()
}

/* The bridge reports `expires_at` as a UNIX timestamp in SECONDS (it mirrors
   the JWT `exp` claim), but everything here compares against Date.now(), which
   is MILLISECONDS. Taking it at face value made every cached token look
   expired, so each query re-minted a brand new one. */
function expiryMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Date.now() + 55 * 60_000
  return Math.round(n < 1e12 ? n * 1000 : n)
}

/* ------------------------------------------------- signup metadata relay
   A brand new account is created in Firebase first, and the Supabase row is
   created by the bridge on the first successful exchange — which, with email
   verification on, happens minutes later in a different tab. Stash the name,
   organisation and invite code so they still land on the profile row. */

export function rememberPendingProfile(patch) {
  try {
    const next = { ...readPendingProfile(), ...patch }
    localStorage.setItem(PENDING_KEY, JSON.stringify(next))
  } catch {
    /* private mode — the profile is just created without the extras */
  }
}

export function readPendingProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || "{}")
    return raw && typeof raw === "object" ? raw : {}
  } catch {
    return {}
  }
}

export function clearPendingProfile() {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* nothing to clear */
  }
}

/* --------------------------------------------------------------- exchange */

export class BridgeError extends Error {
  constructor(message, code = "bridge_error", status = 0) {
    super(message)
    this.name = "BridgeError"
    this.code = code
    this.status = status
  }
}

function hint(status) {
  if (status === 404) {
    return `The ${BRIDGE_FUNCTION} Edge Function is not deployed. Run: supabase functions deploy ${BRIDGE_FUNCTION} --no-verify-jwt`
  }
  if (status === 0) {
    return `Could not reach ${BRIDGE_FUNCTION}. Check VITE_SUPABASE_URL, your connection, and that the function was deployed with --no-verify-jwt.`
  }
  return ""
}

async function postExchange(idToken) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS)
  const pending = readPendingProfile()

  let res
  try {
    res = await fetch(`${FUNCTIONS_URL}/${BRIDGE_FUNCTION}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        /* gets the call past the Supabase edge gateway */
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        id_token: idToken,
        full_name: pending.full_name || "",
        org: pending.org || "",
        referral_code: pending.referral_code || "",
      }),
      signal: controller.signal,
    })
  } catch (err) {
    throw new BridgeError(
      err?.name === "AbortError"
        ? "Signing in timed out. Try again."
        : hint(0),
      "network_error",
      0,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = {}
  }

  if (!res.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      hint(res.status) ||
      `Sign-in could not be completed (HTTP ${res.status}).`
    throw new BridgeError(message, payload?.error?.code || "exchange_failed", res.status)
  }

  if (!payload?.access_token || !payload?.user?.id) {
    /* An empty 2xx body means an old build of the function is still live: it
       answered the POST with the CORS preflight response. */
    throw new BridgeError(
      text.trim()
        ? "The auth bridge replied without a session. Redeploy the function and try again."
        : `${BRIDGE_FUNCTION} answered HTTP ${res.status} with an empty body. Redeploy it: supabase functions deploy ${BRIDGE_FUNCTION} --no-verify-jwt`,
      "bad_response",
      res.status,
    )
  }

  /* the row exists now, so the relay is no longer needed */
  clearPendingProfile()

  return {
    access_token: payload.access_token,
    expires_at: expiryMs(payload.expires_at),
    user: payload.user,
  }
}

/**
 * Returns a live Supabase session for the current Firebase user, minting a new
 * one when the cached token is missing or close to expiry.
 * Concurrent callers share one request.
 */
export async function getBridgeSession({ force = false } = {}) {
  if (!isSupabaseConfigured || !firebaseAuth?.currentUser) return null
  if (!force && isFresh(cached)) return cached
  if (inflight) return inflight

  inflight = (async () => {
    const idToken = await firebaseIdToken({ forceRefresh: force })
    if (!idToken) return null
    const session = await postExchange(idToken)
    cached = session
    emit()
    return session
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/** Bearer token for supabase-js and for direct Edge Function calls.
 *  Pass { force: true } to throw the cached token away and mint a new one. */
export async function getSupabaseAccessToken({ force = false } = {}) {
  try {
    const session = await getBridgeSession({ force })
    return session?.access_token || ""
  } catch {
    /* A failed exchange must not turn every query into an unhandled
       rejection: fall through to the anon key and let RLS say no. */
    return ""
  }
}

/** The current Firebase ID token, or "" when nobody is signed in. */
export async function currentFirebaseIdToken({ force = false } = {}) {
  try {
    return (await firebaseIdToken({ forceRefresh: force })) || ""
  } catch {
    return ""
  }
}

/**
 * Headers for a direct fetch to an Edge Function (admin-account, etc.).
 *
 * Both tokens go out together on purpose:
 *   authorization    the Supabase-signed token, used by PostgREST-style checks
 *   x-firebase-token the raw Firebase ID token, which the admin gate can
 *                    verify against Google without any Supabase secret
 *
 * That second header is why a missing or rotated JWT_SECRET no longer answers
 * every admin action with "Your session is not valid. Sign in again".
 */
export async function edgeHeaders({ force = false } = {}) {
  const [token, idToken] = await Promise.all([
    getSupabaseAccessToken({ force }),
    currentFirebaseIdToken({ force }),
  ])

  if (!token && !idToken) {
    throw new Error("Your session expired. Sign in again, then retry.")
  }

  const headers = {
    "content-type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    authorization: `Bearer ${token || idToken}`,
  }
  if (idToken) headers["x-firebase-token"] = idToken
  return headers
}
