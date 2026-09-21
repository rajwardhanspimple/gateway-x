# Supabase backend — RageStar

Project: `https://vxzpiipnsfrnsrrgxdug.supabase.co` (ref `vxzpiipnsfrnsrrgxdug`)

## 1. Create the database (one paste, ~10 seconds)

Dashboard → **SQL Editor** → **New query** → paste the whole of `schema.sql` → **Run**.

It is idempotent, so you can re-run it any time. Optionally run `seed.sql`
afterwards if you want one example upstream row to edit instead of starting empty.

CLI alternative:

```bash
export DATABASE_URL='postgresql://postgres:<DB-PASSWORD>@db.vxzpiipnsfrnsrrgxdug.supabase.co:5432/postgres'
./scripts/apply-schema.sh
```

### What gets created

| Object | Purpose |
| --- | --- |
| `profiles` | one row per auth user, `role` = `user` \| `early_access` \| `admin` |
| `upstreams` | **the original third-party API** — `base_url`, auth scheme, timeouts. Admin-only |
| `upstream_keys` | **the API keys you paste in**, each with `status` = working / failing / rate_limited / expired / disabled / unknown, latency, error, counters |
| `upstream_key_checks` | history of every health check |
| `models` | your public model id → hidden `upstream_model_id`, plus `access_tier` = `public` \| `early_access` |
| `api_keys` | the `rs_live_…` keys your users call you with (sha256 only) |
| `request_logs` | usage, latency, tokens, cost, failover |
| `audit_logs` | every admin action |
| `app_settings` | brand, gateway url, signup toggle, failover, retention, admin emails |

Safe views (`public_models`, `my_api_keys`, `my_request_logs`, `route_health`,
`gateway_daily_health`) are what the site reads. None of them contain the
upstream name, url, model id, or key. Row Level Security denies everything by
default: `upstreams`, `upstream_keys` and `models` are readable **only** by an
admin, and the routing RPCs (`internal_*`) are revoked from `anon` and
`authenticated` — only the service role inside the Edge Function can call them.

## 2. Deploy the gateway

```bash
npm i -g supabase
supabase login
supabase link --project-ref vxzpiipnsfrnsrrgxdug
supabase functions deploy router --no-verify-jwt
supabase functions deploy admin-check-keys --no-verify-jwt
```

`--no-verify-jwt` on `router` is required: your customers authenticate with a
`rs_live_…` key, not a Supabase JWT. The function does its own auth.
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

It is also required on `admin-check-keys`. That function verifies the admin
JWT itself, and platform-level verification additionally rejects the browser's
CORS preflight (which carries no `Authorization` header) with a header-less
401 — which the browser can only report as `Failed to fetch`.

Your public API base URL becomes:

```
https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router/v1
```

Drop-in for any OpenAI-compatible SDK.

## 3. Auth settings

Dashboard → **Authentication → URL configuration**

- **Site URL**: `https://ragestar.bond`
- **Redirect URLs** (allowlist — add every one of these):
  ```
  https://ragestar.bond/**
  https://ragestar-site.*.workers.dev/**
  http://localhost:5173/**
  ```

This is the setting that decides what the emails contain. GoTrue only honours
the `redirect_to` the app sends when it matches this allowlist; otherwise it
silently substitutes **Site URL**. So a Site URL of `http://localhost:5173`
means every magic link, confirmation and reset email points at localhost no
matter what the deployed frontend asks for. Keep localhost in the *Redirect
URLs* list (harmless, keeps dev working) but never as the *Site URL*.

The frontend sends `${VITE_SITE_URL}/#/console` and `${VITE_SITE_URL}/#/reset`,
so `VITE_SITE_URL` in `.env` and Site URL here must be the same origin.

Email confirmations on = new users must click the email link before signing in;
the signup screen handles both cases. Turn them off in
**Authentication → Providers → Email** if you want instant access.

`genalpha16@outlook.com` is in `app_settings.admin_emails`, so that account is
promoted to admin automatically the moment it signs up. The very first account
to ever sign up also becomes admin as a fallback.

## 4. Keys

| Key | Where it goes |
| --- | --- |
| Publishable / anon key | `.env` → `VITE_SUPABASE_ANON_KEY` (browser, safe) |
| Secret key `sb_secret_…` | `supabase/.env.server` only — server side. Never in `.env`, never in the bundle |

`.env.server` is gitignored. Edge Functions do **not** need it pasted anywhere:
Supabase injects the service role key for you.

## 5. Housekeeping (optional)

Schedule log pruning with pg_cron:

```sql
select cron.schedule('prune-logs', '0 4 * * *', $$select public.prune_request_logs()$$);
```

---

## v5.4 — key creation fix + credits

Run **`upgrade-v5.4.sql`** in the Supabase SQL editor (Dashboard → SQL editor →
paste → Run). It is idempotent, so running it twice is harmless.

What it changes:

1. **`create_api_key` is rebuilt.** The old body compared
   `where id = v_user` inside a function that also declares an OUT parameter
   named `id`, so Postgres raised `column reference "id" is ambiguous` and every
   console key creation failed before it even reached the insert. All column
   references are now table-qualified, the secret is generated from
   `gen_random_uuid()` and hashed with the built-in `sha256()` (no dependency on
   `pgcrypto` living in the `extensions` schema), and a missing profile row is
   created on the fly instead of erroring.
2. **Credits.** `profiles.credit_balance_usd` plus a full `credit_ledger`,
   guarded by a trigger so the balance can only move through the audited
   functions:
   - `my_credits()` — balance, lifetime totals, burn rate, runway (console)
   - `my_credit_ledger` / `admin_credit_ledger` — statement views
   - `admin_adjust_credits(user, amount, note)` — grant or claw back
   - `admin_set_credit_balance(user, balance, note)` — overwrite a balance
   - `internal_log_request()` now debits the metered cost of every request
   - `handle_new_user()` grants `app_settings.signup_credit_usd` once per signup
3. **Settings** gains `credits_enabled`, `signup_credit_usd`, `low_balance_usd`
   and `overdraft_usd`. Enforcement ships **off** — flip it on in
   Admin → Settings → Credits once the balances look right.

After the SQL, redeploy the gateway so it reads the new balance fields:

```bash
supabase functions deploy router --no-verify-jwt
```

The router now refuses calls with `402 insufficient_credits` when enforcement is
on and the balance is exhausted, and reports `x-rs-credits-usd` /
`x-rs-credits-remaining` on every response.

---

## upgrade-v6.0-timeouts.sql

Run after `schema.sql` and the earlier upgrades. Idempotent.

Adds per-model / per-provider response deadlines and API-key rotation on stall:

- Columns: `app_settings.default_timeout_ms|max_key_attempts|retry_on_timeout|key_cooldown_seconds`,
  `upstreams.max_key_attempts|retry_on_timeout`, `models.timeout_ms|max_key_attempts`,
  `upstream_keys.timeout_count|last_timeout_at|cooldown_until`,
  `request_logs.attempts|keys_tried|timed_out|timeout_ms`.
- `route_deadline(model_id)` resolves model -> provider -> workspace.
- `internal_route_candidates` / `internal_resolve_route` now return
  `eff_timeout_ms`, `eff_attempts`, `eff_retry` and `keys_available`.
- `internal_pick_keys(upstream_id)` returns keys in rotation order and marks
  cooling keys last; `internal_record_key_result(..., p_timed_out)` counts
  stalls and sets `cooldown_until`.
- `internal_log_request(jsonb)` stores attempts / keys tried / timed out.
- Admin views: `admin_route_timeouts`, `admin_provider_health`,
  `admin_key_rotation`.
- Admin RPCs: `admin_get_timeout_settings`, `admin_save_timeout_settings`,
  `admin_set_model_timeout`, `admin_set_upstream_timeout`,
  `admin_clear_key_cooldown`.

After running it, redeploy the router (`npm run fn:deploy`) so the gateway
reads the new columns.
