// ============================================================================
//  Shared CORS + helpers for every RageStar Edge Function
// ----------------------------------------------------------------------------
//  "Failed to fetch" in the browser is almost always a CORS problem, not a
//  logic problem: if a response (or a rejected preflight) comes back without
//  the Access-Control-* headers, the browser throws the request away before
//  your JavaScript ever sees a status code.
//
//  So: every response, including errors and OPTIONS preflights, must carry
//  these headers. Use `corsHeaders(req)` / `json(...)` / `apiError(...)` and
//  never construct a bare `new Response()` in a function handler.
// ============================================================================

const ALLOWED_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "accept",
  "accept-profile",
  "content-profile",
  "prefer",
  "x-client-info",
  "x-supabase-api-version",
  "x-requested-with",
  "x-rs-policy",
  /* the browser sends its Firebase ID token next to the Supabase one so the
     admin gate can still identify the caller if the JWT secret is missing */
  "x-firebase-token",
  "x-firebase-id-token",
  /* injected by the Cloudflare Worker in front of gw.ragestar.bond so the
     gateway can tell edge traffic from someone calling *.supabase.co direct */
  "x-rs-edge-secret",
  /* the real caller address, also injected by that Worker. Needs its own
     header because Cloudflare OVERWRITES cf-connecting-ip on a
     Cloudflare -> Cloudflare subrequest, and *.supabase.co is behind
     Cloudflare. See clientIpOf() below. */
  "x-rs-client-ip",
].join(", ")

const EXPOSED_HEADERS = [
  "x-rs-model",
  "x-rs-policy",
  "x-rs-failover",
  "x-rs-latency-ms",
  "x-rs-cost-usd",
  "x-rs-tokens-in",
  "x-rs-tokens-out",
  "x-rs-credits-usd",
  "x-rs-credits-remaining",
  "x-rs-request-id",
  "retry-after",
  "content-type",
].join(", ")

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": EXPOSED_HEADERS,
  "Access-Control-Max-Age": "86400",
  Vary: "Origin, Access-Control-Request-Headers",
}

/**
 * CORS headers for one specific request. Mirrors the caller's Origin and the
 * exact header list it asked about during preflight, which keeps strict
 * browsers from rejecting the response.
 */
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)


export function corsHeaders(req?: Request): Record<string, string> {
  const origin = (req?.headers.get("origin") ?? "").trim()

  /* The public gateway is designed to be called from anywhere, so "*" stays
     the default. Set the ALLOWED_ORIGINS secret (comma separated) to lock the
     admin endpoints to your own dashboard origins:
       supabase secrets set ALLOWED_ORIGINS="https://app.example.com" */
  let allowOrigin = "*"
  if (ALLOWED_ORIGINS.length) {
    allowOrigin = ALLOWED_ORIGINS.some((o) => o.toLowerCase() === origin.toLowerCase())
      ? origin
      : ALLOWED_ORIGINS[0]
  }

  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": allowOrigin,
    /* Never echo access-control-request-headers back. Reflecting whatever the
       caller asks for lets a hostile page negotiate headers we do not expect. */
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
}

/* ---------------------------------------------------------------- client IP */

/**
 * The address of the caller, for the per-IP rate limit, the key-sharing guard,
 * the abuse report and the auto-ban list.
 *
 * THE BUG THIS EXISTS TO FIX. Every request from every user was being logged
 * with ONE identical address (2a06:98c0:3600::103): 2,452 requests, 37 distinct
 * keys, 20 distinct users, one client_ip. Because the origin is *.supabase.co,
 * which is itself behind Cloudflare, the hop from the Worker to the function is
 * a Cloudflare -> Cloudflare subrequest, and on that hop Cloudflare OVERWRITES
 * cf-connecting-ip with the Worker's own address. The Worker set the correct
 * value and Cloudflare discarded it. Reading cf-connecting-ip first therefore
 * returned Cloudflare's address every time.
 *
 * That was not cosmetic. It silently broke four things: the per-IP rate limit
 * counted all users in one bucket, so one busy caller throttled everyone; the
 * auto-ban list would have banned the shared address and locked out the whole
 * gateway at once; the key-sharing guard always saw exactly 1 distinct IP per
 * key and so could never fire; and every per-key IP allowlist became
 * meaningless.
 *
 * ORDER OF TRUST, most to least:
 *
 *   1. x-rs-client-ip   set by cloudflare/worker.js under a name Cloudflare has
 *                       no opinion about, so it survives the hop. Trusted ONLY
 *                       when x-rs-edge-secret matches, which proves the header
 *                       came from our Worker and not from a client hitting
 *                       *.supabase.co directly and inventing its own address.
 *   2. cf-connecting-ip correct when the origin is NOT behind Cloudflare, and
 *                       the only option when no edge secret is configured.
 *   3. x-forwarded-for  first hop, for any other reverse proxy.
 *   4. x-real-ip        nginx and friends.
 *
 * `fromEdge` is passed in rather than read here so this module stays free of
 * the RS_EDGE_SECRET environment variable and each function keeps ownership of
 * its own trust decision.
 *
 * Returns a bare address string for the request_logs.client_ip inet column, or
 * null when nothing trustworthy is present.
 */
export function resolveClientIp(
  req: Request,
  opts: { fromEdge: boolean; hasEdgeSecret: boolean },
): string | null {
  /* 1. our own Worker, proven by the shared secret */
  if (opts.fromEdge) {
    const edge = (req.headers.get("x-rs-client-ip") ?? "").trim()
    if (edge) return edge
  }

  /* 2. Cloudflare's own header. Only trustworthy when the request came through
        our edge, or when no secret is configured at all and there is nothing
        better to go on. */
  const cf = (req.headers.get("cf-connecting-ip") ?? "").trim()
  if (cf && (opts.fromEdge || !opts.hasEdgeSecret)) return cf

  /* 3. any other reverse proxy: the client is the first entry */
  const xff = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (xff.length) return xff[0]

  /* 4. nginx-style */
  const real = (req.headers.get("x-real-ip") ?? "").trim()
  return real || null
}

/* ---------------------------------------------------------------- SSRF guard */

const BLOCKED_HOST =
  /^(localhost|0\.0\.0\.0|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i

/**
 * Upstream endpoints are operator-supplied strings. Without this check a
 * hostile or mistyped base_url turns the gateway into a proxy for the Supabase
 * internal network or a cloud metadata service (169.254.169.254).
 */
export function assertPublicHttpsUrl(raw: string, label = "base_url"): URL {
  let url: URL
  try {
    url = new URL(String(raw ?? "").trim())
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use https://`)
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`)
  const host = url.hostname.toLowerCase()
  if (
    BLOCKED_HOST.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal"
  ) {
    throw new Error(`${label} points at a private or loopback host (${host})`)
  }
  return url
}


/** JSON.parse that cannot throw and cannot pollute Object.prototype. */
export function safeJsonParse<T>(text: unknown, fallback: T): T {
  const raw = typeof text === "string" ? text.trim() : ""
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw, (key, value) =>
      key === "__proto__" || key === "constructor" || key === "prototype" ? undefined : value,
    )
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

/** Hard cap on request bodies, so one call cannot exhaust function memory.
 *
 * Was 256 KB, which rejected any prompt carrying a document or an inline file —
 * a 300 KB text dump or a base64 attachment never reached a model. It is now
 * 64 MB by default, and `MAX_BODY_BYTES` (bytes) can be set per function to
 * change it without editing this file.
 *
 * It cannot be literally unlimited. Every handler buffers the whole body in
 * memory with `await req.text()`, and the hosting platform enforces its own
 * request ceiling before the function is invoked at all — so this check is the
 * gateway's own guard, not the only one in the path. Setting it very high
 * trades a clean 413 for an out-of-memory failure, which is why the default is
 * large but still finite. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

function configuredMaxBodyBytes(): number {
  const raw = Deno.env.get("MAX_BODY_BYTES");
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BODY_BYTES;
}

export const MAX_BODY_BYTES = configuredMaxBodyBytes();

/** The cap as a short label, so error text can never quote a stale number. */
export function bodyLimitLabel(): string {
  const mb = MAX_BODY_BYTES / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  return `${Math.round(MAX_BODY_BYTES / 1024)} KB`;
}


/** How much of ONE side of a call (the request body, or the response text) the
 *  gateway is willing to store in public.request_payloads.
 *
 *  Until v12.15 the request log held metadata only. Storing the conversation
 *  itself is unbounded data: a 64 MB body — which MAX_BODY_BYTES deliberately
 *  allows — would be copied into a second table on every single call. So each
 *  side is clamped here, before it ever crosses the RPC, and
 *  `MAX_STORED_PAYLOAD_BYTES` (bytes, per side) can be set per function to
 *  change the default without editing this file:
 *
 *    supabase secrets set MAX_STORED_PAYLOAD_BYTES=1048576
 *
 *  It is intentionally far smaller than the body cap: this is an audit trail,
 *  not a backup. A clamped row still records the ORIGINAL byte count and sets
 *  truncated = true, so what was dropped is visible rather than silent. */
const DEFAULT_MAX_STORED_PAYLOAD_BYTES = 256 * 1024;

function configuredMaxStoredPayloadBytes(): number {
  const raw = Deno.env.get("MAX_STORED_PAYLOAD_BYTES");
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_STORED_PAYLOAD_BYTES;
}

export const MAX_STORED_PAYLOAD_BYTES = configuredMaxStoredPayloadBytes();

/** One clamped side of a call, as the router hands it to internal_log_request. */
export type StoredPayload = {
  text: string;
  /* Always the original size in bytes, even when `text` was cut. */
  bytes: number;
  truncated: boolean;
};

/**
 * Clamp one side of a call to MAX_STORED_PAYLOAD_BYTES.
 *
 * The cut happens on the ENCODED bytes, not on the string length, so a prompt
 * full of multi-byte characters is trimmed to a real 256 KB boundary instead of
 * a character count that means something else — and the trailing partial
 * character a byte-slice can leave behind is dropped by TextDecoder rather than
 * stored as a broken code point.
 */
export function clampStoredPayload(text: string | null | undefined): StoredPayload {
  const raw = typeof text === "string" ? text : "";
  const encoded = new TextEncoder().encode(raw);
  if (encoded.length <= MAX_STORED_PAYLOAD_BYTES) {
    return { text: raw, bytes: encoded.length, truncated: false };
  }
  const cut = encoded.slice(0, MAX_STORED_PAYLOAD_BYTES);
  return { text: new TextDecoder().decode(cut), bytes: encoded.length, truncated: true };
}


/**
 * Answer for an OPTIONS preflight. Must be 2xx with the CORS headers.
 *
 * Returns `null` for every other method, so the guard style used by the
 * handlers
 *
 *     const pre = preflight(req)
 *     if (pre) return pre
 *
 * short-circuits the preflight ONLY.
 *
 * This used to return a 204 unconditionally, which meant a real POST was also
 * answered with an empty 204: the browser saw `res.ok === true` with no body,
 * so firebase-auth looked like it had "replied without a session" and sign-in
 * failed no matter how many times the function was redeployed.
 */
export function preflight(req: Request): Response | null {
  if ((req.method ?? "").toUpperCase() !== "OPTIONS") return null
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}

export function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
  req?: Request,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json", ...extra },
  })
}

/** OpenAI-shaped error so standard SDKs parse it correctly. */
export function apiError(
  message: string,
  status = 400,
  code = "invalid_request_error",
  extra: Record<string, string> = {},
  req?: Request,
) {
  return json({ error: { message, type: code, code, param: null } }, status, extra, req)
}

export function requestId() {
  return "req_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

/** sha256 hex — must match encode(digest(key,'sha256'),'hex') in Postgres. */
export async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Strip secrets out of anything we echo back to the browser. */
export function scrubSecrets(text: string, secrets: Array<string | null | undefined>) {
  let out = text ?? ""
  for (const s of secrets) {
    if (s && s.length > 6) out = out.split(s).join("[redacted]")
  }
  return out
}
