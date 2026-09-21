# cloudflare/ — the edge proxy for gw.ragestar.bond

Turns

```
https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router/v1/chat/completions
```

into

```
https://gw.ragestar.bond/v1/chat/completions
```

This is a **reverse proxy**, not a redirect. The caller only ever talks to your
domain — so the Supabase URL stays hidden, the `Authorization: Bearer rs_live_…`
header is never dropped, and SSE streaming still works.

| File | What it is |
| --- | --- |
| `worker.js` | the proxy itself (~60 lines, runs free on Cloudflare) |
| `wrangler.toml` | name, entrypoint, and the `gw.ragestar.bond` custom domain |
| `.gitignore` | keeps `.wrangler/` and `node_modules/` out of git |

---

## Prerequisite

`ragestar.bond` must already be a **zone in your Cloudflare account** — add the
site in Cloudflare, then change the nameservers at your registrar. Until the
zone is active, Cloudflare cannot issue the hostname or its certificate.

---

## Deploy (CLI)

```bash
# from the repo root, once
npm i -D wrangler
npx wrangler login

cd cloudflare

# 1. generate the shared secret and hand it to the Worker
openssl rand -hex 32                    # copy the output
npx wrangler secret put RS_EDGE_SECRET  # paste it

# 2. ship it (also creates the DNS record + certificate)
npx wrangler deploy
```

Give the hostname 1–2 minutes to go green.

## Give the gateway the same secret

```bash
cd ..
supabase secrets set RS_EDGE_SECRET="<the same string>"
npm run fn:deploy
```

> Leave `RS_REQUIRE_EDGE_SECRET` **unset** for now. Turning it on before the
> domain works locks you out of both URLs.

## Test

```bash
curl https://gw.ragestar.bond/health

curl https://gw.ragestar.bond/v1/models \
  -H "Authorization: Bearer rs_live_..."

curl https://gw.ragestar.bond/v1/chat/completions \
  -H "Authorization: Bearer rs_live_..." \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

Streaming check (should trickle, not arrive all at once):

```bash
curl -N https://gw.ragestar.bond/v1/chat/completions \
  -H "Authorization: Bearer rs_live_..." \
  -H "content-type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"count to 20"}]}'
```

## Then close the back door

Once the tests above pass:

```bash
supabase secrets set RS_REQUIRE_EDGE_SECRET=true
npm run fn:deploy
```

The raw `*.supabase.co` URL now answers `403 forbidden_endpoint`, so nobody can
route around your edge rate limits.

## Point the product at the new URL

In the repo-root `.env` (currently blank):

```
VITE_GATEWAY_URL=https://gw.ragestar.bond/v1
```

Then `npm run build` so Docs, Console and the Playground all show it. Also set
RageStar admin → Settings → Gateway URL to the same value.

---

## Cloudflare dashboard settings for an API hostname

| Where | Setting |
| --- | --- |
| Caching → Cache Rules | hostname = `gw.ragestar.bond` → **Bypass cache** (important — never serve one customer's response to another) |
| SSL/TLS → Overview | **Full (strict)** |
| SSL/TLS → Edge Certificates | **Always Use HTTPS** on, **Min TLS 1.2** |
| Speed → Optimization | Auto Minify / Rocket Loader **off** |
| Security → WAF → Rate limiting | hostname = `gw.ragestar.bond`, characteristic **IP**, 600 req / 1 min, action **Block** 1 min |

---

## Everyday commands

```bash
npx wrangler deploy            # ship a change
npx wrangler tail              # live request log
npx wrangler dev               # run locally on http://localhost:8787
npx wrangler secret list       # confirm RS_EDGE_SECRET is set
npx wrangler deployments list  # history
npx wrangler rollback          # undo the last deploy
```

## If something breaks

| Symptom | Cause |
| --- | --- |
| `Could not find zone for gw.ragestar.bond` | `ragestar.bond` is not an active zone in this Cloudflare account |
| SSL error for a few minutes after deploy | certificate still issuing — wait, then retry |
| `403 forbidden_endpoint` through your domain | Worker secret ≠ Supabase secret; re-set both, redeploy the function |
| everyone shares one IP in the logs | the `x-forwarded-for` line in `worker.js` was removed |
| streaming arrives in one lump | a Cache Rule is buffering — set Bypass cache for this hostname |

---

## keywatch worker — removed in v11.3

**There is no keywatch worker here any more.** `keywatch-worker.js` and
`wrangler.keywatch.toml` are gone; the beat is scheduled by `pg_cron` inside
Supabase, next to the state it writes. See [`../KEYWATCH.md`](../KEYWATCH.md).

The worker was removed rather than kept as a second option because of what it
cost to debug. Its whole job was one POST a minute, but it split the system
across two accounts that could not see each other: the schedule lived in
Cloudflare, the evidence of whether the schedule worked lived in Postgres, and
neither dashboard could show you the other half. Every failure looked identical
from this side — `wrangler deploy` exits 0 and the cron shows healthy whether
the function 401s, 403s, or was never deployed at all.

If you still have the worker deployed from v11.2 or earlier, delete it, or it
will keep firing alongside pg_cron (harmless — `internal_keywatch_due()` takes
a row lock, so the duplicate pass is refused rather than double-checking keys —
but it will muddy the audit trail with `source = 'cron'` rows):

```bash
npx wrangler delete ragestar-keywatch
```

The gateway worker in this folder (`worker.js` + `wrangler.toml`) is unrelated
and still in use. Nothing above applies to it.

Historical write-up of the 401 outage: `../KEYWATCH-FIX.md`.
