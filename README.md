# RageStar — AI gateway marketing site + console (v4)

A single-page React app for a fictional AI gateway: marketing site, live routing
visualisations, a mock console, and — new in v4 — **sign in / sign up** built on a
String UI motion layer.

No bundler config, no framework, no runtime dependencies beyond React. One
`esbuild` command produces `dist/assets/app.js` + `app.css`.

---

## Quick start

```bash
# install (React + esbuild only)
npm install

# build the bundle
npm run build

# serve dist/ with anything
python3 -m http.server -d dist 5173
# → http://localhost:5173
```

Or build straight from the CLI:

```bash
esbuild src/main.jsx --bundle --format=iife --jsx=automatic --minify \
  --define:process.env.NODE_ENV='"production"' \
  --outdir=dist/assets --entry-names=app
```

---

## Routes

| Hash | Page | Chrome |
| --- | --- | --- |
| `#/` | Home — hero, live fabric, code demo, String UI motion band | header + footer |
| `#/models` | Model catalogue with filters | header + footer |
| `#/pricing` | Plans + markup calculator | header + footer |
| `#/docs` | Quickstart, SDK snippets | header + footer |
| `#/status` | Uptime + incident history | header + footer |
| `#/login` | **Sign in** — password or magic link, OAuth, SAML | bare |
| `#/signup` | **Create account** — profile, password strength, plan | bare |
| `#/console` | Mock dashboard — charts, live feed, API keys | bare |

"Bare" routes hide the marketing header and footer (`BARE_ROUTES` in `App.jsx`).

---

## Auth (demo only — no server)

`src/lib/auth.js` is a self-contained fake backend:

- `signIn` / `signUp` / `sendMagicLink` resolve after ~0.8–1s.
- Any email starting with `locked@` **fails** with a realistic error, so the
  error and shake states are demoable.
- The session lives in `localStorage["rr-session"]` and broadcasts an
  `rr-session-change` event; `useSession()` keeps the header and console in sync.
- Password policy: 12+ chars, upper + lower case, a number, a symbol. The meter
  and the rule checklist are both driven by `scorePassword()`.

Try it:

1. Go to `#/signup`, fill anything, submit → provisioning log → console.
2. Header now shows your avatar, initials and a sign-out control.
3. Go to `#/login`, use `locked@acme.com` → admin-lock error state.
4. Switch to **Magic link** → confirmation screen with the sent-to address.

Accessibility: errors use `role="alert"` and `aria-describedby`, the first invalid
field is focused on submit, buttons expose `aria-busy` while pending, and every
animation has a `prefers-reduced-motion` fallback.

---

## String UI (String Tune)

Scroll-linked motion comes from `@fiddle-digital/string-tune@1.2.1`, loaded at
runtime from unpkg by `src/lib/stringTune.js`.

**If the CDN is unreachable, nothing breaks.** After a 3.5s timeout the loader
switches to a bundled micro-engine that writes the same `--progress` custom
property and the same state classes from an `IntersectionObserver`. The chip in
the auth top bar tells you which one is live: `string-tune · cdn` or
`string-tune · local`.

Components in `src/components/string/StringUI.jsx`:
`StringProvider`, `StringProgress`, `StringRail`, `StringSplit`,
`StringLazyImage`, `StringSpotlight`, `StringEngineChip`.

---

## Project layout

```
src/
  main.jsx                 entry — imports every stylesheet
  App.jsx                  hash router, route tags, bare-route gating
  data/models.js           model catalogue
  lib/
    auth.js                validation, fake network, session store
    stringTune.js          CDN loader + offline fallback engine
  components/
    Background.jsx         6-layer animated backdrop
    Fabric.jsx             routing-graph canvas
    Header.jsx             session-aware nav
    Footer.jsx  Cursor.jsx  Preloader.jsx  CodeBlock.jsx  fx.jsx  brand.jsx
    string/StringUI.jsx    String UI primitives
    ui/index.jsx           sui-* kit: Button, Field, TextInput, PasswordInput,
                           PasswordStrength, Checkbox, Segmented, Alert,
                           Divider, OAuthButton, Spinner
    ui/icons.jsx           17 inline SVG icons (no icon font, no network)
    auth/AuthShell.jsx     split-screen shell + success screen
  pages/
    Home  Models  Pricing  Docs  Status  Console  Login  Signup
  styles.css               base tokens + marketing system
  styles/
    background.css         aurora, beams, floor, dots, spotlight, scanline
    string-ui.css          @property --progress, str-* + sui-* kit
    auth.css               auth split screen, responsive + light theme
```

---

## Design

The visual system, colour choices, typography pairing and accessibility rules
came out of the design skills bundled with this project (`ui-ux-pro-max`,
`ui-ux-designer`, `3d-ui`). See **[DESIGN-NOTES.md](./DESIGN-NOTES.md)** for the
queries that were run, what the guidance said, how it was applied, and the list
of defects the screenshot QA pass caught and fixed.

Theme: dark by default, light theme via the header toggle, persisted in
`localStorage["ragestar-theme"]`, with an inline bootstrap script in `index.html` so
there is no flash of the wrong theme.

---

## Notes

- Everything is fictional: providers, latencies, prices, log lines.
- No analytics, no cookies, no outbound requests except fonts and the optional
  String Tune script.
- `dist/qa-*.html` are screenshot harness pages (forced theme, cleared session,
  animations disabled). Delete them before shipping — they are not referenced by
  the app.

---

## v5.4 — API key creation fixed + credit system

**Apply the SQL first:** open the Supabase dashboard → SQL editor, paste
`supabase/upgrade-v5.4.sql`, press Run. It is idempotent and safe to re-run.
Then redeploy the gateway (`supabase functions deploy router --no-verify-jwt`)
and rebuild the frontend (`npm run build`).

### 1. Why key creation was failing

`create_api_key` returns a table whose first column is `id`, and its body did:

```sql
if (select status from public.profiles where id = v_user) = 'suspended' then
```

Postgres cannot tell whether that `id` is the OUT parameter or
`profiles.id`, so it aborted every call with
`column reference "id" is ambiguous` — before the insert ever ran. The console
showed the failure as a generic error, so nothing appeared in the key list.

The rebuilt function qualifies every column (`pr.id`, `k.id`), mints the secret
from `gen_random_uuid()` hashed with the built-in `sha256()` instead of relying
on `pgcrypto` in the `extensions` schema, and creates a missing profile row
instead of erroring. The keys tab now also shows the exact database message
inline in the create form rather than swallowing it.

### 2. Credits

A prepaid USD balance per account, enforced at the gateway:

| Where | What you get |
| --- | --- |
| Console → **Credits** | balance, burn rate, runway, low-balance warning, full ledger |
| Admin → **Credits** | outstanding/granted/consumed totals, add · deduct · set balance, per-account balances, workspace-wide ledger |
| Admin → **Settings** | enforce on/off, welcome credit, low-balance threshold, allowed overdraft |
| Gateway | `402 insufficient_credits` when exhausted, plus `x-rs-credits-usd` and `x-rs-credits-remaining` response headers |

Balances live on `profiles.credit_balance_usd` and can only move through audited
functions — a trigger blocks direct writes, and every movement is a row in
`credit_ledger` (signup grant, admin grant/deduct, usage, refund, adjustment).
Usage is debited automatically as each request is logged, so the balance always
matches the request log.

Enforcement ships **off**: install the SQL, check the balances, then turn it on.


## v5.9 — referrals, folder-tree keys/models, admin account recovery

Two deploy steps, in order:

```bash
# 1. run in the Supabase SQL editor (idempotent, safe to re-run)
#    supabase/upgrade-v5.9-referrals.sql

# 2. deploy the recovery function
supabase functions deploy admin-account --no-verify-jwt
```

### Referrals

Every profile gets a 7-character code and a link: `/#/signup?ref=CODE`.
The code is read from the URL on signup, held in `sessionStorage`, and passed
through `options.data.referral_code`. A trigger on `auth.users` records the
referral and, when credits are installed, grants the inviter reward and invitee
bonus. The trigger swallows its own errors so a bad code can never block a
signup.

- Console → **Referrals**: the user's link, code, counts and invitee list.
- Admin → **Referrals**: programme settings (on/off, reward, bonus, cap,
  grant on signup or manually) plus approve/void on each row.

### Keys and models as folders

`src/components/ui/Tree.jsx` is a small explorer: folders on the left, detail
panel on the right. Keys are filed under `keys/live/` and `keys/test/`; models
are filed by the prefix of their public id (`models/rs/`, `models/gpt/`, …).

### Admin account recovery — no password reading

Passwords are bcrypt hashes in `auth.users.encrypted_password`. They are
one-way, so no admin screen can show a user's password; the app also refuses to
store plaintext to work around that. Admin → Users → **Recover** instead gives:

- a one-time password reset link,
- a temporary password (shown once, kills every session),
- force sign-out of all sessions,
- read-only facts: has a password, last change, last sign-in, live sessions,
  providers, email confirmed.

All four are written to `audit_logs` against the acting admin.

---

## v6.0 — minimal UI, file system, response deadlines, key rotation

### 1. Run the migration

```sql
-- Supabase SQL editor, or: psql "$DATABASE_URL" -f supabase/upgrade-v6.0-timeouts.sql
```

It is idempotent, so running it twice is safe. It adds:

| Where | Columns |
| --- | --- |
| `app_settings` | `default_timeout_ms`, `max_key_attempts`, `retry_on_timeout`, `key_cooldown_seconds` |
| `upstreams` | `max_key_attempts`, `retry_on_timeout` (null = inherit workspace) |
| `models` | `timeout_ms`, `max_key_attempts` (null = inherit provider) |
| `upstream_keys` | `timeout_count`, `last_timeout_at`, `cooldown_until` |
| `request_logs` | `attempts`, `keys_tried`, `timed_out`, `timeout_ms` |

### 2. Redeploy the gateway

```bash
npm run fn:deploy      # or: supabase functions deploy router --no-verify-jwt
```

The router now aborts a call when the deadline passes and immediately retries
the same provider with the **next available key**, so a single stalled key no
longer costs the request. Response headers report what happened:
`x-rs-attempts`, `x-rs-keys-tried`, `x-rs-timeout-ms`. If every key stalls the
caller gets `504 upstream_timeout`.

### 3. How a deadline is chosen

```
model.timeout_ms  ->  upstream.timeout_ms  ->  app_settings.default_timeout_ms
```

The same fallback applies to `max_key_attempts` (how many keys of one provider
may be tried) and `retry_on_timeout` (whether a stall is allowed to rotate at
all). A key that stalls is rested for `key_cooldown_seconds` before it is
offered again, and is skipped while cooling as long as another key is ready.

### 4. Where to set it

`#/admin?tab=routing` — **Routing & deadlines**: workspace defaults, a provider
table and a model table, all editable inline.
`#/admin?tab=files` — **File system**: `providers/<slug>/{config,keys,models}`
as a tree, with a detail pane per file (reveal/pause/cooldown for keys,
wait time for a provider or a single model).

## v7.0 — interaction layer + automatic key checks

### 1. The landing screen fix

`src/pages/Home.jsx` rendered `<CtaArcs />` without importing it, so the route
threw `ReferenceError: CtaArcs is not defined` and `ErrorBoundary` replaced the
whole screen with "This view hit an unexpected error." The usage is gone — it
also carried a `<linearGradient>`, which this theme does not use.

All ten routes now render with an empty console: `#/`, `#/models`, `#/pricing`,
`#/docs`, `#/status`, `#/login`, `#/signup`, `#/reset`, plus the `#/console`
and `#/admin` sign-in gates.

### 2. Interaction layer — `src/styles/interactive.css`

Imported last from `src/main.jsx` so it can answer whatever the theme already
painted. Flat colour only; there is no `gradient(` anywhere in the file.

- controls lift 1px on hover, press to 0.985 scale, and show a
  `:focus-visible` ring built from `--primary-soft`
- cards (`.rr-step`, `.rr-panel`) lift 2px and tint their icon plate
- links grow an underline and nudge their arrow; copy buttons flash `.is-copied`
- landing stats count up once on first paint (`useCountUp`)
- table rows take an inset accent on their **first cell** — a
  `border-collapse` `<tr>` cannot paint its own `box-shadow`
- the landing "request path" is a real stepper: click, hover or keyboard-focus
  a stage to swap the detail line (`aria-pressed`, `aria-live`)

Scroll reveals live in `src/lib/interactive.js` behind the **`data-rv`**
attribute — deliberately *not* `data-reveal`, because the older
`[data-reveal]` block in `src/styles.css` holds `opacity: 0` and
`translateY(24px)` until a `.rv-in` class arrives, which this system never adds.
Reveals are armed by the script itself, late DOM is picked up by a
`MutationObserver`, and a sweep at 2.5s reveals anything the observer missed, so
content can never be left permanently invisible. Everything flattens under
`prefers-reduced-motion` except loading spinners.

### 3. Key watch — a pass every 15 seconds

`src/components/KeyWatch.jsx`, at the top of `#/admin?tab=keys`:

- one pass every **15s** by default; 30s, 1m and 5m are also offered, with a
  progress bar to the next pass and a live working/failing summary
- each pass calls the `admin-check-keys` edge function exactly as the manual
  **Test all keys** button does, so every key gets a real upstream request and a
  row in `upstream_key_checks`, then the key table and dashboard refresh
- passes never overlap, the countdown holds while the browser tab is hidden,
  and it auto-pauses after 3 consecutive failed passes
- on/off state and interval persist in `localStorage` under `ragestar-keywatch`

It runs while that tab is open — nothing is scheduled server-side, so closing
the console stops the checks.

## v11 — server-side key watch, ponytail compression, a real dashboard

**The key watch left the browser.** Until v11 the 15-second key check was a
`setInterval` in the admin tab: keys were watched only while someone was
watching them. It now runs in `supabase/functions/keywatch`, claimed through a
row lock in Postgres so overlapping schedulers cannot double-check, driven by a
one-minute `pg_cron` job in the same database that fires four spaced passes per
invocation.
Scheduled results are recorded with `source = 'cron'`, so manual checks stay
legible. The panel card switches it on, shows the countdown, and says plainly
when the beat has gone quiet. Setup: [KEYWATCH.md](KEYWATCH.md).

**Ponytail compression.** The existing stages rewrite one message at a time,
which cannot help the thing that actually grows: the history. A ponytail keeps
the system prompt, the first few turns and the last turns intact, then folds
everything in the middle into a keyword digest — optionally holding back names,
numbers, prices, ids and urls so the model still has the facts. Same engine in
the browser preview and in the router, so what the tab shows is what ships.

**A dashboard instead of seven tiles.** Overview became Operations → Dashboard:
key health per upstream, traffic and latency percentiles, the last failures in
words, and the audit tail — all from data the panel already loads. The fifteen
flat tabs are grouped into seven sections with a search box that jumps to them,
and heavy tables have filter bars that remember what you set.

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v11.0-keywatch-and-ponytail.sql
npm run fn:keywatch
npm run keywatch:migrate     # v11.3: the schedule moved into Postgres
```

A database that has not run the upgrade keeps working: the compressor editor
hides the ponytail fields and the watch card explains which file to run.

---

## v12.4 — early access roles and gated models

An account used to be `user` or `admin`, and every published model was visible
to everybody. v12.4 adds a third role, `early_access`, and a per-model tier, so
a model can go out to that group before it goes out to the workspace.

**One role, one flag.** Admin → Users has a role select where the *Make admin*
button used to be: user, early access, admin. Admin → Models grows an *Access*
column — a chip you click, plus a select in the mapping form — that moves a
single model between *everyone* and *early access only*, with an optional note
("Beta group only") shown beside the locked row. Early access carries no admin
rights; it only widens the catalogue.

**The same answer in all three places.** The public models page, the console
model tree and `/v1/models` read entitlement from the database, not from the
browser, so a gated model cannot be reached by typing its id into a client. The
router checks the key owner's role before routing and returns 403
`early_access_required` when a gated model is named outright; `auto:*` policies
filter the candidate pool before key selection, so failover cannot leak one
either. Per-key `allowed_models` still applies on top of the role.

**Advertised, or invisible.** By default a locked model still appears on the
models page, greyed, with an *early access* chip — usually the point of running
an early access programme. `select public.admin_save_early_access(false);`
hides gated models from anyone without the role instead.

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v12.4-early-access.sql
supabase functions deploy router
```

A database that has not run the migration keeps working: the role select says
which file to run, and nothing is gated because nothing can be marked yet.
Details: [EARLY-ACCESS.md](EARLY-ACCESS.md).


## v12.5 — spend windows: 5-hour and weekly caps

Every account can now have a rolling spend cap: a maximum in any 5-hour window
and a maximum in any 7-day window. Nothing is enforced until you set a number —
0 in either field means unlimited, which is the default, so an upgraded
workspace behaves exactly as before.

**Where it lives.** The two caps are workspace settings
(`app_settings.five_hour_limit_usd`, `weekly_limit_usd`), editable from
Admin → Settings → *Spend windows*. Before every request the router calls
`internal_window_check()` — one round trip that sums your spend inside both
windows and refuses with 429 `five_hour_limit_exceeded` or
`weekly_limit_exceeded` before a token is bought upstream. The refusal carries
the current window spend in `x-rs-five-hour-usd` / `x-rs-weekly-usd` headers,
and the request is logged like any other failure.

**What you see.** The console Overview tab gains a *Spend windows* card: for
each window, how much has been spent, the cap, what is left, and when headroom
returns — i.e. when the oldest charge in that window slides out. If either cap
is 0 the row shows your spend as uncapped.

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v12.5-window-limits.sql
supabase functions deploy router
```

A database that has not run the migration keeps working: the console card says
which file to run, the router skips a check it cannot perform, and the settings
form simply does not show the two fields.


## v12.11 — API keys that can expire

A key can now be given a lifetime when it is created: *Never*, 30 days, 90 days,
one year, or a date you pick. The dashboard's **Create API key** dialog asks for
the name, the expiry, the environment, the scopes and an optional monthly cap,
and the key list shows the date (with an **expired** chip once it has gone by).

**Where it lives.** `api_keys.expires_at` has existed since v5.4 and the router
has always refused an expired key with 401 `API key has expired.` — but nothing
could ever *set* it, so the column was dead weight. `create_api_key()` now takes
`p_expires_at`, and a new `set_api_key_expiry()` moves or clears the date on an
existing key. Both reject a date that is already in the past, so the dialog and
the server agree on what "expired" means.

**The old function is dropped first.** PostgREST picks an RPC by name and named
arguments, so leaving `create_api_key(text, text, numeric)` and the new
four-argument version side by side gives it two candidates and the console fails
with an ambiguity error — the same bug v5.4 fixed. Run the file; it drops and
recreates.

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v12.11-api-key-expiry.sql
```

A database that has not run the migration keeps working: without a date chosen
the dialog never sends `p_expires_at`, so the call still matches the older
three-argument function and keys are minted exactly as before. Only the expiry
feature itself needs the migration.

### Also in this release — the modals sit in the viewport again

`.pr-page-enter` wraps every authenticated screen and animates in with
fill-mode `both`, so its finished frame stayed applied for the life of the
element. That frame was an identity `transform: translate3d(0, 0, 0) scale(1)`
plus `filter: blur(0)` — and an identity transform is still not `none`, so the
wrapper became the **containing block** for every `position: fixed` descendant.
The kit's dialogs are `fixed inset-0`, so they were positioned against that
page-tall wrapper instead of the viewport: the dialog centred far below the
fold and all you could see was the blurred backdrop with no way to finish.
The keyframes now settle on `translate: none` / `scale: none` / `filter: none`,
which hands the containing block back to the viewport. `npm run test:ui` gained
a `FIXED-OVERLAYS` check for it — jsdom has no layout engine, so the render
suites cannot catch this one.

The same pass gave the dialogs an **ink scrim on a paper panel**. The kit's
`ink-950`/`ink-900` tokens are the *light* drafting-paper surfaces, so the old
`bg-ink-950/75` backdrop washed the page white and the `bg-ink-900/95` panel
disappeared into it.


## v12.12 — Discord required, and the brand reads RageStar

**The Discord gate is on.** `upgrade-v12.9-discord-gate.sql` had already built
the switch (`app_settings.discord_required`) and shipped it off, because
turning it on before accounts had linked would 403 every key at once. This
release turns it on and makes *on* the default: from now on the router serves
an account only when it has a linked Discord **that is in the community
server**, otherwise `403 discord_not_linked` / `discord_not_in_server`. Keys
are not deleted and nothing is billed while blocked.

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v12.12-discord-compulsory.sql
```

**And now you can actually comply.** The card that links Discord used to live
on the console's Profile tab, which v12.8 retired with `#/console` — neither
`src/pages/Console.jsx` nor `src/pages/Workspace.jsx` is imported any more, so
the only place that could satisfy the gate was unreachable. It is rebuilt in
the kit's paper theme as
[`src/ragestar/dashboard/DiscordPanel.jsx`](src/ragestar/dashboard/DiscordPanel.jsx)
and mounted first on **Settings**, with the linked account, its username, the
community-server verdict, *Connect Discord* / *Retry server join* / *Disconnect*
and an "API access is paused" banner while non-compliant. The refusal text now
points there instead of at the retired tab.

**Rename.** The product is called RageStar and nothing else now — 490 mentions
across 39 files were changed, and the old name no longer appears anywhere in
the repository. That covers the visible copy (headings, footer, testimonials,
docs) as well as the structural names: the UI-kit directory is `src/ragestar/`,
the console alias is `#/ragestar`, the scoped CSS class is `.ragestar-scope`,
the docs' region header is `X-RageStar-Region`, and the code samples use
`RAGESTAR_API_KEY`, `@ragestar/sdk` and `from ragestar import RageStar`.

Two short prefixes were deliberately left alone: the kit's `pr-*` CSS classes
and the `.pr-`-prefixed animation names. They are abbreviations of a word the
product no longer uses, but renaming them to `rs-*` would collide with the
gateway's existing `rs-*` classes and the real `x-rs-*` response headers.
