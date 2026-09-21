# RageStar — security model

Everything below ships in this repository. The short version: **the browser is
never the security boundary.** Every rule is enforced in Postgres or in the
Edge Functions, and the React app only mirrors it for a nicer error message.

> **Run this first:** `supabase/upgrade-v5.5-security.sql` (Supabase dashboard →
> SQL editor → paste → Run). Without it the database still allows the old
> behaviour, no matter what the front end does.

---

## 1. Gmail-only accounts

| Layer | What it does |
| --- | --- |
| `src/lib/auth.js` | `validateEmail()` rejects anything that is not on an allowed domain; `signIn`, `signUp`, `sendMagicLink`, `sendPasswordReset`, `resendConfirmation` all refuse before a network call. |
| `src/lib/auth.js` | A live session on a disallowed domain is signed out on load (`enforceSessionDomain`). Admins are exempt so you cannot lock yourself out. |
| `signInWithProvider` | Google only, with the `hd=gmail.com` hint. Other OAuth providers are rejected. |
| **Database trigger** | `auth_users_allowed_email` on `auth.users` (before insert **and** email change) rejects the row. This is the authoritative gate — curl, the REST API, magic links and OAuth all hit it. |
| Migration | Existing accounts on a disallowed domain are set to `status = 'suspended'`, which blocks the gateway, the console and the admin function. Addresses in `app_settings.admin_emails` are kept. |

Allowed domains live in `app_settings.allowed_email_domains` (default
`{gmail.com}`). To change them:

```sql
select public.admin_save_settings('{"allowed_email_domains":["gmail.com","yourdomain.com"]}');
```

and set `VITE_ALLOWED_EMAIL_DOMAINS=gmail.com,yourdomain.com` in `.env` so the
forms agree with the database.

## 2. Credits cannot be changed by the user

The old `guard_profile_credits()` trigger was `SECURITY DEFINER`, so its
`current_user` check matched the function owner instead of the caller and the
guard returned early **every time**. Combined with `grant update on profiles to
authenticated`, any signed-in user could run one line in the browser console and
top up their own balance.

Fixed in three independent layers:

1. **Column privileges** — `revoke update on public.profiles from authenticated`,
   then `grant update (full_name, org)`. Credits, `role`, `status`, `plan`,
   `monthly_budget_usd` and `rate_limit_rpm` are simply not writable by a
   signed-in role.
2. **Trigger** — `guard_profile_credits()` is now `SECURITY INVOKER` and raises
   `42501` on any attempt to change a credit column, role, status, plan, budget,
   rate limit, id or email. Only `service_role` / `postgres` (that is, the
   billing routines `internal_credit_move`, `admin_adjust_credits`,
   `admin_set_credit_balance`) pass through.
3. **Ledger** — `credit_ledger` stays insert-only to `service_role`; users keep
   read access to their own rows through `my_credit_ledger`.

## 3. `admin_emails` is no longer world-readable

`handle_new_user()` promotes any signup whose address appears in
`app_settings.admin_emails`. That table was granted `select` to `anon` with a
`using (true)` policy, so the list of “become admin by signing up” addresses was
public.

* `select` on `app_settings` is revoked from `anon` and gated by
  `is_admin(auth.uid())` for `authenticated`.
* Non-secret fields are served by a new `public_settings` view (no
  `admin_emails`), which is what `getSettings()` reads.
* Writes go through `admin_save_settings(jsonb)` — admin check, key allow-list,
  range/format validation, no dynamic SQL — and direct `insert/update/delete`
  is revoked.

## 4. SQL injection

No string-concatenated SQL exists in the project: the browser talks to
PostgREST/RPC (bound parameters) and the Edge Functions only call `rpc()` with
typed arguments. The remaining hardening closes the indirect paths:

* every `SECURITY DEFINER` function pins `set search_path = public`, and
  `revoke create on schema public` stops anyone from planting a shadowing
  function or table that such a function would resolve first;
* `admin_save_settings()` validates keys against an allow-list and never builds
  SQL from input;
* server-side `check`-style validation on everything an operator can type
  (`guard_upstreams`, `guard_models`, `guard_api_keys`) — length caps, `https://`
  only, numeric ranges;
* `statement_timeout` is capped for `anon` and `authenticated` so a crafted
  query cannot pin CPU.

## 5. JavaScript / HTML injection (XSS)

* `src/lib/sanitize.js` is new: `escapeHtml`, `sanitizeSvg` (tag + attribute
  allow-list, strips `on*`, `javascript:`, `<script>`, `<foreignObject>`),
  `safeJsonParse` (prototype-pollution safe), `isSafeHttpUrl`, `safeHref`,
  `sanitizeHeaderMap`, `validateUpstreamBaseUrl`.
* All 13 `dangerouslySetInnerHTML` call sites are gone. Inline SVG now goes
  through one audited component, `SafeSvg` in `src/components/brand.jsx`, which
  sanitises first. `Icon` uses an own-property lookup so a crafted name cannot
  reach inherited members.
* `CodeBlock` no longer accepts pre-rendered HTML; it renders text (React
  escapes it) or structured `{ text, kind }` tokens.
* Text that is rendered back from the database is stripped of `<`/`>` at write
  time too (`profiles.full_name`, `profiles.org`, model names/descriptions,
  `brand_name`, `topup_note`, API key names) — stored XSS has no entry point.
* **CSP**: `vite.config.js` injects
  `script-src 'self'` (no `unsafe-inline`, no `unsafe-eval`) into the production
  build, and `public/_headers` carries the same policy plus `nosniff`,
  `frame-ancestors 'none'`, `Referrer-Policy`, HSTS and `Permissions-Policy`.
  The inline theme script moved to `src/main.jsx` to satisfy it.
* The unpkg.com motion engine is no longer loaded at runtime unless
  `VITE_ENABLE_REMOTE_MOTION=true`; the bundled fallback is the default.

## 6. Gateway and admin function

* **SSRF** — `assertPublicHttpsUrl()` in `supabase/functions/_shared/cors.ts` is
  applied before every upstream `fetch` in both functions, and `guard_upstreams`
  enforces the same rule at write time: `https://` only, no credentials in the
  URL, no loopback / RFC1918 / `169.254.x` / `*.internal` / `*.local` hosts.
* **Body limits** — 256 KB cap on both functions before parsing.
* **JSON** — no unguarded `JSON.parse` left; admin-supplied header blobs go
  through `safeJsonParse` / `sanitizeHeaderMap` (CRLF and `Authorization`
  overrides stripped).
* **CORS** — the response no longer reflects arbitrary
  `Access-Control-Request-Headers`. Set the `ALLOWED_ORIGINS` secret to pin the
  admin endpoint to your own origins; the public gateway stays `*` by design.
* `admin-check-keys` continues to verify the JWT and require
  `role = 'admin' and status = 'active'` in its own code, which is why
  `verify_jwt = false` (needed for browser preflight) is safe.
* API keys: new keys are minted with the `rs_live_` / `rs_test_` prefix; legacy
  `rr_` keys still authenticate, so nothing breaks on upgrade. Max 25 active
  keys per user.

## 7. Secrets

`supabase/.env.server` shipped with a real `SUPABASE_SERVICE_ROLE_KEY` value.
It has been replaced with `REPLACE_ME_ROTATE_THIS_KEY`.

**Rotate that key now** (Supabase → Project Settings → API → service role →
reset), then set it as a function secret rather than a file:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<new key>"
```

The service-role key bypasses row-level security entirely; treat it like a
database password. `.gitignore` already excludes `.env`, `.env.local` and
`supabase/.env.server`.

---

## Verifying the fixes

```sql
-- 1. Gmail rule
select public.email_domain_allowed('you@gmail.com');    -- t
select public.email_domain_allowed('you@outlook.com');  -- f

-- 2. as a normal signed-in user (SQL editor “run as” authenticated, or the
--    browser console) — both must fail:
update public.profiles set credit_balance_usd = 9999 where id = auth.uid();
update public.profiles set role = 'admin' where id = auth.uid();

-- 3. admin_emails must not be readable while signed out
select * from public.app_settings;   -- 0 rows / permission denied
select * from public.public_settings; -- 1 row, no admin_emails column
```

In the browser console, signed in as a normal user:

```js
await supabase.from("profiles").update({ credit_balance_usd: 9999 }).eq("id", user.id)
// -> error 42501: Credit balances can only be changed by the billing system
```

## Still worth doing

* Turn on Supabase leaked-password protection and set the OTP/magic-link expiry
  to 10 minutes (Dashboard → Authentication → Providers).
* Enable email confirmation, and add captcha if signups are public.
* Consider moving the gateway behind a per-IP rate limit at the CDN; the
  built-in limit is per API key (`internal_rate_check`).
* Review `app_settings.admin_emails` and remove any address you do not control.

---

## v5.6 — linter clean + IP limits

Run `supabase/upgrade-v5.6-lints-and-ip.sql` once, then redeploy the router
(`supabase functions deploy router`).

### Supabase Advisors

| Warning | Fix |
| --- | --- |
| Security Definer View (9) | every view is now `security_invoker = on`; the three views `anon` must read (`public_models`, `route_health`, `gateway_daily_health`, plus `public_settings`) select from `security definer` **functions** that return only non-secret columns, so upstream names, base URLs, real model ids and `admin_emails` still never leave the database |
| Auth RLS Initialization Plan (5) | `auth.uid()` / `is_admin()` are wrapped in `(select …)` so they are evaluated once per statement instead of once per row |
| Multiple Permissive Policies (3) | one policy per table per action (`owner OR admin` inside a single policy) on `profiles`, `api_keys`, `request_logs`, `credit_ledger`, `app_settings` |
| Function Search Path Mutable | `touch_updated_at()` is pinned to `search_path = ''`, and a sweep pins `search_path = public` on every other `public` function |
| Leaked Password Protection Disabled | dashboard only: **Authentication → Sign In / Providers → Passwords** → enable *Prevent use of leaked passwords*, minimum length ≥ 10, require letters + digits + symbols |

No policy was widened: invoker-rights views are strictly tighter than the
definer views they replace, and user-facing writes still go through the
`security definer` RPCs (`create_api_key`, `update_api_key`,
`set_api_key_ip_rules`, `admin_*`).

### IP limits

All off by default — nothing changes until you set a number.

| Control | Where |
| --- | --- |
| Per-key IP/CIDR allowlist | `api_keys.allowed_ips`, Console → Keys → **IP rules** |
| Per-key per-IP rate limit | `api_keys.ip_rate_limit_rpm` |
| Workspace per-IP rate limit | `app_settings.ip_rate_limit_rpm` |
| Workspace denylist | `app_settings.ip_denylist` |
| Force every key to declare IPs | `app_settings.ip_allowlist_required` |
| Key-sharing guard (distinct IPs/hour) | `app_settings.ip_max_distinct_per_hour` |
| Auto-ban sustained floods | `app_settings.ip_autoblock_minutes` → `blocked_ips` |
| Manual bans with expiry | `admin_block_ip()` / `admin_unblock_ip()` / `blocked_ips` |
| Forensics | `request_logs.client_ip`, `admin_ip_activity()`, `my_ip_activity()` |

The router calls `internal_ip_check()` after key authentication and before any
upstream request, and refuses with `403 ip_not_allowed` / `403 ip_blocked` /
`403 ip_allowlist_required` / `429 ip_rate_limit_exceeded` /
`429 ip_fanout_exceeded`.

### Trusting the caller address

The address is only as trustworthy as the header it comes from:

* `RS_EDGE_SECRET` — shared with the Cloudflare Worker in front of
  `gw.ragestar.bond`; only then is `cf-connecting-ip` believed.
* `RS_REQUIRE_EDGE_SECRET=true` — the raw `*.supabase.co` function URL answers
  `403 forbidden_endpoint`, so nobody can bypass the edge (and its rules).

See `CLOUDFLARE.md` for the full setup.

---

## v5.8 — IP limiting switched off

Run `supabase/upgrade-v5.8-no-ip-limits.sql` once. No table or function is
dropped, so v5.6/v5.7 enforcement can be turned back on from
**Admin → IP limits** or with `admin_save_ip_settings()`.

### Where IP limits could and could not apply

| Path | IP rules? |
| --- | --- |
| Browser sign-in / sign-up / magic link / password reset (`src/pages/Login.jsx` → `src/lib/auth.js` → Supabase Auth) | **No.** Never was. `internal_ip_check(api_key_id, ip)` needs an authenticated `rs_live_` key, which a login request does not have. |
| Gateway requests through `supabase/functions/router` | Yes — this is what v5.6/v5.7 governs, and what v5.8 disables. |
| GoTrue's own per-IP throttle on sign-in and token refresh | Yes, but it is a project setting: **Dashboard → Authentication → Rate Limits**, mirrored in `[auth.rate_limit]` in `supabase/config.toml`. |

### What v5.8 sets

| Setting | After |
| --- | --- |
| `app_settings.ip_limits_enabled` | `false` (master switch) |
| `ip_rate_limit_rpm`, `ip_rate_limit_rph` | `0` = unlimited |
| `ip_max_distinct_per_hour`, `ip_max_accounts_per_ip` | `0` = unlimited |
| `ip_autoblock_minutes` | `0` = never auto-ban |
| `ip_allowlist_required` | `false` |
| `ip_denylist` | emptied |
| `blocked_ips` where `source = 'auto'` | deleted (manual bans kept) |
| `ip_rate_buckets` | cleared |

Addresses are still recorded in `ip_registry` and `request_logs.client_ip`, so
**Admin → IP limits** stays useful as a read-only audit trail.

Two things the master switch deliberately does **not** waive — both have
ready-to-uncomment statements in the upgrade file:

* `api_keys.allowed_ips` — a lock the key owner set on their own key.
* `blocked_ips` with `source = 'manual'` — a deliberate ban by an admin.

### `email rate limit exceeded` on `/auth/v1/invite`

Not an IP limit. It is GoTrue's hourly email quota, which is very small on
Supabase's built-in shared SMTP, and every invite, confirmation, magic link and
reset shares it. Options:

1. Skip email entirely — `node scripts/create-user.mjs someone@gmail.com 'TempPass123!'`
   creates a confirmed account through the Admin API (add `--reset-link` to get
   a one-time password link you can deliver yourself).
2. Configure custom SMTP (Resend, SES, Postmark, Brevo) under
   **Authentication → Emails → SMTP Settings**, then raise
   **Authentication → Rate Limits → Emails sent per hour**.
3. Wait out the hour.

The v5.5 trigger on `auth.users` still applies: the address must be on
`app_settings.allowed_email_domains` (default `gmail.com`) or the invite fails
whatever the quota says.
