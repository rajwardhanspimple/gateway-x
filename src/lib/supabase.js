/* ==========================================================================
   Supabase client — data only (v10)
   --------------------------------------------------------------------------
   Authentication moved to Firebase. NOTHING else did: the tables, the views,
   the RPCs, the RLS policies, the router and the admin Edge Functions are all
   unchanged and still live in your Supabase project.

   The one difference from v9 is where the bearer token comes from. Instead of
   supabase.auth holding a GoTrue session, the client asks lib/firebaseBridge
   for a Supabase-signed token minted from the current Firebase ID token. That
   token carries `sub = <the Supabase user uuid>`, so auth.uid() keeps
   resolving and every existing policy keeps working.

   Do not call supabase.auth.* any more — supabase-js disables it in
   third-party-token mode. Use lib/auth.js for sessions instead.
   ========================================================================== */

import { createClient } from "@supabase/supabase-js"
import {
  CONFIG_MESSAGE,
  FUNCTIONS_URL,
  GATEWAY_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isConfigured,
  isFirebaseConfigured,
  isSupabaseConfigured,
} from "./config"
import { getSupabaseAccessToken } from "./firebaseBridge"

export {
  CONFIG_MESSAGE,
  FUNCTIONS_URL,
  GATEWAY_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isConfigured,
  isFirebaseConfigured,
  isSupabaseConfigured,
}

function stub() {
  const err = () => Promise.reject(new Error(CONFIG_MESSAGE))
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    upsert: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    is: () => chain,
    gt: () => chain,
    gte: () => chain,
    lt: () => chain,
    lte: () => chain,
    like: () => chain,
    ilike: () => chain,
    order: () => chain,
    limit: () => chain,
    range: () => chain,
    single: err,
    maybeSingle: err,
    then: (resolve) => resolve({ data: null, error: new Error(CONFIG_MESSAGE) }),
  }
  return {
    from: () => chain,
    rpc: err,
    functions: { invoke: err },
  }
}

export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        /* Firebase owns the durable session; GoTrue is not used at all. */
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      /* Third-party auth: every request asks the bridge for a fresh token and
         falls back to the publishable key for genuinely public reads
         (public_models, public_settings, route_health …). */
      accessToken: async () => (await getSupabaseAccessToken()) || SUPABASE_ANON_KEY,
      global: { headers: { "x-client-info": "ragestar-web/10.0.0" } },
    })
  : stub()

/** Turn any Supabase/Postgres error into something worth reading. */
export function niceError(error, fallback = "Something went wrong. Try again.") {
  if (!error) return fallback
  const raw = typeof error === "string" ? error : error.message || error.error_description || ""
  const map = {
    "Invalid login credentials": "That email and password combination is not recognised.",
    "User already registered": "An account with that email already exists. Sign in instead.",
    "Email rate limit exceeded": "Too many emails sent. Wait a minute and try again.",
    "Failed to fetch": "Cannot reach Supabase. Check the project URL and your connection.",
    "JWT expired":
      "Your session token expired before the request finished. Reload the page and try again.",
    "No API key found":
      "The request went out without the publishable key. Check VITE_SUPABASE_ANON_KEY in .env.",
    "invalid claim":
      "Supabase rejected the bridged token. Confirm JWT_SECRET on the firebase-auth function matches your project's JWT secret.",
  }
  for (const [needle, friendly] of Object.entries(map)) {
    if (raw.toLowerCase().includes(needle.toLowerCase())) return friendly
  }
  if (raw.includes("permission denied") || raw.includes("row-level security")) {
    return "You do not have access to that."
  }

  /* Postgres / PostgREST errors carry the useful part in code + details + hint,
     so keep them: "could not create the key" on its own is impossible to fix. */
  const code = typeof error === "string" ? "" : error.code || ""
  const extra =
    typeof error === "string"
      ? ""
      : [error.details, error.hint].filter(Boolean).join(" ").trim()

  /* missing function / missing table = the SQL upgrade has not been run yet */
  if (code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01") {
    return `${raw || "That database object does not exist yet."} Run the SQL upgrades in supabase/ (v5.4 → v10.0) in the Supabase SQL editor, then reload this page.`
  }

  const parts = [raw || fallback]
  if (extra && !raw.includes(extra)) parts.push(extra)
  if (code) parts.push(`[${code}]`)
  return parts.join(" · ")
}
