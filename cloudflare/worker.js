// ============================================================================
//  RageStar edge proxy  —  gw.ragestar.bond  ->  Supabase Edge Function "router"
// ----------------------------------------------------------------------------
//  This is a reverse proxy, NOT a redirect. The caller talks only to
//  gw.ragestar.bond; we fetch from Supabase server-side and stream the answer
//  back. The Supabase URL, the Authorization header and SSE streams all
//  survive the hop (a 3xx redirect would leak the URL and some HTTP clients
//  drop Authorization across hosts).
//
//    https://gw.ragestar.bond/v1/chat/completions
//      -> https://<project>.supabase.co/functions/v1/router/v1/chat/completions
//
//  supabase/functions/router/index.ts already strips the
//  "/functions/v1/router" prefix, so no gateway code changes are needed.
// ============================================================================

const ORIGIN = "https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router"

// Never let a response to an authenticated API call be cached or reused.
const STRIP_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"]

export default {
  
async fetch(request, env) {
    const url = new URL(request.url)

    // bare hostname -> the gateway's health probe
    const path = url.pathname === "/" ? "/health" : url.pathname
    const target = ORIGIN + path + url.search

    // The address Cloudflare observed. Trustworthy: Cloudflare overwrites this
    // on every inbound request, a client cannot forge it.
    const clientIp = request.headers.get("cf-connecting-ip") ?? ""

    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("cf-ray")
    headers.delete("cf-visitor")
    headers.delete("accept-encoding") // let the origin answer uncompressed so SSE streams cleanly

    // ---- the real caller address ------------------------------------------
    //
    // THE TRAP THIS CODE USED TO FALL INTO. The origin is *.supabase.co, which
    // is itself behind Cloudflare, so this is a Cloudflare -> Cloudflare
    // subrequest. On that hop Cloudflare OVERWRITES cf-connecting-ip with the
    // address of this Worker, so the value set below is discarded before the
    // router ever sees it. x-forwarded-for was added as the workaround, but the
    // router reads cf-connecting-ip FIRST, so it always won with Cloudflare's
    // own address. Result: every request from every user logged one identical
    // IP (2a06:98c0:3600::103), which silently broke the per-IP rate limit (all
    // users sharing one bucket), the key-sharing guard (always 1 distinct IP),
    // every per-key IP allowlist, and the auto-ban list — which at 3x the limit
    // would have banned the shared address and locked out the whole gateway.
    //
    // x-rs-client-ip is a name Cloudflare has no opinion about, so it survives
    // the hop intact. Deleted first so an inbound client cannot smuggle a value
    // through: only what this Worker sets is ever forwarded.
    //
    // The router trusts x-rs-client-ip ONLY when x-rs-edge-secret matches,
    // which proves the header came from here and not from a client hitting
    // *.supabase.co directly. That means RS_EDGE_SECRET must be set on BOTH
    // sides for this to take effect — see the note below.
    headers.delete("x-rs-client-ip")
    if (clientIp) headers.set("x-rs-client-ip", clientIp)

    // Kept for origins that are not behind Cloudflare, and as a fallback the
    // router still reads after cf-connecting-ip.
    headers.set("cf-connecting-ip", clientIp)
    headers.set("x-forwarded-for", clientIp)

    // Proof this request came through your edge. Pair with
    // RS_REQUIRE_EDGE_SECRET=true on the gateway to shut the *.supabase.co door.
    //
    // REQUIRED for the IP fix above: without a shared secret the router cannot
    // tell this Worker's x-rs-client-ip from a client-forged one, so it falls
    // back to cf-connecting-ip and the shared-IP bug returns. Set it with:
    //   wrangler secret put RS_EDGE_SECRET
    //   supabase secrets set RS_EDGE_SECRET="<the same value>"
    if (env.RS_EDGE_SECRET) headers.set("x-rs-edge-secret", env.RS_EDGE_SECRET)

    let res
    try {
      res = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      })
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: {
            message: "The gateway is unreachable right now. Try again shortly.",
            type: "upstream_unreachable",
            code: "edge_fetch_failed",
          },
        }),
        { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } },
      )
    }

    const out = new Headers(res.headers)
    for (const h of STRIP_RESPONSE_HEADERS) out.delete(h)
    out.set("cache-control", "no-store")

    // body is a stream: token-by-token SSE passes straight through
    return new Response(res.body, { status: res.status, headers: out })
  }
,
}
