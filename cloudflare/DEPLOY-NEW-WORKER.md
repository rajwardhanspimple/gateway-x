# RageStar gateway — its own Worker on `gw.ragestar.bond`

## Hostname map

| Hostname | Owner | Action |
| --- | --- | --- |
| `ragestar.bond` | the website / frontend | leave alone |
| `api.ragestar.bond` | a different Worker | leave alone |
| `gw.ragestar.bond` | **this Worker** (`ragestar-gateway`) | created by `wrangler deploy` |

Nothing in this folder touches the apex domain or the other Worker. No DNS
record to delete, no custom domain to detach.

## What changed vs. the zip you sent

`cloudflare/wrangler.toml` only:

```diff
- name = "ragestar-api"
+ name = "ragestar-gateway"
+ workers_dev = true

  routes = [
-   { pattern = "api.ragestar.bond", custom_domain = true }
+   { pattern = "gw.ragestar.bond", custom_domain = true }
  ]
```

`worker.js` is byte-identical — it proxies to the Supabase `router` function and
does not care which hostname fronts it.

---

## 1. Deploy the Worker (PowerShell)

```powershell
cd C:\Users\Administrator\Downloads\RageStar-secure-v5.6\RageStar-secure-v5.6\cloudflare

npx wrangler whoami          # confirm the account that owns ragestar.bond

# a new Worker starts with no secrets
-join (1..32 | % { '{0:x2}' -f (Get-Random -Max 256) })   # 64-char secret, no openssl needed
npx wrangler secret put RS_EDGE_SECRET                   # paste it, keep a copy

npx wrangler deploy          # also creates the DNS record + TLS cert for gw.
npx wrangler secret list     # sanity check
```

Give `gw.ragestar.bond` 1–2 minutes to go green.

**Reuse the secret already set in Supabase** if you still have it — then the
gateway needs no change. If you generated a fresh one, push it to Supabase too:

```powershell
cd ..
supabase link --project-ref vxzpiipnsfrnsrrgxdug
supabase secrets set RS_EDGE_SECRET="<the same string>"
npm run fn:deploy
```

> One gateway, one `RS_EDGE_SECRET`. If the other Worker on
> `api.ragestar.bond` also proxies to this same Supabase project, both Workers
> must carry the *same* secret or the one you don't update starts getting
> `403 forbidden_endpoint` the moment `RS_REQUIRE_EDGE_SECRET=true`.

## 2. Point the frontend at the new hostname

The host changed, so the four frontend spots have to follow. From the repo root:

```powershell
node set-gateway-host.mjs gw.ragestar.bond
npm install
npm run build
```

The script is idempotent and prints every file it touches. It:

- sets `VITE_GATEWAY_URL=https://gw.ragestar.bond/v1` in `.env` and `.env.example`
  (adds the line if it is missing or blank)
- adds `https://gw.ragestar.bond` to the CSP `connect-src` in `public/_headers`
- does the same for the CSP meta tag in `vite.config.js`
- rewrites any leftover `api.ragestar.bond` references in tracked text files

Check it with `git diff` before building. Vite inlines env vars at build time,
so **the `.env` edit does nothing until `npm run build` runs.**

Also set RageStar admin → Settings → Gateway URL to `https://gw.ragestar.bond/v1`.

### Why the CSP line matters

The site is served from `ragestar.bond` and the API now lives on
`gw.ragestar.bond` — a different origin. Without `gw.ragestar.bond` in
`connect-src`, the browser blocks every Docs / Console / Playground request
before it leaves the page. (This was already cross-origin with
`api.ragestar.bond`, so CORS behaviour itself is unchanged: the Supabase router
still answers the preflight and the Worker just forwards it.)

## 3. Verify

```powershell
# the Worker directly, works even before DNS goes green
curl.exe https://ragestar-gateway.<your-subdomain>.workers.dev/health

# through the new hostname
curl.exe https://gw.ragestar.bond/health
curl.exe https://gw.ragestar.bond/v1/models -H "Authorization: Bearer rs_live_..."

# streaming should trickle, not land in one lump
curl.exe -N https://gw.ragestar.bond/v1/chat/completions `
  -H "Authorization: Bearer rs_live_..." `
  -H "content-type: application/json" `
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"count to 20"}]}'
```

## 4. Close the back door (only after step 3 passes)

```powershell
supabase secrets set RS_REQUIRE_EDGE_SECRET=true
npm run fn:deploy            # raw *.supabase.co now answers 403 forbidden_endpoint
```

---

## Cloudflare dashboard settings for the new hostname

These are per-hostname rules, so they do **not** inherit from whatever is set up
for `api.ragestar.bond`:

| Where | Setting |
| --- | --- |
| Caching → Cache Rules | hostname = `gw.ragestar.bond` → **Bypass cache** |
| SSL/TLS → Overview | **Full (strict)** |
| SSL/TLS → Edge Certificates | **Always Use HTTPS** on, **Min TLS 1.2** |
| Speed → Optimization | Auto Minify / Rocket Loader **off** |
| Security → WAF → Rate limiting | hostname = `gw.ragestar.bond`, characteristic **IP**, 600 req / 1 min, **Block** 1 min |

## What is not shared between two Workers

| | Shared? |
| --- | --- |
| Code (`worker.js`) | no — each Worker has its own copy |
| Secrets (`RS_EDGE_SECRET`) | **no** — set it again here |
| Custom domain | no — one hostname, one Worker |
| `workers.dev` URL | no — `ragestar-gateway.<subdomain>.workers.dev` |
| Logs, deployment history, `rollback` | no — per Worker |
| The Supabase `RS_EDGE_SECRET` value | yes — one gateway, both Workers must match it |

## Everyday commands (run inside `cloudflare/`)

```powershell
npx wrangler tail                 # live request log
npx wrangler deployments list     # history
npx wrangler rollback             # undo last deploy
npx wrangler delete               # remove this Worker only
```

## Want a different subdomain?

```powershell
node set-gateway-host.mjs gw2.ragestar.bond   # patches wrangler.toml + frontend
cd cloudflare; npx wrangler deploy
cd ..; npm run build
```
