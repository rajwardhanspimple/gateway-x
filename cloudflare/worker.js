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

    // Feed the real caller IP to the router's per-IP limits. cf-connecting-ip
    // can be rewritten on a Cloudflare -> Cloudflare subrequest, so send
    // x-forwarded-for too; clientIpOf() in the router reads both.
    headers.set("cf-connecting-ip", clientIp)
    headers.set("x-forwarded-for", clientIp)

    // Proof this request came through your edge. Pair with
    // RS_REQUIRE_EDGE_SECRET=true on the gateway to shut the *.supabase.co door.
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
  },
}
