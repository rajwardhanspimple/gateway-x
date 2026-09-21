// ============================================================================
//  firebase-auth - the only new piece of server-side auth in v10
// ----------------------------------------------------------------------------
//  The browser signs in with Firebase, gets a Firebase ID token, and posts it
//  here. This function verifies it against Google's public keys, finds (or
//  creates) the matching row in auth.users, and mints a short-lived
//  Supabase-signed access token for it.
//
//  Everything downstream is untouched: RLS still reads auth.uid(), the router
//  still checks profiles, the admin functions still gate on role = 'admin'.
//  No data is migrated - this only replaces the thing that issues sessions.
//
//  Deploy without JWT verification, because callers have no Supabase token yet:
//    supabase functions deploy firebase-auth --no-verify-jwt
//
//  Required secrets:
//    FIREBASE_PROJECT_ID   your Firebase project id
//    JWT_SECRET   Project Settings -> API -> JWT Secret (legacy)
//  Optional:
//    FIREBASE_REQUIRE_VERIFIED_EMAIL  "false" to allow unverified email (default true)
//    SESSION_TTL_SECONDS             access token lifetime, 300..3600 (default 3600)
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
  mintSupabaseAccessToken,
  resolveJwtSecret,
  verifyFirebaseIdToken,
} from "../_shared/firebase.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""
/* JWT_SECRET is the name to use, but SUPABASE_JWT_SECRET and friends are
   read too so the bridge and the admin gate can never disagree. */
const JWT_SECRET = resolveJwtSecret()
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? ""
const REQUIRE_VERIFIED =
  (Deno.env.get("FIREBASE_REQUIRE_VERIFIED_EMAIL") ?? "true").toLowerCase() !== "false"
const TTL = Number(Deno.env.get("SESSION_TTL_SECONDS") ?? "3600")

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type ProfileRow = {
  id: string
  email: string | null
  full_name: string | null
  org: string | null
  role: string | null
  status: string | null
  firebase_uid: string | null
}

function clean(value: unknown, max = 200): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max)
}

function referral(value: unknown): string {
  const code = clean(value, 12).toUpperCase()
  return /^[0-9A-Z]{4,12}$/.test(code) ? code : ""
}

/* --------------------------------------------------------- domain allowlist */

/**
 * The database is the real gate (enforce_allowed_email on auth.users), but
 * checking here too means a blocked address gets a clear message instead of a
 * trigger error. Written defensively: if app_settings has no such column, the
 * check is skipped rather than locking everyone out.
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

/* ------------------------------------------------------------ user lookup */

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

type Resolved = { id: string; profile: ProfileRow | null; created: boolean }

/**
 * Maps a Firebase account onto a Supabase auth user, in three steps:
 *   1. already linked        -> profiles.firebase_uid matches
 *   2. existing account      -> same email, so link it (this is what makes
 *                               every pre-Firebase account keep working)
 *   3. brand new             -> create the auth user; handle_new_user() fills
 *                               in the profile row exactly as before
 */
async function resolveUser(
  firebaseUid: string,
  email: string,
  fullName: string,
  org: string,
  avatar: string,
  refCode: string,
): Promise<Resolved> {
  const cols = "id,email,full_name,org,role,status,firebase_uid"

  const linked = await admin.from("profiles").select(cols).eq("firebase_uid", firebaseUid).maybeSingle()
  if (linked.data) {
    return { id: (linked.data as ProfileRow).id, profile: linked.data as ProfileRow, created: false }
  }

  const byEmail = await admin.from("profiles").select(cols).eq("email", email).maybeSingle()
  if (byEmail.data) {
    const row = byEmail.data as ProfileRow
    await admin.from("profiles").update({ firebase_uid: firebaseUid }).eq("id", row.id)
    return { id: row.id, profile: { ...row, firebase_uid: firebaseUid }, created: false }
  }

  /* A profile row can be missing even though the auth user exists (a failed
     signup, a manually deleted row). Check auth.users before creating. */
  const existingAuthId = await findAuthUserByEmail(email)
  if (existingAuthId) {
    await admin.from("profiles").update({ firebase_uid: firebaseUid }).eq("id", existingAuthId)
    const after = await admin.from("profiles").select(cols).eq("id", existingAuthId).maybeSingle()
    return { id: existingAuthId, profile: (after.data as ProfileRow) ?? null, created: false }
  }

  const { data: made, error: makeError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true, // Firebase already verified it
    user_metadata: {
      full_name: fullName,
      org,
      avatar_url: avatar,
      firebase_uid: firebaseUid,
      referral_code: refCode,
    },
  })

  if (makeError || !made?.user?.id) {
    throw new AuthTokenError(
      makeError?.message || "Could not create your account. Try again.",
      "create_failed",
      400,
    )
  }

  await admin.from("profiles").update({ firebase_uid: firebaseUid }).eq("id", made.user.id)
  const fresh = await admin.from("profiles").select(cols).eq("id", made.user.id).maybeSingle()

  return { id: made.user.id, profile: (fresh.data as ProfileRow) ?? null, created: true }
}

/* ------------------------------------------------------------------ serve */

Deno.serve(async (req: Request) => {
  /* Preflight ONLY. Every other method must fall through to the real handler:
     answering a POST with an empty 204 is what made the browser report
     "the auth bridge replied without a session". */
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

  if (!JWT_SECRET) {
    return apiError(
      "JWT_SECRET is not set on this function. Copy Project Settings -> API -> JWT Secret (legacy) and run: " +
        'supabase secrets set JWT_SECRET="<that value>"' +
        " then redeploy: supabase functions deploy firebase-auth --no-verify-jwt",
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
  /* Google ID tokens are usually ~1 KB but grow with custom claims. Cutting
     one short silently breaks signature verification, so keep the cap well
     above any real token. */
  const idToken = clean(body.id_token ?? body.idToken, 8192)

  if (!idToken) {
    return apiError("Missing id_token.", 400, "invalid_request_error", {}, req)
  }

  try {
    const claims = await verifyFirebaseIdToken(idToken, FIREBASE_PROJECT_ID)

    const email = clean(claims.email, 254).toLowerCase()
    if (!email) {
      return apiError(
        "That sign-in method did not provide an email address, so no account can be linked to it.",
        400,
        "no_email",
        {},
        req,
      )
    }

    if (REQUIRE_VERIFIED && claims.email_verified !== true) {
      return apiError(
        "Confirm your email address first, then sign in again.",
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

    const provider = clean(claims.firebase?.sign_in_provider, 40) || "password"
    const { id, profile, created } = await resolveUser(
      claims.sub,
      email,
      clean(claims.name ?? body.full_name, 120),
      clean(body.org, 120),
      clean(claims.picture, 400),
      /* the browser sends `referral_code`; `referral` is accepted too */
      referral(body.referral ?? body.referral_code),
    )

    if (profile?.status && profile.status !== "active") {
      return apiError(
        "This account is suspended. Contact support if you think that is wrong.",
        403,
        "suspended",
        {},
        req,
      )
    }

    const minted = await mintSupabaseAccessToken({
      userId: id,
      email,
      secret: JWT_SECRET,
      issuer: SUPABASE_URL + "/auth/v1",
      ttlSeconds: TTL,
      firebaseUid: claims.sub,
      signInProvider: provider,
      userMetadata: {
        full_name: profile?.full_name ?? clean(claims.name, 120),
        avatar_url: clean(claims.picture, 400),
        firebase_uid: claims.sub,
      },
    })

    return json(
      {
        access_token: minted.access_token,
        token_type: "bearer",
        expires_in: minted.expires_in,
        expires_at: minted.expires_at,
        created,
        user: {
          id,
          email,
          full_name: profile?.full_name ?? "",
          org: profile?.org ?? "",
          role: profile?.role ?? "user",
          status: profile?.status ?? "active",
          firebase_uid: claims.sub,
        },
      },
      200,
      { "x-request-id": rid },
      req,
    )
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return apiError(err.message, err.status, err.code, { "x-request-id": rid }, req)
    }
    console.error("firebase-auth failed", rid, err)
    return apiError(
      "Could not complete sign-in. Try again.",
      500,
      "bridge_error",
      { "x-request-id": rid },
      req,
    )
  }
})
