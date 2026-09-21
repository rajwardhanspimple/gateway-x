/* ==========================================================================
   Auth — Firebase identity, Supabase data (v10)
   --------------------------------------------------------------------------
   WHAT MOVED: sign-in, sign-up, passwords, Google, email verification,
   password resets and the durable session. Firebase Auth owns all of it.

   WHAT DID NOT MOVE: profiles, api_keys, credits, logs, upstreams, the RPCs,
   RLS and both admin Edge Functions. They are still Supabase, reached with a
   Supabase-signed token minted by supabase/functions/firebase-auth from the
   Firebase ID token (see lib/firebaseBridge.js).

   The exported surface is deliberately identical to v9, so every page,
   component and guard keeps working without edits.
   ========================================================================== */

import { useEffect, useState } from "react"
import {
  EmailAuthProvider,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getRedirectResult,
  isSignInWithEmailLink,
  onIdTokenChanged,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  updatePassword as firebaseUpdatePassword,
  updateProfile as firebaseUpdateProfile,
  verifyPasswordResetCode,
} from "firebase/auth"
import { supabase, niceError } from "./supabase"
import {
  GOOGLE_SIGNIN_MODE,
  SITE_URL,
  isConfigured,
  isFirebaseConfigured,
  isSupabaseConfigured,
} from "./config"
import { firebaseAuth, firebaseError, googleProvider } from "./firebase"
import {
  clearBridgeSession,
  getBridgeSession,
  rememberPendingProfile,
} from "./firebaseBridge"
import { safeText } from "./sanitize"

/* ---------------------------------------------------------------- validation */

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/

/* RageStar accepts Gmail accounts only.
   ------------------------------------------------------------------
   This list is the *convenience* check that keeps the forms honest. The
   authoritative gate is server-side: the firebase-auth Edge Function reads
   app_settings.allowed_email_domains before it mints a Supabase token, so a
   blocked domain can hold a Firebase session and still reach no data at all.

   Override for a private deployment with:
     VITE_ALLOWED_EMAIL_DOMAINS="gmail.com,googlemail.com"
   and keep app_settings.allowed_email_domains in sync. */
export const ALLOWED_DOMAINS = (import.meta.env.VITE_ALLOWED_EMAIL_DOMAINS || "gmail.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean)

export const ALLOWED_DOMAINS_LABEL = ALLOWED_DOMAINS.map((d) => `@${d}`).join(" or ")

export const DOMAIN_MESSAGE = `Only ${ALLOWED_DOMAINS_LABEL} addresses can be used here`

export function emailDomain(value) {
  return String(value || "").trim().toLowerCase().split("@")[1] || ""
}

/** True when the address is well formed *and* on an allowed domain. */
export function isAllowedEmail(value) {
  const v = String(value || "").trim()
  return EMAIL_RE.test(v) && ALLOWED_DOMAINS.includes(emailDomain(v))
}

export function validateEmail(value) {
  const v = (value || "").trim()
  if (!v) return "Email is required"
  if (!EMAIL_RE.test(v)) return "Enter a valid email address"
  if (!ALLOWED_DOMAINS.includes(emailDomain(v))) return DOMAIN_MESSAGE
  return ""
}

/** Throws before any network call, so a blocked domain never reaches Firebase. */
function assertAllowedEmail(value) {
  const problem = validateEmail(value)
  if (problem) throw new Error(problem)
  return value.trim()
}

function assertReady() {
  if (!isFirebaseConfigured || !firebaseAuth) {
    throw new Error(
      "Firebase Auth is not configured. Add the VITE_FIREBASE_* values to .env and restart the dev server (see FIREBASE.md).",
    )
  }
}

/** @deprecated RageStar is Gmail-only, so there is no "use a work address" hint. */
export function isPersonalEmail() {
  return false
}

export function validateRequired(value, label = "This field") {
  return (value || "").trim() ? "" : `${label} is required`
}

export const PASSWORD_RULES = [
  { id: "len", label: "At least 8 characters", test: (v) => (v || "").length >= 8 },
  { id: "case", label: "Upper and lowercase", test: (v) => /[a-z]/.test(v || "") && /[A-Z]/.test(v || "") },
  { id: "num", label: "A number", test: (v) => /\d/.test(v || "") },
  { id: "sym", label: "A symbol", test: (v) => /[^A-Za-z0-9]/.test(v || "") },
]

export function scorePassword(value) {
  const hits = PASSWORD_RULES.filter((r) => r.test(value))
  const max = PASSWORD_RULES.length
  const score = hits.length
  const labels = ["Too short", "Weak", "Fair", "Strong", "Excellent"]
  return {
    score,
    max,
    passed: hits.map((r) => r.id),
    percent: max ? Math.round((score / max) * 100) : 0,
    label: labels[score] || labels[0],
  }
}

export function validatePassword(value) {
  if (!value) return "Password is required"
  if (value.length < 8) return "Use at least 8 characters"
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return "Mix upper and lowercase letters"
  if (!/\d/.test(value)) return "Include at least one number"
  if (!/[^A-Za-z0-9]/.test(value)) return "Include at least one symbol"
  if (value.length > 200) return "Use 200 characters or fewer"
  return ""
}

export function initials(nameOrEmail) {
  const source = (nameOrEmail || "").trim()
  if (!source) return "••"
  if (source.includes("@")) return source.slice(0, 2).toUpperCase()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/* ------------------------------------------------------------- session store */

let state = {
  loading: true,
  session: null,
  user: null,
  firebaseUser: null,
  profile: null,
  profileMissing: false,
  profileError: null,
  /* why the Firebase session could not be exchanged for a Supabase one */
  authError: null,
  needsEmailVerification: false,
  domainBlocked: false,
}
const listeners = new Set()

function emit() {
  for (const fn of listeners) fn(state)
}

function patch(next) {
  state = { ...state, ...next }
  emit()
}

const PROFILE_BASE =
  "id,email,full_name,org,plan,role,status,monthly_budget_usd,rate_limit_rpm,created_at"
const PROFILE_CREDITS = "credit_balance_usd,credits_added_usd,credits_used_usd"

async function loadProfile(user) {
  if (!user) {
    return patch({ profile: null, profileMissing: false, profileError: null })
  }
  let { data, error } = await supabase
    .from("profiles")
    .select(`${PROFILE_BASE},${PROFILE_CREDITS}`)
    .eq("id", user.id)
    .maybeSingle()

  /* the credit columns only exist once upgrade-v5.4.sql has been applied */
  if (error) {
    const retry = await supabase
      .from("profiles")
      .select(PROFILE_BASE)
      .eq("id", user.id)
      .maybeSingle()
    data = retry.data
    error = retry.error
  }

  if (error || !data) {
    /* Do NOT silently claim `role: "user"` here. A failed read - an RLS denial,
       a column that does not exist yet, a dropped connection - used to look
       exactly like a real non-admin account, which is how an admin ends up
       staring at "Admin only" on their own workspace. Keep a placeholder so
       the shell can still render, but leave the role UNKNOWN and record why. */
    patch({
      profileMissing: !error,
      profileError: error
        ? {
            message: error.message || "Could not read your profile row",
            code: error.code || "",
            details: error.details || "",
            hint: error.hint || "",
          }
        : null,
      profile: {
        id: user.id,
        email: user.email || "",
        full_name: user.user_metadata?.full_name || "",
        org: user.user_metadata?.org || "",
        role: null,
        status: null,
        plan: "free",
        placeholder: true,
      },
    })
    return
  }
  patch({ profile: data, profileMissing: false, profileError: null })
}

/* ------------------------------------------------------- firebase → state */

function shapeUser(bridgeUser, fbUser) {
  return {
    /* the Supabase uuid — this is what auth.uid() and profiles.id use */
    id: bridgeUser.id,
    email: bridgeUser.email || fbUser?.email || "",
    firebase_uid: fbUser?.uid || bridgeUser.firebase_uid || "",
    email_verified: Boolean(fbUser?.emailVerified),
    providers: (fbUser?.providerData || []).map((p) => p?.providerId).filter(Boolean),
    user_metadata: {
      full_name: fbUser?.displayName || bridgeUser.full_name || "",
      org: bridgeUser.org || "",
      avatar_url: fbUser?.photoURL || "",
    },
  }
}

async function adoptFirebaseUser(fbUser) {
  if (!fbUser) {
    clearBridgeSession()
    patch({
      loading: false,
      session: null,
      user: null,
      firebaseUser: null,
      profile: null,
      profileMissing: false,
      profileError: null,
      needsEmailVerification: false,
    })
    return
  }

  patch({ firebaseUser: fbUser })

  if (!isSupabaseConfigured) {
    patch({ loading: false, authError: null })
    return
  }

  try {
    const session = await getBridgeSession({ force: true })
    if (!session) {
      patch({ loading: false })
      return
    }
    patch({
      session: {
        access_token: session.access_token,
        expires_at: session.expires_at,
        user: session.user,
      },
      user: shapeUser(session.user, fbUser),
      authError: null,
      needsEmailVerification: false,
      domainBlocked: false,
      loading: false,
    })
    await loadProfile(state.user)
  } catch (err) {
    /* The Firebase session is real but the workspace refused it: unverified
       email, a blocked domain, or a suspended account. Keep the Firebase user
       (so "resend verification" still works) and say exactly what happened. */
    const code = err?.code || ""
    clearBridgeSession()
    patch({
      loading: false,
      session: null,
      user: null,
      profile: null,
      needsEmailVerification: code === "email_not_verified",
      domainBlocked: code === "domain_blocked",
      authError: { code, message: err?.message || "Could not start your session." },
    })
  }
}

/* ------------------------------------------------------------------- boot */

if (isFirebaseConfigured && firebaseAuth) {
  /* onIdTokenChanged (not onAuthStateChanged): it also fires when the SDK
     silently refreshes the ID token, which is exactly when the bridged
     Supabase token should be re-minted. */
  onIdTokenChanged(firebaseAuth, (fbUser) => {
    adoptFirebaseUser(fbUser).catch(() => patch({ loading: false }))
  })

  /* Google in redirect mode lands back here with the result pending. */
  getRedirectResult(firebaseAuth).catch((err) => {
    const message = firebaseError(err, "")
    if (message) patch({ authError: { code: err?.code || "redirect", message } })
  })

  /* An email-link (magic link) sign-in completes on load. */
  completeEmailLinkSignIn().catch(() => {})

  /* Nobody signed in and no link to process: stop the spinner. */
  window.setTimeout(() => {
    if (state.loading && !firebaseAuth.currentUser) patch({ loading: false })
  }, 1200)
} else {
  state = { ...state, loading: false }
}

/** Subscribe to the live auth state. */
export function useSession() {
  const [snap, setSnap] = useState(state)
  useEffect(() => {
    const fn = (next) => setSnap(next)
    listeners.add(fn)
    setSnap(state)
    return () => listeners.delete(fn)
  }, [])
  const role = snap.profile?.role ?? null
  const isAdmin = role === "admin"
  /* v12.4 roles: user < early_access < admin. An admin is always treated as
     early access, so no gate has to test for both. */
  const isEarlyAccess = isAdmin || role === "early_access"
  return {
    ...snap,
    isAuthed: Boolean(snap.session),
    isAdmin,
    role,
    isEarlyAccess,
    accessTier: isEarlyAccess ? "early_access" : "public",
    /* false when the profile read failed, so a gate can tell "you are not an
       admin" apart from "we could not find out" */
    roleKnown: role != null,
    displayName: snap.profile?.full_name || snap.user?.email || "",
  }
}

export function getSession() {
  return state.session
}

export function refreshProfile() {
  return loadProfile(state.user)
}

/** Re-run the Firebase → Supabase exchange, e.g. after verifying an email. */
export async function retrySession() {
  const fbUser = firebaseAuth?.currentUser
  if (!fbUser) return
  try {
    await fbUser.reload()
  } catch {
    /* offline — use whatever the SDK already has */
  }
  patch({ loading: true, authError: null })
  await adoptFirebaseUser(firebaseAuth.currentUser)
}

/* ---------------------------------------------------------------- redirects */

const SITE = SITE_URL

/** Absolute return URL for a hash route, e.g. "#/console" -> "https://ragestar.bond/#/console". */
export function authRedirect(route = "#/console") {
  const base =
    SITE || `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, "")
  return `${base}/${route}`
}

function actionCodeSettings(route) {
  return { url: authRedirect(route), handleCodeInApp: true }
}

/* ------------------------------------------------------------------ actions */

export async function signIn({ email, password }) {
  assertReady()
  const address = assertAllowedEmail(email)
  try {
    const cred = await signInWithEmailAndPassword(firebaseAuth, address, password)
    /* Wait for the Supabase side before reporting success, so the console is
       never entered with a Firebase session the workspace refuses. */
    await adoptFirebaseUser(cred.user)
    if (state.authError) {
      const err = new Error(state.authError.message)
      err.code = state.authError.code
      throw err
    }
    return { session: state.session, user: state.user }
  } catch (err) {
    if (err?.code && String(err.code).startsWith("auth/")) {
      throw new Error(firebaseError(err, "Could not sign you in."))
    }
    throw err
  }
}

/* ------------------------------------------------------------- referrals */

const REF_KEY = "ragestar-ref"

/** Codes are short and from a fixed alphabet. Anything else is ignored rather
 *  than forwarded, so a hostile link cannot push arbitrary text into the
 *  profile row the bridge creates. */
export function normaliseReferral(value) {
  const code = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
  return /^[0-9A-Z]{4,12}$/.test(code) ? code : ""
}

/** Remembers a ?ref= code so it survives the hop to Google and back. */
export function rememberReferral(value) {
  const code = normaliseReferral(value)
  try {
    if (code) sessionStorage.setItem(REF_KEY, code)
    else sessionStorage.removeItem(REF_KEY)
  } catch {
    /* private mode — the code just won't survive an OAuth round trip */
  }
  return code
}

/** Reads the pending code: the URL wins, then whatever we stashed earlier. */
export function pendingReferral() {
  try {
    const hash = window.location.hash || ""
    const qs = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : ""
    const fromUrl = normaliseReferral(new URLSearchParams(qs).get("ref"))
    if (fromUrl) return rememberReferral(fromUrl)
    return normaliseReferral(sessionStorage.getItem(REF_KEY))
  } catch {
    return ""
  }
}

export function clearReferral() {
  try {
    sessionStorage.removeItem(REF_KEY)
  } catch {
    /* nothing to clear */
  }
}

export async function signUp({ email, password, fullName, org, referral }) {
  assertReady()
  const address = assertAllowedEmail(email)
  const passwordProblem = validatePassword(password)
  if (passwordProblem) throw new Error(passwordProblem)

  const name = safeText((fullName || "").trim(), 80).replace(/[<>]/g, "")
  const company = safeText((org || "").trim(), 80).replace(/[<>]/g, "")
  const code = normaliseReferral(referral ?? pendingReferral())

  /* The Supabase row is created by the bridge, which may not run until the
     verification link is clicked. Keep the extras until then. */
  rememberPendingProfile({ full_name: name, org: company, referral_code: code })

  try {
    const cred = await createUserWithEmailAndPassword(firebaseAuth, address, password)
    if (name) {
      await firebaseUpdateProfile(cred.user, { displayName: name }).catch(() => {})
    }
    await sendEmailVerification(cred.user, actionCodeSettings("#/login")).catch(() => {})

    /* Try to open the workspace session immediately. With "verified email
       required" left on (the default) this fails by design and the UI asks the
       person to click the link first. */
    await adoptFirebaseUser(cred.user)
    clearReferral()

    return {
      session: state.session,
      needsConfirmation: !state.session,
    }
  } catch (err) {
    if (err?.code && String(err.code).startsWith("auth/")) {
      throw new Error(firebaseError(err, "Could not create your account."))
    }
    throw err
  }
}

/* Google is the only provider that can satisfy a Gmail-only workspace. */
const ALLOWED_PROVIDERS = new Set(["google"])

export async function signInWithProvider(provider) {
  assertReady()
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new Error(`${DOMAIN_MESSAGE} — use Google or an email and password`)
  }
  const gp = googleProvider(ALLOWED_DOMAINS)
  try {
    if (GOOGLE_SIGNIN_MODE === "redirect") {
      await signInWithRedirect(firebaseAuth, gp)
      return { redirecting: true }
    }
    const cred = await signInWithPopup(firebaseAuth, gp)
    const address = cred?.user?.email || ""
    if (address && !isAllowedEmail(address)) {
      /* Google let them pick a non-Gmail account: end it here rather than
         leaving a half-signed-in session lying around. */
      await firebaseSignOut(firebaseAuth).catch(() => {})
      throw new Error(DOMAIN_MESSAGE)
    }
    await adoptFirebaseUser(cred.user)
    if (state.authError) throw new Error(state.authError.message)
    return { session: state.session }
  } catch (err) {
    if (err?.code && String(err.code).startsWith("auth/")) {
      throw new Error(firebaseError(err, "Google sign-in did not complete."))
    }
    throw err
  }
}

/* ------------------------------------------------------------- email links */

const LINK_EMAIL_KEY = "ragestar-link-email"

export async function sendMagicLink(email) {
  assertReady()
  const address = assertAllowedEmail(email)
  try {
    await sendSignInLinkToEmail(firebaseAuth, address, actionCodeSettings("#/login"))
    try {
      localStorage.setItem(LINK_EMAIL_KEY, address)
    } catch {
      /* the person will be asked for the address when they land */
    }
  } catch (err) {
    throw new Error(firebaseError(err, "Could not send the sign-in link."))
  }
}

/**
 * Finishes an email-link sign-in when the browser lands on the link.
 * Pass an address when the link is opened in a different browser to the one
 * that requested it (the stashed email is gone in that case).
 */
export async function completeEmailLinkSignIn(email) {
  if (!isFirebaseConfigured || !firebaseAuth) return { handled: false }
  const href = window.location.href
  if (!isSignInWithEmailLink(firebaseAuth, href)) return { handled: false }

  let address = email || ""
  if (!address) {
    try {
      address = localStorage.getItem(LINK_EMAIL_KEY) || ""
    } catch {
      address = ""
    }
  }
  if (!address) {
    patch({
      loading: false,
      authError: {
        code: "link_needs_email",
        message: "Confirm the email address this link was sent to.",
      },
    })
    return { handled: false, needsEmail: true }
  }

  try {
    const cred = await signInWithEmailLink(firebaseAuth, address, href)
    try {
      localStorage.removeItem(LINK_EMAIL_KEY)
    } catch {
      /* nothing to clear */
    }
    await adoptFirebaseUser(cred.user)
    return { handled: true }
  } catch (err) {
    patch({
      loading: false,
      authError: {
        code: err?.code || "link_failed",
        message: firebaseError(err, "That sign-in link is no longer valid."),
      },
    })
    return { handled: false, error: firebaseError(err) }
  }
}

/* ------------------------------------------------------------------ signout */

export async function signOut() {
  clearBridgeSession()
  try {
    if (firebaseAuth) await firebaseSignOut(firebaseAuth)
  } catch {
    /* already gone */
  }
  patch({ session: null, user: null, firebaseUser: null, profile: null, authError: null })
  window.location.hash = "#/login"
}

/* ------------------------------------------------------------- passwords */

export async function sendPasswordReset(email) {
  assertReady()
  const address = assertAllowedEmail(email)
  try {
    await sendPasswordResetEmail(firebaseAuth, address, actionCodeSettings("#/reset"))
  } catch (err) {
    /* Never confirm whether an address exists. */
    if (err?.code === "auth/user-not-found") return
    throw new Error(firebaseError(err, "Could not send the reset link."))
  }
}

/**
 * The reset code Firebase put in the URL, if any.
 * Works for both `?mode=resetPassword&oobCode=…` and the hash-router form
 * `#/reset?mode=resetPassword&oobCode=…`.
 */
export function pendingResetCode() {
  try {
    const search = new URLSearchParams(window.location.search || "")
    const hash = window.location.hash || ""
    const hashQs = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : ""
    const fromHash = new URLSearchParams(hashQs)
    const mode = search.get("mode") || fromHash.get("mode") || ""
    const code = search.get("oobCode") || fromHash.get("oobCode") || ""
    if (!code) return ""
    if (mode && mode !== "resetPassword") return ""
    return code
  } catch {
    return ""
  }
}

/** Which address a reset code belongs to — shown on the "new password" screen. */
export async function resetCodeEmail(code) {
  assertReady()
  try {
    return await verifyPasswordResetCode(firebaseAuth, code)
  } catch (err) {
    throw new Error(firebaseError(err, "That reset link is no longer valid."))
  }
}

/** Finish a reset started from an email link. */
export async function completePasswordReset(code, password) {
  assertReady()
  const problem = validatePassword(password)
  if (problem) throw new Error(problem)
  try {
    await confirmPasswordReset(firebaseAuth, code, password)
  } catch (err) {
    throw new Error(firebaseError(err, "Could not set that password."))
  }
}

/** Change the password of the account that is already signed in. */
export async function updatePassword(password, { currentPassword = "" } = {}) {
  assertReady()
  const problem = validatePassword(password)
  if (problem) throw new Error(problem)
  const user = firebaseAuth.currentUser
  if (!user) throw new Error("Not signed in")

  try {
    if (currentPassword && user.email) {
      const credential = EmailAuthProvider.credential(user.email, currentPassword)
      await reauthenticateWithCredential(user, credential)
    }
    await firebaseUpdatePassword(user, password)
  } catch (err) {
    throw new Error(firebaseError(err, "Could not update your password."))
  }
}

/** Re-send the verification email to the account currently signed in. */
export async function resendConfirmation(email) {
  assertReady()
  const user = firebaseAuth.currentUser
  if (!user) {
    throw new Error(
      "Sign in with your email and password first — the verification link can only be resent to the signed-in account.",
    )
  }
  if (email && user.email && user.email.toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`You are signed in as ${user.email}. Sign out first to use another address.`)
  }
  try {
    await sendEmailVerification(user, actionCodeSettings("#/login"))
  } catch (err) {
    throw new Error(firebaseError(err, "Could not resend the verification email."))
  }
}

/* -------------------------------------------------------------- profile */

/* Only these two columns are writable by the account owner — the migration
   revokes UPDATE on everything else, so credits, role, status, plan, budget
   and rate limit cannot be changed from the browser at all. */
export async function updateProfile({ fullName, org }) {
  const user = state.user
  if (!user) throw new Error("Not signed in")
  const name = safeText((fullName || "").trim(), 80).replace(/[<>]/g, "")
  const company = safeText((org || "").trim(), 80).replace(/[<>]/g, "")

  const { error } = await supabase
    .from("profiles")
    .update({ full_name: name, org: company })
    .eq("id", user.id)
  if (error) throw new Error(niceError(error))

  /* keep the Firebase display name in step, so Google/one-tap UIs agree */
  if (firebaseAuth?.currentUser && name) {
    firebaseUpdateProfile(firebaseAuth.currentUser, { displayName: name }).catch(() => {})
  }
  await loadProfile(user)
}

export { isConfigured }
