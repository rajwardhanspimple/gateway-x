/* ==========================================================================
   Browser configuration
   --------------------------------------------------------------------------
   One place that reads import.meta.env, so supabase.js, firebase.js and the
   token bridge cannot drift apart (and cannot import each other in a circle).

   v10: identity moved to Firebase Auth. Everything else — the database, RLS,
   the RPCs, the router and admin Edge Functions — is still Supabase. Nothing
   about the data layer changed.
   ========================================================================== */

const clean = (value) => String(value ?? "").trim()
const noTrailingSlash = (value) => clean(value).replace(/\/+$/, "")

/* ------------------------------------------------------------- supabase */

export const SUPABASE_URL = noTrailingSlash(import.meta.env.VITE_SUPABASE_URL)

/** Needed as the `apikey` header on every Edge Function call. */
export const SUPABASE_ANON_KEY = clean(import.meta.env.VITE_SUPABASE_ANON_KEY)

export const FUNCTIONS_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : ""

/** Public gateway base URL that customers point their SDK at. */
export const GATEWAY_URL =
  noTrailingSlash(import.meta.env.VITE_GATEWAY_URL) ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/router/v1` : "")

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

/* ------------------------------------------------------------- firebase */

export const FIREBASE_CONFIG = {
  apiKey: clean(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: clean(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: clean(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  appId: clean(import.meta.env.VITE_FIREBASE_APP_ID),
  /* Optional. Only present so a copy-pasted Firebase snippet still works —
     RageStar uses Firebase for authentication and nothing else. */
  messagingSenderId: clean(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID) || undefined,
  storageBucket: clean(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET) || undefined,
}

export const isFirebaseConfigured = Boolean(
  FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.authDomain && FIREBASE_CONFIG.projectId,
)

/** Name of the Edge Function that swaps a Firebase ID token for a Supabase one. */
export const BRIDGE_FUNCTION = clean(import.meta.env.VITE_FIREBASE_BRIDGE_FN) || "firebase-auth"

/** Google sign-in: "popup" is friendlier, "redirect" survives blocked popups. */
export const GOOGLE_SIGNIN_MODE =
  clean(import.meta.env.VITE_GOOGLE_SIGNIN_MODE).toLowerCase() === "redirect"
    ? "redirect"
    : "popup"

/* ----------------------------------------------------------------- site */

/* Canonical public origin. Firebase builds its email links from the project's
   authorised domains, but the app still needs to know where to send people
   back to after a redirect sign-in or an email-link hop. */
export const SITE_URL = noTrailingSlash(import.meta.env.VITE_SITE_URL)

/* Optional public invite link for the community Discord server, shown on the
   profile tab next to the connect card. Every other Discord value — client
   id, client secret, bot token, guild id — is a server-side secret on the
   discord-auth Edge Function and must never become a VITE_* variable. */
export const DISCORD_INVITE_URL = clean(import.meta.env.VITE_DISCORD_INVITE_URL)

/* ------------------------------------------------------------- messages */

export const SUPABASE_CONFIG_MESSAGE =
  "Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env, then restart the dev server."

export const FIREBASE_CONFIG_MESSAGE =
  "Firebase Auth is not configured. Add VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN and VITE_FIREBASE_PROJECT_ID to .env, then restart the dev server. See FIREBASE.md."

/** True when both halves are present: Firebase for identity, Supabase for data. */
export const isConfigured = isSupabaseConfigured && isFirebaseConfigured

export const CONFIG_MESSAGE = !isSupabaseConfigured
  ? SUPABASE_CONFIG_MESSAGE
  : FIREBASE_CONFIG_MESSAGE
