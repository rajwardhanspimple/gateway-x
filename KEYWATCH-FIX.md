# Why the key watch said “last pass never” — and the exact fix (v11.1)

The card you screenshotted was telling the truth. The switch was on, the
Cloudflare cron **was** firing, and still no pass ever landed. Here is why,
and what changed.

---

## The one-line cause

`supabase/config.toml` had **no `[functions.keywatch]` block**, so Supabase
applied its default of `verify_jwt = true`.

The cron worker is a server calling a server. It carries no user login token —
only the shared `x-keywatch-secret` header that the function checks itself.
With platform JWT verification on, **Supabase's gateway answered `401` before
a single line of the function ran**:

```
Cloudflare cron  ─POST─►  Supabase gateway  ─401─►  (function never runs)
                                ✘
                          internal_keywatch_due() never called
                          keywatch_last_run_at never stamped
                          admin card: “last pass never” + amber “stalled”
```

That is also why **re-running the cron changed nothing**, and why Cloudflare
looked perfectly healthy: `wrangler deploy` exits 0, the schedule fires on
time, and the old worker swallowed the 401 into a `console.log` nobody reads.

---

## Everything that was wrong (all fixed)

| # | Problem | Effect you saw | Fixed in |
|---|---------|----------------|----------|
| 1 | `config.toml` had no `[functions.keywatch]` block → `verify_jwt` defaulted to true | 401 at the gateway; no pass ever recorded | `supabase/config.toml` |
| 2 | `npm run fn:deploy` never deployed `keywatch` | the function could be missing entirely and nothing said so | `package.json` |
| 3 | The v6.0 8-argument `internal_record_key_result()` squashed any source that was not `manual/auto/traffic` down to `'traffic'` | cron passes were filed under the wrong name, so you could not tell scheduled checks from ordinary traffic | `supabase/upgrade-v11.1-keywatch-repair.sql` |
| 4 | The worker reported nothing useful | a broken deploy looked identical to a working one | `cloudflare/keywatch-worker.js` |
| 5 | The admin card could not explain itself | red text told you to check two things, with no way to test either | `src/components/KeyWatch.jsx` |
| 6 | Nothing could answer “which of the four links is broken?” | guesswork | `scripts/keywatch-doctor.mjs`, `admin_keywatch_selftest()` |

---

## Turn it on — in order, nothing skipped

```bash
# 1 · database (safe to re-run; v11.1 refuses to run if v11.0 is missing)
psql "$DATABASE_URL" -f supabase/upgrade-v11.0-keywatch-and-ponytail.sql
psql "$DATABASE_URL" -f supabase/upgrade-v11.1-keywatch-repair.sql

# 2 · the function, with verification OFF (this is the actual bug fix)
supabase functions deploy keywatch --no-verify-jwt

# 3 · the shared secret, on the Supabase side
supabase secrets set KEYWATCH_CRON_SECRET="$(openssl rand -hex 32)"

# 4 · the worker
wrangler deploy -c cloudflare/wrangler.keywatch.toml

# 5 · the same secret, on the Cloudflare side (paste the SAME value as step 3)
wrangler secret put KEYWATCH_URL    -c cloudflare/wrangler.keywatch.toml
wrangler secret put KEYWATCH_SECRET -c cloudflare/wrangler.keywatch.toml

# 6 · prove it
npm run keywatch:doctor
```

Steps 2+4 together are also `npm run keywatch:up`.

Then open **Admin → Dashboard → Key watch**, switch **Server watch on**, and
within about a minute the pill turns green `live` and “last pass” starts
counting in seconds.

---

## Reading the answers

`GET https://<project>.supabase.co/functions/v1/keywatch`

| Reply | Meaning | Fix |
|-------|---------|-----|
| `404` | function not deployed | `supabase functions deploy keywatch --no-verify-jwt` |
| `401` | **the original bug** — deployed with JWT verification on | deploy again **with** `--no-verify-jwt` |
| `200` + `"secret_set": false` | deployed, but holds no cron secret → refuses every scheduled call with 403 | `supabase secrets set KEYWATCH_CRON_SECRET=…` |
| `200` + `"secret_set": true` | function end is correct — the problem is on the Cloudflare side | `<worker>/health` |
| `403` | function ran and rejected the caller: the two secrets differ | set both sides to the same value |

`GET https://ragestar-keywatch.<subdomain>.workers.dev/health` reports whether
the worker has its URL and secret, and what its **last attempt** returned.
`/diag` makes the worker call the function for you and reports the verdict in
words. Neither route ever prints a secret — only whether one is present.

In SQL: `select public.admin_keywatch_selftest();` returns the same verdict
from the database's point of view, including whether recent passes came from
`cron` or only from a browser tab.

---

## The browser-tab fallback is not the same thing

“Also watch from this tab” keeps checking while that tab is open, which is why
your numbers looked fresh (`30 checked · 29 ok · 1 failing`) while the pill
still said `stalled`. It is a fallback, not the heartbeat: close the tab and
checking stops. The server watch is what keeps running at 3am.

---

## What the card does now

* **Diagnose** button — calls the function from your browser and prints the
  verdict plus the one command that fixes it, copy-pasteable.
* Honest status — it distinguishes *switched off*, *never ran*, *stopped*, and
  *running but only from this tab*, instead of one amber “stalled” for all four.
* It no longer contradicts itself: fresh local numbers are labelled as local.
