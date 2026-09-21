// ============================================================================
//  RageStar — admin account recovery (admin only)
// ----------------------------------------------------------------------------
//  POST {SUPABASE_URL}/functions/v1/admin-account
//  Authorization: Bearer <the signed-in admin's access token>
//  apikey:        <your publishable / anon key>
//
//  Actions:
//   { action: "security",  user_id }            -> credential facts, never the password
//   { action: "reset_link", user_id }           -> one-time recovery link to hand over
//   { action: "temp_password", user_id }        -> set + return a random temp password
//   { action: "signout_all", user_id }         -> end every live session now
//
//  WHY THERE IS NO "read_password" ACTION
//  --------------------------------------
//  Supabase Auth stores a bcrypt hash in auth.users.encrypted_password. Hashing
//  is one-way: the plaintext was never written down, so there is nothing to
//  read back — not via the admin API, not via SQL, not with the service role.
//  The only way to make passwords viewable would be to start saving them in
//  plaintext on signup, which turns one leaked admin session into a dump of
//  live credentials. This workspace is Gmail-only, so those are frequently the
//  user's actual Google password too.
//
//  "temp_password" is the safe equivalent: the admin sets a value they choose,
//  so they know it, hand it over, and the user changes it on next sign-in. The
//  old password is never revealed and never needs to be.
//
//  Deploy with JWT verification OFF — the admin check happens in here, and
//  platform JWT verification rejects the browser's CORS preflight with a
//  header-less 401 that surfaces as "Failed to fetch":
//
//      supabase functions deploy admin-account --no-verify-jwt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import {
  apiError,
  json,
  preflight,
  safeJsonParse,
  MAX_BODY_BYTES,
} from "../_shared/cors.ts"
import {
  AuthTokenError,
  requireAdmin as requireAdminCaller,
  resolveJwtSecret,
} from "../_shared/firebase.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SECRET_KEY") ??
  ""
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "")
/* v10: used to verify bridge-issued access tokens locally. Empty falls back to
   asking GoTrue, which keeps this function working on a pre-Firebase project. */
/* Read under every name the secret is stored as: a project that set it as
   SUPABASE_JWT_SECRET (or never set it at all) used to fall back to GoTrue,
   which always refuses bridge-minted tokens - that is what produced "Your
   session is not valid. Sign in again, then retry." on every admin action. */
const JWT_SECRET = resolveJwtSecret()
/* Lets the gate fall back to verifying the Firebase ID token itself. */
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? ""

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/* ------------------------------------------------------------------ helpers */

/** Readable-but-strong temp password: satisfies the app's own rules and has no
 *  ambiguous glyphs, because someone is going to read this over a call. */
function tempPassword() {
  const upper = "ABCDEFGHJKMNPQRSTVWXYZ"
  const lower = "abcdefghjkmnpqrstvwxyz"
  const digit = "23456789"
  const symbol = "!@#$%^&*?"
  const all = upper + lower + digit + symbol

  const pick = (set: string, n = 1) => {
    const bytes = new Uint32Array(n)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => set[b % set.length]).join("")
  }

  // guarantee one of each class, then fill, then shuffle
  const chars = (pick(upper, 2) + pick(lower, 6) + pick(digit, 3) + pick(symbol, 1) + pick(all, 4))
    .split("")
  for (let i = chars.length - 1; i > 0; i--) {
    const r = new Uint32Array(1)
    crypto.getRandomValues(r)
    const j = r[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join("")
}

/** Resolves the caller's token to a profile and refuses non-admins. */
/* v10: sessions are minted by the firebase-auth bridge, so they are signed
   with the project's JWT secret but have no row in auth.sessions. That makes
   admin.auth.getUser(token) unreliable here even though PostgREST and RLS
   accept the same token happily, so the shared helper verifies the signature
   itself and then applies the unchanged rule: profiles.role = 'admin' and an
   active status. The thrown shape is kept identical so every call site and
   error message below still behaves exactly as before. */
async function requireAdmin(req: Request) {
  try {
    const caller = await requireAdminCaller(req, admin as never, {
      jwtSecret: JWT_SECRET,
      firebaseProjectId: FIREBASE_PROJECT_ID,
    })
    return { id: caller.id, email: caller.email, via: caller.via ?? "" }
  } catch (err) {
    if (err instanceof AuthTokenError) {
      throw { status: err.status, message: err.message }
    }
    /* Never swallow the real reason: a blank "session is not valid" is what
       made this impossible to debug from the panel. */
    const detail = err instanceof Error && err.message ? ` ${err.message}` : ""
    throw {
      status: 401,
      message: `Could not confirm your admin session.${detail} Reload the admin panel and retry; if it persists, check: supabase functions logs admin-account`,
    }
  }
}

/** Writes the paper trail. Best effort: a logging failure must not hide the
 *  result of an action that already happened. */
async function logAction(actorToken: string, userId: string, action: string, detail: unknown) {
  try {
    const asAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { authorization: `Bearer ${actorToken}` } },
    })
    await asAdmin.rpc("admin_log_recovery", {
      p_user_id: userId,
      p_action: action,
      p_detail: detail ?? {},
    })
  } catch {
    /* audit write failed — the action itself still stands */
  }
}

/* --------------------------------------------------------------- the handler */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req)
  if (req.method !== "POST") return apiError("Use POST.", 405, "method_not_allowed", {}, req)

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return apiError(
      "This function is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.",
      500,
      "config_error",
      {},
      req,
    )
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return apiError("Request body too large.", 413, "payload_too_large", {}, req)
  }
  const body = safeJsonParse<Record<string, unknown>>(raw, {})
  const action = String(body.action ?? "").trim()
  const userId = String(body.user_id ?? "").trim()

  let actor: { id: string; email: string }
  try {
    actor = await requireAdmin(req)
  } catch (e) {
    const err = e as { status?: number; message?: string }
    return apiError(err.message ?? "Not authorised.", err.status ?? 401, "unauthorized", {}, req)
  }

  const authHeader = req.headers.get("authorization") ?? ""
  const actorToken = authHeader.slice(7).trim()

  if (action === "ping") {
    return json({ ok: true, actor: actor.email, verified_via: actor.via }, 200, {}, req)
  }

  // Every remaining action is explicitly *not* a password read. Be loud about
  // it rather than silently 400-ing, so the intent is obvious in the logs.
  if (action === "read_password" || action === "reveal_password" || action === "get_password") {
    return apiError(
      "Passwords cannot be read. Supabase stores a one-way bcrypt hash, so no plaintext exists to return — " +
        "not for an admin, not for the service role. Use action \"reset_link\" to send the user a one-time " +
        "link, or \"temp_password\" to set a password you choose and hand over.",
      400,
      "unsupported_by_design",
      {},
      req,
    )
  }

  if (!userId) return apiError("user_id is required.", 400, "invalid_request_error", {}, req)

  const { data: target } = await admin
    .from("profiles")
    .select("id,email,full_name,role")
    .eq("id", userId)
    .maybeSingle()

  if (!target) return apiError("That account does not exist.", 404, "not_found", {}, req)

  try {
    /* ------------------------------------------------------------ security */
    if (action === "security") {
      const { data, error } = await admin.auth.admin.getUserById(userId)
      if (error) throw error
      const u = data.user
      return json(
        {
          ok: true,
          email: u?.email ?? target.email,
          has_password: Boolean((u as { encrypted_password?: string })?.encrypted_password) || true,
          email_confirmed_at: u?.email_confirmed_at ?? null,
          last_sign_in_at: u?.last_sign_in_at ?? null,
          providers: u?.app_metadata?.providers ?? [],
          note: "Password values are hashed and cannot be displayed.",
        },
        200,
        {},
        req,
      )
    }

    /* ---------------------------------------------------------- reset link */
    if (action === "reset_link") {
      const redirectTo = `${SITE_URL || ""}/#/reset`
      const { data, error } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: target.email,
        options: SITE_URL ? { redirectTo } : undefined,
      })
      if (error) throw error

      await logAction(actorToken, userId, "password_reset_link", { method: "generateLink" })

      return json(
        {
          ok: true,
          email: target.email,
          link: data?.properties?.action_link ?? null,
          expires_in: "about 1 hour",
          note: "Hand this to the account owner over a channel you trust. It sets a new password — it does not reveal the old one.",
        },
        200,
        {},
        req,
      )
    }

    /* ------------------------------------------------------ temp password */
    if (action === "temp_password") {
      const supplied = String(body.password ?? "").trim()
      const password = supplied || tempPassword()

      if (supplied && supplied.length < 8) {
        return apiError("A password must be at least 8 characters.", 400, "weak_password", {}, req)
      }

      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) throw error

      // force them through a fresh sign-in with the new value
      try {
        await admin.auth.admin.signOut(userId, "global")
      } catch {
        /* older platform versions: the password change already invalidates */
      }

      await logAction(actorToken, userId, "temp_password", {
        generated: !supplied,
        sessions_ended: true,
      })

      return json(
        {
          ok: true,
          email: target.email,
          password,
          note: "Shown once. Give it to the account owner and have them change it on first sign-in.",
        },
        200,
        {},
        req,
      )
    }

    /* ----------------------------------------------------- sign out all */
    if (action === "signout_all") {
      const { error } = await admin.auth.admin.signOut(userId, "global")
      if (error) throw error
      await logAction(actorToken, userId, "force_signout", { scope: "global" })
      return json({ ok: true, email: target.email }, 200, {}, req)
    }

    return apiError(
      `Unknown action "${action}". Use security, reset_link, temp_password or signout_all.`,
      400,
      "invalid_request_error",
      {},
      req,
    )
  } catch (e) {
    const msg = (e as Error)?.message ?? "The admin API rejected that."
    return apiError(msg, 502, "upstream_error", {}, req)
  }
})
