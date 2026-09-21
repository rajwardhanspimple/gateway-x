# Key watch (v11)

Until v11 “watch my keys” meant a `setInterval` in the admin’s browser. Close
the tab and the watching stopped — which is precisely when you want to know a
key has expired. v11 moves the beat to the server and leaves the browser loop
in place only as a fallback.

```
pg_cron inside Supabase (once a minute)
        │  pg_net POST  x-keywatch-secret
        ▼
supabase/functions/keywatch          ← 4 spaced passes per invocation
        │  rpc internal_keywatch_due()      ← claims the pass (row lock)
        │  probe each key’s upstream        ← 5 at a time
        │  rpc internal_record_key_result() ← source = 'cron'
        └─ rpc internal_keywatch_record_run()
                 │
                 ▼
        admin panel → admin_keywatch_status()
```

## 1. Database

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v11.0-keywatch-and-ponytail.sql
```

Adds the settings columns on `app_settings`, the `keywatch_runs` log, the
claim/record/prune functions, the two admin RPCs, and the ponytail columns on
`token_compressors`. Safe to run twice.

## 2. Edge function

```bash
supabase functions deploy keywatch --no-verify-jwt
supabase secrets set KEYWATCH_CRON_SECRET="$(openssl rand -hex 32)"
```

`--no-verify-jwt` is required: the caller is a scheduler with no user session.
The function’s own gate accepts either the `x-keywatch-secret` header or the
service-role key as a bearer token, and rejects everything else with 403.

## 3. Scheduler — `pg_cron`, in the same database

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v11.3-keywatch-in-postgres.sql
psql "$DATABASE_URL" -f supabase/upgrade-v11.3b-selftest-pg-cron.sql
# or both at once:  npm run keywatch:migrate
```

Then, once, in the Supabase SQL editor (as `postgres` — `keywatch_schedule` is
revoked from `anon` and `authenticated` on purpose, because it takes the
secret as an argument):

```sql
select public.keywatch_schedule(
  'https://<project-ref>.supabase.co/functions/v1/keywatch',
  '<the same value as KEYWATCH_CRON_SECRET>',
  '* * * * *',   -- cron expression
  4,             -- passes per invocation
  15000          -- ms between passes
);
```

The job fires once a minute; each invocation runs 4 passes 15 s apart, so the
effective beat is 15 seconds without a sub-minute scheduler. **That is where
the 15 seconds comes from — not from cron.** Every one of those passes has to
be granted by `internal_keywatch_due()`, which refuses any pass sooner than
`keywatch_interval_seconds`, so if that setting is 60 then passes 2, 3 and 4
are refused and you silently get a once-a-minute beat that still reports
healthy. Keep the interval at 15 to match the spacing.

Requires the `pg_cron` and `pg_net` extensions. On hosted Supabase enable them
under **Database → Extensions** before running the migration.

To stop the beat: `select public.keywatch_unschedule();`
To see what it did: `select public.keywatch_cron_log(10);`

## 4. Switch it on

Admin → **Operations → Dashboard** → the *Key watch* card. Toggle the server
beat, pick an interval (15 s – 1 h) and a batch size. Both are clamped again
in Postgres, so a typo in the panel cannot ask for a one-second beat across
every key you own.

## Behaviour worth knowing

- **No double-checking.** `internal_keywatch_due()` takes a row lock on the
  settings row and stamps the claim inside the same transaction, so two
  overlapping invocations cannot both run a pass. The stamp is written before
  the work, so a worker that dies mid-pass costs one interval, not a lock.
- **Fairness.** Each pass takes the `batch_size` keys with the oldest
  `last_checked_at` first, so no key starves however large the estate grows.
- **A pass is 10% early-tolerant.** Cron minutes drift; refusing a pass half a
  second early would halve the real rate.
- **History is bounded.** Roughly one pass in fifty prunes `upstream_key_checks`
  rows with `source = 'cron'` and `keywatch_runs` older than
  `keywatch_retention_days` (7 by default). No second scheduler needed.
- **Scheduled checks are labelled.** They are written with `source = 'cron'`,
  so the manual checks you ran by hand stay legible in the history.
- **“Check now” in the panel is not this function.** It goes through
  `admin-check-keys`, which already holds the admin gate — the browser is never
  given the cron secret.

## When the light goes amber

The card calls the beat *stalled* when the switch is on but nothing has landed
for three intervals. In order of likelihood:

1. `keywatch_schedule()` was never called, or the job was unscheduled —
   `select * from cron.job where jobname = 'ragestar-keywatch';` is empty.
   (Applying the migration does **not** start the beat; that call does.)
2. The secret given to `keywatch_schedule()` no longer matches
   `KEYWATCH_CRON_SECRET` in Supabase — the function answers 403, and
   `select public.keywatch_cron_log(10);` shows the 403 against each firing.
3. The function is deployed *with* JWT verification, so the scheduler’s
   request is rejected before it reaches the secret check.
4. `app_settings` has no row with `id = 1`; the claim returns
   `app_settings row 1 is missing`.

`GET /functions/v1/keywatch` answers without auth and reports whether the
function is deployed and whether the secret is set — the fastest way to tell
(1) from (2).

---

## v11.1 — read this if the card says “last pass never”

The v11.0 instructions above are correct but incomplete: they never say that
`keywatch` must be deployed **with JWT verification off**. Without that,
Supabase answers the scheduler `401` before the function runs, no pass is ever
recorded, and the admin card sits on amber `stalled` forever — even though the
cron is firing perfectly.

Full explanation, the ordered commands, and how to read every status code:
**`KEYWATCH-FIX.md`**.

Short version:

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v11.1-keywatch-repair.sql
supabase functions deploy keywatch --no-verify-jwt      # ← the fix
supabase secrets set KEYWATCH_CRON_SECRET="$(openssl rand -hex 32)"
npm run keywatch:migrate                                # v11.3 pg_cron schedule
npm run keywatch:doctor
```

…then start the beat once from the SQL editor, as shown in section 3.

New self-checks in v11.1:

* `npm run keywatch:doctor` — checks all four links and stops at the first
  broken one with the command that fixes it.
* `select public.keywatch_cron_log(10);` — every firing of the schedule with
  the HTTP status and body the function answered. Never prints a secret.
* `select public.admin_keywatch_selftest();` — the database's own verdict,
  including whether recent passes came from cron or only from a browser tab.
* **Diagnose** button on the Key watch card itself.

---

## v11.3 — the scheduler moved into Postgres

The Cloudflare cron worker is gone. `cloudflare/keywatch-worker.js` and
`cloudflare/wrangler.keywatch.toml` are deleted, `npm run cron:deploy` no
longer exists, and `wrangler` is no longer needed for the key watch at all.
(The unrelated gateway worker in `cloudflare/` stays.)

**Why.** The worker's entire job was one POST a minute, and for that it split
the system across two accounts that could not see each other. The schedule
lived in Cloudflare; the evidence of whether the schedule worked lived in
Postgres; no dashboard showed both. That is exactly the shape of the v11.0
outage above — `wrangler deploy` exits 0 and the Cloudflare cron reads healthy
whether the function 401s, 403s, or was never deployed. With `pg_cron` the
schedule is a row in `cron.job` in the same database as `keywatch_runs`, so one
query answers both halves, and `admin_keywatch_selftest()` can finally
distinguish "nothing is scheduled" from "the schedule is being refused".

**What changed**

| | v11.2 | v11.3 |
| --- | --- | --- |
| Scheduler | Cloudflare cron worker | `pg_cron` job `ragestar-keywatch` |
| Caller | `fetch` in the worker | `pg_net` `http_post` |
| Start it | `npm run cron:deploy` | `select public.keywatch_schedule(url, secret);` |
| Stop it | delete the worker | `select public.keywatch_unschedule();` |
| Read the log | `wrangler tail ragestar-keywatch` | `select public.keywatch_cron_log(10);` |
| Secrets to keep in sync | 2 (`KEYWATCH_URL`, `KEYWATCH_SECRET`) | 0 — passed once as arguments |

**Migrating from v11.2**

```bash
npm run keywatch:migrate                # applies v11.3 + v11.3b
supabase functions deploy keywatch --no-verify-jwt
# then in the SQL editor, as postgres:
#   select public.keywatch_schedule('https://<ref>.supabase.co/functions/v1/keywatch',
#                                   '<KEYWATCH_CRON_SECRET>', '* * * * *', 4, 15000);
npm run keywatch:doctor                 # should now print a pg_cron schedule line
npx wrangler delete ragestar-keywatch   # retire the old worker
```

Leaving the old worker running is harmless but untidy: `internal_keywatch_due()`
holds a row lock, so the duplicate pass is refused rather than double-checking
keys — it just adds noise to the audit trail.

**Two things v11.3's own migration gets wrong**, both fixed by
`upgrade-v11.3b-selftest-pg-cron.sql`:

1. It clamps `keywatch_interval_seconds` up to 60, which refuses passes 2–4 of
   every minute and turns the 15-second beat into a 60-second one while still
   reporting healthy. v11.3b puts the floor back to 15.
2. `keywatch_cron_log()` is granted to `service_role` but gated on
   `is_admin()`, which is false for the service role — so every server-side
   script got `admins only` from the one function written to explain outages.
   v11.3b widens the gate the same way `admin_keywatch_selftest()` does.

`npm run test:keywatch` now asserts both.
