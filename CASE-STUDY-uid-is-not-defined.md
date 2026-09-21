# Case study — "Action failed: uid is not defined"

RageStar v10.0.0 · `supabase/functions/admin-check-keys/index.ts` · fixed

---

## 1. What this system is

RageStar is an OpenAI-compatible AI gateway: you store other providers' API keys,
publish your own model ids, and resell traffic through one endpoint.

| Layer | What it is | Where |
|---|---|---|
| Front end | Vite + React 18 SPA, hash router (`#/console`, `#/admin`) | `src/` |
| Auth (v10) | Firebase Auth proves identity, an Edge Function swaps the Firebase ID token for a **Supabase-signed** JWT | `src/lib/firebaseBridge.js`, `supabase/functions/firebase-auth` |
| Data | Postgres + RLS + `security definer` RPCs | `supabase/schema.sql` |
| Gateway | `router` Edge Function: auth key -> route -> upstream -> log/price | `supabase/functions/router` |
| Admin tools | `admin-check-keys`, `admin-account` | `supabase/functions/` |
| Edge | Cloudflare Worker in front of `gw.ragestar.bond` | `cloudflare/worker.js` |

The service-role key never leaves the Edge Functions. The browser only ever
holds a short-lived user JWT, so anything privileged is a function call.

## 2. How a "Test every key" click travels

1. `src/pages/Admin.jsx` -> `testUpstreamKeys({})` (`src/lib/db.js`).
2. `callAdminFn` POSTs `{ action: "check" }` to
   `${SUPABASE_URL}/functions/v1/admin-check-keys` with three headers:
   `apikey` (past Supabase's edge gateway), `authorization: Bearer <minted JWT>`,
   and `x-firebase-token` (the raw Firebase ID token as a fallback identity).
   A 401/403 is retried once with a freshly minted session.
3. The function answers the CORS preflight, parses the body (256 KB cap),
   short-circuits `ping`, then runs the **admin gate**.
4. For each active stored key it calls the upstream's models/health endpoint and
   writes the outcome through the RPC `internal_record_key_result`, which updates
   `upstream_keys.status` and appends a row to `upstream_key_checks`.
5. It writes one `audit_logs` row for the whole pass and returns
   `{ action, checked, results }`.

`src/components/KeyWatch.jsx` calls the exact same path automatically every
15 s while the Upstream keys tab is open, pausing after three failed passes.

## 3. The admin gate (v10)

`requireAdmin` in `supabase/functions/_shared/firebase.ts` tries three identities
in order and returns `AdminCaller = { id, email, role, via }`:

1. **Supabase-signed bearer** — verified locally against every known secret name
   (`JWT_SECRET`, `SUPABASE_JWT_SECRET`, ...). Local verification is required
   because bridge-minted tokens have no row in `auth.sessions`, so
   `auth.getUser()` would reject a perfectly valid token.
2. **Raw Firebase ID token** (`x-firebase-token`) — RS256 + Google JWKS, mapped
   to a profile by `firebase_uid`, then by `email`.
3. **Classic GoTrue session** — for pre-v10 sessions.

The decision itself never changed: `profiles.role = 'admin'` AND
`profiles.status = 'active'`, the same rule `public.is_admin()` enforces in RLS.

## 4. Root cause

The gate was called for its side effect only — the return value was thrown away:

```ts
try {
  await requireAdmin(req, admin as never, { ... })   // <- result discarded
} catch (err) { /* 401/403 */ }
```

but two audit writes later in the same function referenced a variable that was
never declared anywhere in the file:

```ts
await admin.from("audit_logs").insert({
  actor_id: uid,                    // line 579, scan_upstream_models
  ...
})

await admin.from("audit_logs").insert({
  actor_id: uid,                    // line 672, check_upstream_keys
  ...
})
```

`uid` is not a parameter, not a `const`, not an import, not a global. In an ES
module this is a hard `ReferenceError: uid is not defined` at the moment the
line executes.

The sibling function `admin-account/index.ts` already does it correctly
(`const actor = await requireAdmin(req)` then `actor.id` / `actor.email`), which
is what the fix mirrors.

## 5. Why the raw JS message reached your screen

```ts
Deno.serve(async (req) => {
  try { return await handle(req) }
  catch (err) {
    const message = String((err as Error)?.message ?? err)
    return apiError(message.slice(0, 400), 500, "server_error", {}, req)
  }
})
```

The outer wrapper exists so every failure still carries CORS headers. It also
forwards the raw message. `db.js` then throws `payload.error.message`, and
`Admin.jsx` renders it under the heading **Action failed** — so a JavaScript
`ReferenceError` was displayed verbatim as a product error.

## 6. Blast radius

| Action | Effect |
|---|---|
| `check` (Test every key / Test keys / KeyWatch) | Always failed. The audit write is unconditional and sits *after* the loop. |
| `scan` / `scan_models` | Failed whenever the upstream was a stored one (`upstream.id` set). |
| `probe` / `test`, `ping` | Unaffected — no audit write on those paths. |

Important detail: the key checks **did** complete. `internal_record_key_result`
ran for every key before the crash, so `upstream_keys.status`, latencies and
check history were all updated correctly — then the response was thrown away and
replaced with a 500. The panel said everything failed while the database said
otherwise, and KeyWatch pushed the whole thing back through every 15 seconds.

## 7. The fix

Three changes in `supabase/functions/admin-check-keys/index.ts`:

1. **Keep the gate's answer.**

```ts
let caller: AdminCaller
try {
  caller = await requireAdmin(req, admin as never, {
    jwtSecret: JWT_SECRET,
    firebaseProjectId: FIREBASE_PROJECT_ID,
  })
} catch (err) { /* unchanged 401/403 handling */ }
```

2. **Use the real identity** in both audit writes — `caller.id` and
   `caller.email` (`audit_logs` has an `actor_email` column, and the Audit tab
   renders it, so the trail is now attributable instead of anonymous).

3. **Make audit writes non-fatal.** A new `logAudit()` helper swallows and logs
   insert failures, so a logging problem can never again discard a completed key
   check:

```ts
async function logAudit(row: Record<string, unknown>) {
  try {
    const { error } = await admin.from("audit_logs").insert(row)
    if (error) console.error("audit_logs insert failed:", error.message)
  } catch (err) {
    console.error("audit_logs insert threw:", String((err as Error)?.message ?? err))
  }
}
```

The `check` pass now also records `via` (`supabase` | `firebase` | `gotrue`), so
the audit row shows which of the three identity paths let the caller in.

Nothing else was touched: no schema change, no front-end change, no behaviour
change to routing, probing or scanning.

## 8. Verification

A whole-project type-check for undeclared identifiers (`TS2304`) across every
Edge Function, `src/`, `scripts/` and the Worker:

- before: 2 hits, both `Cannot find name 'uid'` (lines 579 and 672)
- after: 0 hits

`grep -rn "actor_id: uid"` now returns nothing. CRLF line endings preserved.

## 9. Deploy

```bash
supabase functions deploy admin-check-keys --no-verify-jwt
# or all four: npm run fn:deploy
```

The `--no-verify-jwt` flag matters: with platform JWT verification on, Supabase
rejects the browser's header-less CORS preflight before your code runs, which
surfaces as the useless "Failed to fetch". No front-end rebuild is needed —
nothing in `src/` changed.

After deploying: open **Admin -> Upstream keys -> Test every key**. You should
get "Checked N keys", and **Admin -> Audit trail** should show a
`check_upstream_keys` row attributed to your email.

## 10. Prevention

This is the third bug of the same shape in this codebase — v7.0 fixed
`ReferenceError: CtaArcs is not defined` in `Home.jsx`, and the React error
boundary was added because of it. Undeclared identifiers are free to catch:

- Add a pre-deploy gate: `deno check supabase/functions/**/*.ts`, wired into
  `fn:deploy` so a typo cannot reach production.
- Add ESLint with `no-undef` for `src/` (JSX has no compiler pass today).
- Treat "the function returns a value you ignore" as a smell: `requireAdmin`
  returning `AdminCaller` was the hint that the caller identity was meant to be
  used.
- Keep side-effect writes (audit, telemetry) out of the success path, as
  `logAudit()` now does.
