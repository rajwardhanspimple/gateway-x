/* ==========================================================================
   Discord — OAuth2 sign-in, account connect and guild join (v12.6)
   --------------------------------------------------------------------------
   Firebase Authentication has no Discord provider, so Discord sign-in is a
   custom OAuth2 round trip whose server half is the discord-auth Edge
   Function:

     beginDiscordSignIn()       POST {action:"start"}    → discord.com
       (Discord redirects back to <site root>/?code=…&state=… — redirect URIs
        cannot carry a #hash, so the callback lands on the root, exactly like
        the password-reset oobCode pendingResetCode() reads there)
     completeDiscordCallback()  POST {action:"exchange"}  → Firebase custom
                                token → signInWithCustomToken → the v10 bridge
                                mints the Supabase JWT as usual

   Connect is the same trip with mode "connect" and the caller's session
   attached, so a Discord identity can never be grafted onto someone else's
   account.

   This module imports config, firebase, firebaseBridge and supabase ONLY —
   never auth.js — so the auth state machine cannot end up in an import cycle
   with it (auth.js must never import this file either).
   ========================================================================== */

import { signInWithCustomToken, onAuthStateChanged } from "firebase/auth"
import { DISCORD_INVITE_URL, FUNCTIONS_URL, SUPABASE_ANON_KEY } from "./config"
import { firebaseAuth } from "./firebase"
import {
  bridgeSession,
  edgeHeaders,
  rememberPendingProfile,
} from "./firebaseBridge"
import { niceError, supabase } from "./supabase"

const FN = `${FUNCTIONS_URL}/discord-auth`
const RESULT_KEY = "ragestar-discord-result"

export { DISCORD_INVITE_URL }

/* ------------------------------------------------------------- referrals
   auth.js owns the referral stash, but importing it from here would close an
   import cycle. The reads below duplicate exactly what pendingReferral()
   does, so a ?ref= code survives the Discord hop the same way it survives
   the Google one. */

const REF_KEY = "ragestar-ref"

function pendingReferralCode() {
  try {
    const hash = window.location.hash || ""
    const qs = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : ""
    const fromUrl = new URLSearchParams(qs).get("ref") || ""
    const code = (fromUrl || sessionStorage.getItem(REF_KEY) || "")
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, "")
    return /^[0-9A-Z]{4,12}$/.test(code) ? code : ""
  } catch {
    return ""
  }
}

/* --------------------------------------------------------- result hand-off
   The callback completes at boot, before any page has mounted. Whatever
   happened — signed in, connected, refused — is stashed here so the page the
   person lands on can say it out loud. Same pattern as the referral stash. */

function stashResult(result) {
  try {
    sessionStorage.setItem(RESULT_KEY, JSON.stringify(result))
  } catch {
    /* private mode — the landing page just stays quiet */
  }
}

/** Reads and clears the stashed callback result, or null when there is none. */
export function takeDiscordResult() {
  try {
    const raw = sessionStorage.getItem(RESULT_KEY)
    sessionStorage.removeItem(RESULT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ start */

async function postStart(body, headers) {
  let res
  try {
    res = await fetch(FN, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(
      "Could not reach the discord-auth function. Check VITE_SUPABASE_URL, then deploy it: supabase functions deploy discord-auth --no-verify-jwt",
    )
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok || !payload?.url) {
    throw new Error(
      payload?.error?.message ||
        `Discord sign-in could not start (HTTP ${res.status}).`,
    )
  }
  return payload.url
}

/* The redirect target is always the site root: OAuth redirect URIs cannot
   carry a #hash, and the whole app lives behind one. The function allow-lists
   it against DISCORD_REDIRECT_URI plus the localhost dev entries. */
function redirectUri() {
  return (
    `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, "") +
    "/"
  )
}

export async function beginDiscordSignIn() {
  const url = await postStart(
    { action: "start", mode: "signin", redirect: redirectUri() },
    {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  )
  /* keep the invite code alive across the hop, exactly like signUp() does —
     the bridge's pending-profile relay lands it on the new profile row */
  const ref = pendingReferralCode()
  if (ref) rememberPendingProfile({ referral_code: ref })
  window.location.assign(url)
}

export async function beginDiscordConnect() {
  const headers = await edgeHeaders()
  const url = await postStart(
    { action: "start", mode: "connect", redirect: redirectUri() },
    headers,
  )
  window.location.assign(url)
}

/* -------------------------------------------------------------- auth ready
   completeDiscordCallback() runs at module load in main.jsx, BEFORE React has
   rendered a thing. The Firebase SDK restores a persisted (browserLocal-
   Persistence) session asynchronously, so at that instant firebaseAuth
   .currentUser is still null even for a signed-in member — and edgeHeaders()
   reads it as "no session" and throws "Your session expired."

   Connect mode needs the caller's identity (it is what binds the Discord link
   to the right account), so before asking for tokens we wait for the SDK to
   finish restoring. authStateReady() is the SDK's own promise for exactly
   this; onAuthStateChanged's first fire is the fallback. Sign-in mode needs
   nothing — it has no caller session by definition. */
function authReady(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!firebaseAuth) return resolve(null)
    if (typeof firebaseAuth.authStateReady === "function") {
      firebaseAuth
        .authStateReady()
        .then(() => resolve(firebaseAuth.currentUser))
        .catch(() => resolve(firebaseAuth.currentUser))
      return
    }
    let settled = false
    const done = (u) => {
      if (settled) return
      settled = true
      resolve(u || null)
    }
    const unsub = onAuthStateChanged(firebaseAuth, (u) => {
      unsub()
      done(u)
    })
    window.setTimeout(() => {
      unsub()
      done(firebaseAuth.currentUser)
    }, timeoutMs)
  })
}

/* --------------------------------------------------------------- callback */

/** The Discord query string sitting on the URL right now, if any. */
export function pendingDiscordCallback() {
  try {
    const qs = new URLSearchParams(window.location.search || "")
    const error = qs.get("error") || ""
    const code = qs.get("code") || ""
    const state = qs.get("state") || ""
    if (!state || (!code && !error)) return null
    return { error, code, state }
  } catch {
    return null
  }
}

/* The state payload is signed, not secret: the middle segment tells us which
   mode this callback is in, so it can be routed without a server round trip. */
function stateMode(state) {
  try {
    const part = String(state).split(".")[1]
    const payload = JSON.parse(
      atob(part.replace(/-/g, "+").replace(/_/g, "/")),
    )
    return payload?.mode === "connect" ? "connect" : "signin"
  } catch {
    return "signin"
  }
}

function stripCallbackQuery() {
  try {
    window.history.replaceState(
      null,
      "",
      `${window.location.origin}${window.location.pathname}${
        window.location.hash || "#/"
      }`,
    )
  } catch {
    /* older browser — the query just stays visible */
  }
}

async function postCallback(body, authed) {
  const headers = authed
    ? await edgeHeaders()
    : {
        "content-type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      }
  let res
  try {
    res = await fetch(FN, { method: "POST", headers, body: JSON.stringify(body) })
  } catch {
    throw new Error("Could not reach the discord-auth function. Try again.")
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      payload?.error?.message ||
        `Discord sign-in did not complete (HTTP ${res.status}).`,
    )
  }
  return payload
}

/**
 * Finishes a Discord OAuth round trip. Called once from main.jsx at boot —
 * before the first render — so the ?code&state on the URL is consumed exactly
 * once and never survives a refresh.
 */
export async function completeDiscordCallback() {
  const pending = pendingDiscordCallback()
  if (!pending) return { handled: false }
  stripCallbackQuery()

  const mode = stateMode(pending.state)

  if (pending.error) {
    /* access_denied = the person pressed Cancel on Discord's consent screen */
    stashResult({
      ok: false,
      mode,
      message: "Discord sign-in was cancelled before it finished.",
    })
    window.location.hash = mode === "connect" ? "#/dashboard/profile" : "#/login"
    return { handled: true, cancelled: true }
  }

  try {
    if (mode === "connect") {
      /* Wait for the persisted session to come back before asking for the
         caller's tokens — this is the boot race the authReady helper exists
         for. If it comes back empty the member genuinely is signed out. */
      await authReady()
      const out = await postCallback(
        { action: "connect", code: pending.code, state: pending.state },
        true,
      )
      stashResult({
        ok: true,
        mode,
        username: out?.discord?.global_name || out?.discord?.username || "",
        guildJoined: Boolean(out?.guild_joined),
        creditGranted: Number(out?.credit_granted_usd || 0) || 0,
      })
      window.location.hash = "#/dashboard/profile"
      return { handled: true }
    }

    const out = await postCallback(
      { action: "exchange", code: pending.code, state: pending.state },
      false,
    )
    if (!out?.custom_token) {
      throw new Error(
        "The discord-auth function replied without a session. Redeploy it: supabase functions deploy discord-auth --no-verify-jwt",
      )
    }
    if (!firebaseAuth) {
      throw new Error(
        "Firebase Auth is not configured. Add the VITE_FIREBASE_* values to .env and restart the dev server (see FIREBASE.md).",
      )
    }
    /* From here the v10 machine takes over: onIdTokenChanged fires,
       adoptFirebaseUser exchanges the Firebase token for the Supabase one,
       and the console opens on an ordinary session. */
    await signInWithCustomToken(firebaseAuth, out.custom_token)
    stashResult({
      ok: true,
      mode,
      username: out?.discord?.global_name || out?.discord?.username || "",
      guildJoined: Boolean(out?.guild_joined),
      creditGranted: Number(out?.credit_granted_usd || 0) || 0,
    })
    window.location.hash = "#/dashboard"
    return { handled: true }
  } catch (err) {
    stashResult({
      ok: false,
      mode,
      message: err?.message || "Discord sign-in did not complete.",
    })
    window.location.hash = mode === "connect" ? "#/dashboard/profile" : "#/login"
    return { handled: true, error: err }
  }
}

/* --------------------------------------------------------------- identity */

/**
 * The caller's own linked Discord identity, or null when none exists.
 * Returns { unavailable: true } when the v12.6 migration has not been run,
 * so the profile card can name the exact upgrade file instead of failing.
 */
export async function myDiscordIdentity() {
  const uid = bridgeSession()?.user?.id
  if (!uid) return { identity: null, unavailable: false }
  const { data, error } = await supabase
    .from("discord_identities")
    .select("discord_id,username,global_name,avatar,email,guild_member,connected_at")
    .eq("user_id", uid)
    .maybeSingle()
  if (error) {
    const code = String(error?.code || "")
    if (code === "42P01" || code === "PGRST205" || code === "PGRST202") {
      return { identity: null, unavailable: true }
    }
    throw new Error(niceError(error))
  }
  return { identity: data || null, unavailable: false }
}

/** The caller's one-time join-credit grant row, or null when unpaid — or
 *  when v12.7 is not installed, in which case the offer simply stays quiet. */
export async function myDiscordJoinGrant() {
  const uid = bridgeSession()?.user?.id
  if (!uid) return null
  const { data, error } = await supabase
    .from("discord_join_grants")
    .select("amount_usd,granted_at")
    .eq("user_id", uid)
    .maybeSingle()
  if (error) {
    const code = String(error?.code || "")
    if (code === "42P01" || code === "PGRST205" || code === "PGRST202") return null
    throw new Error(niceError(error))
  }
  return data || null
}

/** Removes the caller's own link. RLS limits the delete to their row. */
export async function disconnectDiscord() {
  const uid = bridgeSession()?.user?.id
  if (!uid) throw new Error("Your session expired. Sign in again, then retry.")
  const { error } = await supabase
    .from("discord_identities")
    .delete()
    .eq("user_id", uid)
  if (error) throw new Error(niceError(error))
}

/** CDN URL for a stored avatar hash (the CSP allows cdn.discordapp.com). */
export function discordAvatarUrl(discordId, avatar) {
  if (!discordId || !avatar) return ""
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128`
}
