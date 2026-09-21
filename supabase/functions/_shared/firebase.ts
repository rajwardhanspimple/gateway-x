// ============================================================================
//  RageStar - Firebase <-> Supabase token helpers (shared, no dependencies)
// ----------------------------------------------------------------------------
//  WebCrypto only. No imports, so this file works in every Edge Function
//  without pulling another remote module into the deploy.
//
//  verifyFirebaseIdToken()      validate a Firebase ID token (RS256 + JWKS)
//  mintSupabaseAccessToken()    issue a Supabase-signed JWT (HS256)
//  verifySupabaseAccessToken()  validate one locally, without GoTrue
//  bearerToken()                pull the token off an Authorization header
//  requireAdmin()               the admin gate used by the admin functions
//
//  WHY VERIFY LOCALLY
//  ------------------
//  Tokens minted here are signed with the project's JWT secret but have no row
//  in auth.sessions, so `auth.getUser(token)` can reject them even though
//  PostgREST and RLS accept them happily. Anything that needs to identify the
//  caller therefore verifies the signature itself.
// ============================================================================

export class AuthTokenError extends Error {
  code: string
  status: number
  constructor(message: string, code = "unauthorized", status = 401) {
    super(message)
    this.name = "AuthTokenError"
    this.code = code
    this.status = status
  }
}

/** Google's public signing keys for Firebase ID tokens, in JWK form. */
export const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/" +
  "securetoken@system.gserviceaccount.com"

export const FIREBASE_ALG = "RS256"

/** Tolerance for clock drift between Google, Supabase and the browser. */
export const CLOCK_SKEW_SEC = 60

/* ------------------------------------------------------- JWT secret lookup */

/**
 * Every name the project's JWT secret is stored under in the wild.
 *
 * Why this list exists: a function that cannot see the secret silently falls
 * back to GoTrue, GoTrue refuses bridge-minted tokens (they are signed with
 * the project secret but have no row in auth.sessions), and the browser is
 * told "Your session is not valid. Sign in again, then retry." on every admin
 * action, forever. Reading all the spellings makes that failure impossible.
 *
 * `supabase secrets set` REFUSES names beginning with SUPABASE_, so JWT_SECRET
 * is the one to set from the CLI. The other names are read for projects that
 * set them by hand in the dashboard.
 */
export const JWT_SECRET_ENV_NAMES = [
  "JWT_SECRET",
  "SUPABASE_JWT_SECRET",
  "SB_JWT_SECRET",
  "SUPABASE_AUTH_JWT_SECRET",
  "GOTRUE_JWT_SECRET",
  "LEGACY_JWT_SECRET",
]

export const MISSING_SECRET_MESSAGE =
  "This function cannot check your session because no JWT secret is set on it. " +
  "Copy Supabase → Project Settings → API → JWT Secret (legacy) and run: " +
  'supabase secrets set JWT_SECRET="<that value>" — then redeploy the functions.'

export const SECRET_MISMATCH_MESSAGE =
  "Your session was signed with a different JWT secret than this function has. " +
  "Make sure JWT_SECRET matches Project Settings → API → JWT Secret (legacy), " +
  "then redeploy firebase-auth and the admin functions and sign in again."

/** Reads an env var without needing Deno types, and never throws. */
function envValue(name: string): string {
  try {
    const runtime = (globalThis as {
      Deno?: { env?: { get?: (key: string) => string | undefined } }
    }).Deno
    return String(runtime?.env?.get?.(name) ?? "").trim()
  } catch {
    return ""
  }
}

/** Candidate JWT secrets: whatever the caller passed first, then the env. */
export function resolveJwtSecrets(extra: string | string[] = []): string[] {
  const out: string[] = []
  const push = (value: unknown) => {
    const text = String(value ?? "").trim()
    if (text && !out.includes(text)) out.push(text)
  }
  for (const value of Array.isArray(extra) ? extra : [extra]) push(value)
  for (const name of JWT_SECRET_ENV_NAMES) push(envValue(name))
  return out
}

/** The first usable JWT secret, or "" when none is configured. */
export function resolveJwtSecret(extra: string | string[] = []): string {
  return resolveJwtSecrets(extra)[0] ?? ""
}

export type FirebaseClaims = {
  sub: string
  aud: string
  iss: string
  iat: number
  exp: number
  auth_time?: number
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  firebase?: {
    sign_in_provider?: string
    identities?: Record<string, unknown>
  }
  [key: string]: unknown
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

function decodeSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment))) as T
  } catch {
    throw new AuthTokenError(`That sign-in token is malformed (${what}).`, "bad_token", 401)
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/* ------------------------------------------------------------- JWKS cache */

type Jwk = Record<string, unknown> & { kid?: string; alg?: string }

let jwksCache: { keys: Record<string, Jwk>; expiresAt: number } | null = null

async function fetchJwks(): Promise<Record<string, Jwk>> {
  const res = await fetch(JWKS_URL, { headers: { accept: "application/json" } })
  if (!res.ok) {
    throw new AuthTokenError(
      "Could not reach Google to verify your sign-in. Try again.",
      "jwks_unavailable",
      503,
    )
  }

  const body = (await res.json()) as { keys?: Jwk[] } | Record<string, string>
  const keys: Record<string, Jwk> = {}

  if (Array.isArray((body as { keys?: Jwk[] }).keys)) {
    for (const key of (body as { keys: Jwk[] }).keys) {
      if (key?.kid) keys[String(key.kid)] = key
    }
  }

  if (!Object.keys(keys).length) {
    throw new AuthTokenError(
      "Google returned no usable signing keys.",
      "jwks_unavailable",
      503,
    )
  }

  /* Honour Google's own cache window rather than inventing one, but never
     trust it blindly: clamp to 5 minutes .. 1 hour. */
  const cacheControl = res.headers.get("cache-control") ?? ""
  const maxAge = Number(/max-age=(\d+)/i.exec(cacheControl)?.[1] ?? "3600")
  const ttl = Math.min(3600, Math.max(300, Number.isFinite(maxAge) ? maxAge : 3600))

  jwksCache = { keys, expiresAt: nowSec() + ttl }
  return keys
}

async function signingKey(kid: string): Promise<CryptoKey> {
  let keys =
    jwksCache && jwksCache.expiresAt > nowSec() ? jwksCache.keys : await fetchJwks()

  /* Google rotates keys. An unknown kid means our cache is stale, so refresh
     once before deciding the token is bad. */
  if (!keys[kid]) {
    jwksCache = null
    keys = await fetchJwks()
  }

  const jwk = keys[kid]
  if (!jwk) {
    throw new AuthTokenError(
      "That sign-in token was signed with an unknown key. Sign in again.",
      "unknown_kid",
      401,
    )
  }

  return crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  )
}

/* ------------------------------------------------- verify firebase token */

/**
 * Verifies a Firebase ID token end to end: signature against Google's live
 * keys, then every claim that matters. Throws AuthTokenError on any failure.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<FirebaseClaims> {
  if (!projectId) {
    throw new AuthTokenError(
      "FIREBASE_PROJECT_ID is not set on this function. Run: supabase secrets set FIREBASE_PROJECT_ID=your-project",
      "not_configured",
      500,
    )
  }

  const parts = String(idToken || "").split(".")
  if (parts.length !== 3) {
    throw new AuthTokenError("That sign-in token is malformed.", "bad_token", 401)
  }

  const header = decodeSegment<{ alg?: string; kid?: string }>(parts[0], "header")
  if (header.alg !== FIREBASE_ALG) {
    /* Refusing anything but RS256 is what stops an "alg: none" or HS256 token
       forged with a public value from being accepted. */
    throw new AuthTokenError(
      "That sign-in token uses an unexpected algorithm.",
      "bad_alg",
      401,
    )
  }
  if (!header.kid) {
    throw new AuthTokenError("That sign-in token has no key id.", "bad_token", 401)
  }

  const key = await signingKey(header.kid)
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlToBytes(parts[2]),
    signed,
  )

  if (!valid) {
    throw new AuthTokenError(
      "That sign-in token failed signature verification.",
      "bad_signature",
      401,
    )
  }

  const claims = decodeSegment<FirebaseClaims>(parts[1], "payload")
  const now = nowSec()

  if (claims.aud !== projectId) {
    throw new AuthTokenError(
      "That sign-in token was issued for a different Firebase project.",
      "bad_audience",
      401,
    )
  }

  const expectedIssuer = "https://securetoken.google.com/" + projectId
  if (claims.iss !== expectedIssuer) {
    throw new AuthTokenError(
      "That sign-in token has an unexpected issuer.",
      "bad_issuer",
      401,
    )
  }

  if (!claims.sub || typeof claims.sub !== "string") {
    throw new AuthTokenError("That sign-in token has no subject.", "bad_token", 401)
  }

  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC < now) {
    throw new AuthTokenError(
      "Your sign-in has expired. Sign in again.",
      "token_expired",
      401,
    )
  }

  if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SEC > now) {
    throw new AuthTokenError(
      "That sign-in token is not valid yet - check your device clock.",
      "bad_issued_at",
      401,
    )
  }

  if (typeof claims.auth_time === "number" && claims.auth_time - CLOCK_SKEW_SEC > now) {
    throw new AuthTokenError(
      "That sign-in token has an impossible auth time.",
      "bad_auth_time",
      401,
    )
  }

  return claims
}

/* ------------------------------------------------------ mint supabase JWT */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

export type MintInput = {
  userId: string
  email: string
  secret: string
  issuer: string
  ttlSeconds?: number
  firebaseUid?: string
  signInProvider?: string
  userMetadata?: Record<string, unknown>
}

export type MintedToken = {
  access_token: string
  expires_in: number
  expires_at: number
}

/**
 * Issues a Supabase access token for an existing auth user.
 *
 * The claim set mirrors what GoTrue puts in its own tokens, because that is
 * what PostgREST, RLS (auth.uid(), auth.jwt()) and the Storage API read. The
 * only additions are app_metadata.provider = "firebase" and firebase_uid, so
 * a token's origin is visible if you ever need to audit it.
 */
export async function mintSupabaseAccessToken(input: MintInput): Promise<MintedToken> {
  const {
    userId,
    email,
    secret,
    issuer,
    ttlSeconds = 3600,
    firebaseUid = "",
    signInProvider = "password",
    userMetadata = {},
  } = input

  if (!userId) throw new AuthTokenError("Cannot mint a token without a user id.", "bad_request", 500)
  if (!secret) {
    throw new AuthTokenError(
      "JWT_SECRET is not set on this function.",
      "not_configured",
      500,
    )
  }

  /* Short lifetimes only: the browser refreshes through Firebase, so there is
     no reason to hand out a long-lived database token. */
  const ttl = Math.min(3600, Math.max(300, Math.floor(ttlSeconds)))
  const iat = nowSec()
  const exp = iat + ttl

  const payload = {
    aud: "authenticated",
    role: "authenticated",
    iss: issuer,
    sub: userId,
    email,
    phone: "",
    iat,
    exp,
    session_id: crypto.randomUUID(),
    is_anonymous: false,
    app_metadata: {
      provider: "firebase",
      providers: ["firebase"],
      firebase_uid: firebaseUid,
      firebase_sign_in_provider: signInProvider,
    },
    user_metadata: { email, ...userMetadata },
    amr: [{ method: signInProvider, timestamp: iat }],
  }

  const head = textToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = textToB64url(JSON.stringify(payload))
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  )

  return {
    access_token: `${head}.${body}.${bytesToB64url(new Uint8Array(signature))}`,
    expires_in: ttl,
    expires_at: exp,
  }
}

/* -------------------------------------------------- verify supabase JWT */

export type SupabaseClaims = {
  sub: string
  email?: string
  role?: string
  aud?: string
  exp?: number
  app_metadata?: Record<string, unknown>
  [key: string]: unknown
}

/** Validates a Supabase-signed access token without calling GoTrue. */
export async function verifySupabaseAccessToken(
  token: string,
  secret: string | string[] = [],
): Promise<SupabaseClaims> {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) {
    throw new AuthTokenError("Your session is not valid. Sign in again.", "bad_token", 401)
  }

  const header = decodeSegment<{ alg?: string }>(parts[0], "header")
  if (header.alg !== "HS256") {
    throw new AuthTokenError("Your session token is not supported.", "bad_alg", 401)
  }

  /* Try every configured secret. A project that rotated its JWT secret, or
     that stored it under another name, would otherwise reject sessions that
     PostgREST and RLS still accept. */
  const candidates = resolveJwtSecrets(secret)
  if (!candidates.length) {
    throw new AuthTokenError(MISSING_SECRET_MESSAGE, "not_configured", 500)
  }

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  let valid = false
  for (const candidate of candidates) {
    const key = await hmacKey(candidate)
    if (await crypto.subtle.verify("HMAC", key, b64urlToBytes(parts[2]), signed)) {
      valid = true
      break
    }
  }

  if (!valid) {
    throw new AuthTokenError(SECRET_MISMATCH_MESSAGE, "secret_mismatch", 401)
  }

  const claims = decodeSegment<SupabaseClaims>(parts[1], "payload")
  const now = nowSec()

  if (typeof claims.exp === "number" && claims.exp + CLOCK_SKEW_SEC < now) {
    throw new AuthTokenError("Your session expired. Sign in again.", "token_expired", 401)
  }
  if (claims.aud && claims.aud !== "authenticated") {
    throw new AuthTokenError("Your session is not valid. Sign in again.", "bad_audience", 401)
  }
  if (!claims.sub) {
    throw new AuthTokenError("Your session is not valid. Sign in again.", "bad_token", 401)
  }

  return claims
}

/* ------------------------------------------------------------ admin gate */

/** Pulls the bearer token out of an Authorization header. */
export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? ""
  return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : ""
}

/**
 * The Firebase ID token the browser now sends next to the Supabase one, so the
 * admin gate can still identify the caller when the Supabase JWT secret is
 * missing, was rotated, or was never set on this function.
 */
export function firebaseIdTokenHeader(req: Request): string {
  return (
    req.headers.get("x-firebase-token") ??
    req.headers.get("x-firebase-id-token") ??
    ""
  ).trim()
}

/** RS256 header = signed by Google; HS256 = minted by the bridge. */
function isFirebaseShapedToken(token: string): boolean {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return false
  try {
    return decodeSegment<{ alg?: string }>(parts[0], "header").alg === FIREBASE_ALG
  } catch {
    return false
  }
}

export type AdminCaller = {
  id: string
  email: string
  role: string
  /** Which credential proved it: "supabase" | "firebase" | "gotrue". */
  via?: string
}

type AdminProfileRow = {
  id: string
  email: string | null
  role: string | null
  status: string | null
}

/* Deliberately loose. The only real requirement is a service-role client. */
type AdminClient = {
  auth: {
    getUser: (
      token: string,
    ) => Promise<{ data: { user: { id: string } | null } | null; error: unknown }>
  }
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any
}

export type RequireAdminOptions = {
  /** Extra JWT secret(s) to try before the ones found in the environment. */
  jwtSecret?: string | string[]
  /** Needed for the Firebase ID token fallback. Defaults to the env var. */
  firebaseProjectId?: string
}

async function lookupProfile(
  admin: AdminClient,
  column: string,
  value: string,
): Promise<AdminProfileRow | null> {
  if (!value) return null
  try {
    const { data } = await admin
      .from("profiles")
      .select("id,email,role,status")
      .eq(column, value)
      .maybeSingle()
    return (data as AdminProfileRow) ?? null
  } catch {
    /* older schema without profiles.firebase_uid — just try the next lookup */
    return null
  }
}

/**
 * The shared admin gate.
 *
 * Three ways to prove who is calling, tried in order, so a single missing
 * secret can no longer lock an admin out of their own panel:
 *
 *   1. the Supabase access token minted by firebase-auth, verified locally
 *      against every known JWT secret (these tokens have no auth.sessions row,
 *      so admin.auth.getUser() cannot be trusted to validate them);
 *   2. the raw Firebase ID token from the x-firebase-token header, verified
 *      against Google's public keys and mapped through profiles.firebase_uid
 *      (or the email) — this needs no Supabase secret at all;
 *   3. a real GoTrue session, for a project still on Supabase Auth.
 *
 * The decision itself is unchanged: profiles.role = 'admin' AND an active
 * status, exactly what public.is_admin() enforces on the database side.
 * Failures now say which step failed and what to fix.
 */
export async function requireAdmin(
  req: Request,
  admin: AdminClient,
  options: string | string[] | RequireAdminOptions = {},
): Promise<AdminCaller> {
  const opts: RequireAdminOptions =
    typeof options === "string" || Array.isArray(options)
      ? { jwtSecret: options }
      : options ?? {}

  const bearer = bearerToken(req)
  const firebase = firebaseIdTokenHeader(req)

  if (!bearer && !firebase) {
    throw new AuthTokenError("Sign in required.", "unauthorized", 401)
  }

  const secrets = resolveJwtSecrets(opts.jwtSecret ?? [])
  const projectId = String(
    opts.firebaseProjectId ?? envValue("FIREBASE_PROJECT_ID"),
  ).trim()

  let row: AdminProfileRow | null = null
  let via = ""
  let expired: AuthTokenError | null = null
  let missingSecret = false
  const problems: string[] = []

  const note = (err: unknown) => {
    if (err instanceof AuthTokenError) {
      if (err.code === "token_expired") expired = err
      if (err.code === "not_configured") missingSecret = true
      problems.push(err.message)
    } else if (err instanceof Error && err.message) {
      problems.push(err.message)
    }
  }

  /* 1 — the Supabase-signed session token */
  if (bearer && !isFirebaseShapedToken(bearer)) {
    if (secrets.length) {
      try {
        const claims = await verifySupabaseAccessToken(bearer, secrets)
        via = "supabase"
        row = await lookupProfile(admin, "id", claims.sub)
      } catch (err) {
        note(err)
      }
    } else {
      missingSecret = true
      problems.push(MISSING_SECRET_MESSAGE)
    }
  }

  /* 2 — the Firebase ID token, straight from Google */
  if (!row && !via) {
    const candidate = firebase || (isFirebaseShapedToken(bearer) ? bearer : "")
    if (candidate && projectId) {
      try {
        const claims = await verifyFirebaseIdToken(candidate, projectId)
        via = "firebase"
        row =
          (await lookupProfile(admin, "firebase_uid", claims.sub)) ??
          (await lookupProfile(admin, "email", String(claims.email ?? "").toLowerCase()))
      } catch (err) {
        note(err)
      }
    } else if (candidate && !projectId) {
      problems.push(
        "FIREBASE_PROJECT_ID is not set on this function, so your Firebase sign-in could not be checked. " +
          'Run: supabase secrets set FIREBASE_PROJECT_ID="<your firebase project id>"',
      )
    }
  }

  /* 3 — a classic GoTrue session */
  if (!row && !via && bearer) {
    try {
      const { data, error } = await admin.auth.getUser(bearer)
      if (!error && data?.user?.id) {
        via = "gotrue"
        row = await lookupProfile(admin, "id", data.user.id)
      }
    } catch {
      /* covered by the error below */
    }
  }

  if (!row) {
    if (via) {
      throw new AuthTokenError(
        "Your sign-in is valid, but no row in public.profiles matches it, so your role cannot be confirmed. " +
          "Run supabase/upgrade-v7.1-admin-access.sql (with your email in it) in the SQL editor.",
        "no_profile",
        403,
      )
    }
    if (expired) throw expired
    if (missingSecret) {
      throw new AuthTokenError(MISSING_SECRET_MESSAGE, "not_configured", 500)
    }
    throw new AuthTokenError(
      problems.length
        ? `Could not confirm your session. ${problems.join(" ")}`
        : "Your session is not valid. Sign in again, then retry.",
      "unauthorized",
      401,
    )
  }

  if (row.role !== "admin") {
    throw new AuthTokenError(
      `Admin only — ${row.email ?? "this account"} has role "${row.role ?? "user"}". ` +
        "Promote it with supabase/upgrade-v7.1-admin-access.sql.",
      "forbidden",
      403,
    )
  }
  if (row.status && row.status !== "active") {
    throw new AuthTokenError(
      `Your admin account is "${row.status}", not active, so every admin policy will refuse it.`,
      "suspended",
      403,
    )
  }

  return { id: row.id, email: row.email ?? "", role: row.role, via }
}
