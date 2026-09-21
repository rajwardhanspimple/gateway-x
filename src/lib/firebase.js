/* ==========================================================================
   Firebase Auth — the identity layer (v10)
   --------------------------------------------------------------------------
   This is the ONLY Firebase product the app uses. No Firestore, no Storage,
   no Functions, no Analytics: accounts, passwords, Google sign-in, email
   verification and password resets live here, and every byte of application
   data still lives in Supabase Postgres behind the same RLS policies.

   Nothing in this file talks to the database. `lib/firebaseBridge.js` swaps
   the Firebase ID token for a Supabase-signed one, and `lib/supabase.js`
   attaches that token to every query.
   ========================================================================== */

import { initializeApp, getApp, getApps } from "firebase/app"
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  setPersistence,
} from "firebase/auth"
import { FIREBASE_CONFIG, isFirebaseConfigured } from "./config"

export { isFirebaseConfigured }

let app = null
let auth = null

if (isFirebaseConfigured) {
  app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG)

  /* initializeAuth over getAuth: it lets us pin the persistence and the
     popup/redirect resolver instead of pulling in every fallback path, which
     keeps the auth bundle smaller and the behaviour predictable. */
  try {
    auth = initializeAuth(app, {
      persistence: browserLocalPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    })
  } catch {
    /* already initialised (hot reload / a second import) */
    auth = getAuth(app)
    setPersistence(auth, browserLocalPersistence).catch(() => {
      /* private mode: the session simply does not survive a reload */
    })
  }

  /* Send Firebase's own emails and error strings in the browser's language. */
  try {
    auth.useDeviceLanguage()
  } catch {
    /* not fatal */
  }
}

export const firebaseApp = app

/** The Firebase Auth instance, or null when .env has not been filled in. */
export const firebaseAuth = auth

/** Google is the only provider a Gmail-only workspace can satisfy. */
export function googleProvider(allowedDomains = []) {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({
    /* always show the picker: people have several Google accounts */
    prompt: "select_account",
    /* single-domain workspaces get the account hint too */
    ...(allowedDomains.length === 1 ? { hd: allowedDomains[0] } : {}),
  })
  return provider
}

/** Current Firebase ID token, refreshed by the SDK when it is close to expiry. */
export async function firebaseIdToken({ forceRefresh = false } = {}) {
  const user = auth?.currentUser
  if (!user) return ""
  try {
    return await user.getIdToken(forceRefresh)
  } catch {
    return ""
  }
}

/* ---------------------------------------------------------------- errors */

const FIREBASE_ERRORS = {
  "auth/invalid-credential": "That email and password combination is not recognised.",
  "auth/invalid-login-credentials": "That email and password combination is not recognised.",
  "auth/wrong-password": "That email and password combination is not recognised.",
  "auth/user-not-found": "That email and password combination is not recognised.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/email-already-in-use":
    "An account with that email already exists. Sign in instead.",
  "auth/weak-password": "Use a longer password — at least 8 characters.",
  "auth/user-disabled": "That account has been disabled. Contact a workspace admin.",
  "auth/too-many-requests":
    "Too many attempts. Wait a minute before trying again.",
  "auth/requires-recent-login":
    "For safety, sign in again before changing your password.",
  "auth/popup-closed-by-user": "The Google window closed before sign-in finished.",
  "auth/cancelled-popup-request": "Only one sign-in window at a time.",
  "auth/popup-blocked":
    "Your browser blocked the Google popup. Allow popups, or set VITE_GOOGLE_SIGNIN_MODE=redirect.",
  "auth/unauthorized-domain":
    "This origin is not on the Firebase authorised-domains list. Add it under Authentication → Settings → Authorized domains.",
  "auth/operation-not-allowed":
    "That sign-in method is switched off in the Firebase console. Enable it under Authentication → Sign-in method.",
  "auth/invalid-action-code":
    "That link has already been used or has expired. Request a new one.",
  "auth/expired-action-code": "That link has expired. Request a new one.",
  "auth/network-request-failed":
    "Cannot reach Firebase. Check your connection and try again.",
  "auth/missing-email": "Enter the email address for your account.",
}

/** Turn a FirebaseError into something a person can act on. */
export function firebaseError(error, fallback = "Something went wrong. Try again.") {
  if (!error) return fallback
  const code = String(error.code || "").toLowerCase()
  if (FIREBASE_ERRORS[code]) return FIREBASE_ERRORS[code]
  const raw = String(error.message || "").replace(/^Firebase:\s*/i, "")
  const tidy = raw.replace(/\s*\(auth\/[a-z-]+\)\.?$/i, "").trim()
  return tidy || fallback
}
