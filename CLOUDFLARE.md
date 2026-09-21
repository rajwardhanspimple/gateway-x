# gw.ragestar.bond — putting your own domain in front of the gateway

Your gateway lives at:

```
https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router/v1
```

The goal is for customers to call:

```
https://gw.ragestar.bond/v1/chat/completions
```

There are three ways to do that. **Option A (Cloudflare Worker) is the one to
use** — it is free, it keeps the clean `/v1` path, it hides Supabase entirely,
and it is the only option that feeds a trustworthy caller IP into the new IP
limits.

> A plain DNS `CNAME` from `gw.ragestar.bond` to `*.supabase.co` **cannot
> work on its own**: Supabase routes on the `Host` header and needs the
> `/functions/v1/router` prefix, so you get an SSL/404 error. Something has to
> rewrite the request — that is the Worker.

---

## Option A — Cloudflare Worker reverse proxy (recommended, free)

### 1. Create the Worker

Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker** →
name it `ragestar-api` → **Deploy** → **Edit code**, then replace everything
with:

```js
// gw.ragestar.bond  ->  Supabase Edge Function "router"
const ORIGIN = "https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router"

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // https://gw.ragestar.bond/v1/chat/completions
    //   -> .../functions/v1/router/v1/chat/completions
    const path = url.pathname === "/" ? "/health" : url.pathname
    const target = ORIGIN + path + url.search

    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("cf-connecting-ip")

    // the caller's real address + proof this request came through your edge
    headers.set("cf-connecting-ip", request.headers.get("cf-connecting-ip") ?? "")
    headers.set("x-rs-edge-secret", env.RS_EDGE_SECRET ?? "")

    const res = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    })

    // stream SSE straight through, never cache an API response
    const out = new Headers(res.headers)
    out.set("cache-control", "no-store")
    out.delete("content-encoding")
    return new Response(res.body, { status: res.status, headers: out })
  },
}
```

**Deploy** it.

### 2. Give the Worker the shared secret

Generate a long random string (`openssl rand -hex 32`), then:

Worker → **Settings** → **Variables and Secrets** → **Add** →
type **Secret**, name `RS_EDGE_SECRET`, value = that string → **Deploy**.

### 3. Attach the hostname

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain** →
`gw.ragestar.bond` → **Add domain**.

Cloudflare creates the DNS record and the certificate for you — you do **not**
need to add an A/CNAME record by hand. Give it 1–2 minutes to go green.

### 4. Teach the gateway to trust only that path

In a terminal with the Supabase CLI linked to the project:

```bash
supabase secrets set RS_EDGE_SECRET="<the same string>"
supabase secrets set RS_REQUIRE_EDGE_SECRET=true
supabase functions deploy router
```

(Or Dashboard → **Edge Functions** → **Secrets** for the two values, then
redeploy `router`.)

* `RS_EDGE_SECRET` — the router now believes `cf-connecting-ip`, so per-IP
  limits see the real caller instead of a Cloudflare address.
* `RS_REQUIRE_EDGE_SECRET=true` — the raw `*.supabase.co` URL starts answering
  `403 forbidden_endpoint`, so nobody can route around your edge rules.
  Leave it unset while you are still testing.

### 5. Point the product at the new URL

RageStar admin → **Settings** → **Gateway URL**:

```
https://gw.ragestar.bond/v1
```

And in `.env` for the frontend build:

```
VITE_GATEWAY_URL=https://gw.ragestar.bond/v1
```

Rebuild/redeploy the site so Docs, Console and the Playground all show the new
endpoint.

### 6. Test

```bash
curl https://gw.ragestar.bond/health

curl https://gw.ragestar.bond/v1/models \
  -H "Authorization: Bearer rs_live_..."

curl https://gw.ragestar.bond/v1/chat/completions \
  -H "Authorization: Bearer rs_live_..." \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

Any OpenAI SDK now works with `base_url="https://gw.ragestar.bond/v1"`.

### 7. Recommended Cloudflare settings for an API hostname

| Where | Setting |
| --- | --- |
| SSL/TLS → Overview | **Full (strict)** |
| SSL/TLS → Edge Certificates | **Always Use HTTPS** on, **Min TLS 1.2** |
| Speed → Optimization | leave Auto Minify/Rocket Loader **off** for `api.*` |
| Caching → Cache Rules | rule: hostname = `gw.ragestar.bond` → **Bypass cache** |
| Security → WAF → Rate limiting rules | see below |

**Edge rate limit (belt and braces with the database limits):**
Security → **WAF** → **Rate limiting rules** → **Create rule**

* If incoming requests match: `Hostname equals gw.ragestar.bond`
* Characteristics: **IP** (free plan) — or *IP* + header `Authorization` on paid
* Rate: `600` requests per `1 minute`
* Action: **Block**, duration `1 minute`

That stops a flood before it ever costs you a Supabase invocation; the database
limits then enforce the finer per-key rules.

---

## Option B — Supabase Custom Domain add-on (paid, no Worker)

If you would rather have Supabase own the hostname (\$10/mo add-on):

1. Supabase Dashboard → **Settings** → **Custom Domains** → enter
   `gw.ragestar.bond` → it shows a `CNAME` and a `TXT` verification record.
2. In Cloudflare DNS add both records exactly as shown, and set the CNAME to
   **DNS only (grey cloud)** — Supabase terminates TLS itself, so proxying
   breaks verification.
3. Click **Verify**, then **Activate**.
4. Your endpoint becomes
   `https://gw.ragestar.bond/functions/v1/router/v1` (the `/functions/v1/...`
   prefix stays, which is why Option A is nicer for customers).

With this option the caller IP arrives in `x-forwarded-for`, which the router
already reads — but do **not** set `RS_REQUIRE_EDGE_SECRET=true`, because
there is no Worker to inject the header.

---

## Option C — a literal redirect (only if you really want a redirect)

Cloudflare → **Rules** → **Redirect Rules** → Create:

* When: `Hostname equals gw.ragestar.bond`
* Then: **Dynamic** →
  `concat("https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router", http.request.uri.path)`
* Status: **308** (preserves the POST body)

This works for `curl` but several HTTP clients drop the `Authorization` header
on a cross-host redirect, and it publishes your Supabase URL to every caller.
Use Option A instead unless you need a stop-gap for an hour.

---

## IP limits cheat sheet (after running `supabase/upgrade-v5.6-lints-and-ip.sql`)

Nothing is enforced until you set a number.

```sql
-- 120 requests/minute per IP, auto-ban a flooding address for 15 minutes
select public.admin_save_settings('{"ip_rate_limit_rpm":120,"ip_autoblock_minutes":15}');

-- every key must declare its addresses, and no key may be used from more
-- than 5 different addresses per hour
select public.admin_save_settings('{"ip_allowlist_required":true,"ip_max_distinct_per_hour":5}');

-- refuse a range everywhere
select public.admin_save_settings('{"ip_denylist":["203.0.113.0/24"]}');

-- lock one customer key to their servers, 60 req/min per address
select public.set_api_key_ip_rules('<key-uuid>', array['203.0.113.7','2001:db8::/48'], 60);

-- ban / unban, and see who is hammering you
select public.admin_block_ip('198.51.100.23', 'scraping', 1440);
select public.admin_unblock_ip('198.51.100.23');
select * from public.admin_ip_activity(24);
```

In the Console, each key row has an **IP rules** button for the same thing.

Errors your callers will see:

| HTTP | code | meaning |
| --- | --- | --- |
| 403 | `ip_not_allowed` | address is not on the key's allowlist |
| 403 | `ip_blocked` | address is on the ban list or workspace denylist |
| 403 | `ip_allowlist_required` | workspace requires keys to declare their IPs |
| 403 | `forbidden_endpoint` | called `*.supabase.co` directly instead of your domain |
| 429 | `ip_rate_limit_exceeded` | per-IP requests/minute exceeded (`retry-after: 5`) |
| 429 | `ip_fanout_exceeded` | one key used from too many addresses this hour |
