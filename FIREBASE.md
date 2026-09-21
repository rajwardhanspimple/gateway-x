# Firebase Authentication (v10)

Authentication now runs on **Firebase Authentication**. Everything else —
profiles, gateway keys, credits, referrals, request logs, RLS policies, RPCs,
the router and the compressor — stays exactly where it was, in **Supabase**.
No data was migrated.

---

## 1. How it works

```
browser                          supabase edge                supabase postgres
───────                          ────────────                 ─────────────────
Firebase sign-in
  (password / Google / link)
        │ Firebase ID token
        ▼
  POST /functions/v1/firebase-auth
        │  verifies the token against Google's public JWKS
        │  finds or creates the matching auth.users row
        │  mints a short-lived Supabase JWT (HS256, your JWT secret)
        ▼
access_token ──────────────────────────────────────────────►  RLS sees the
                                                               same auth.uid()
                                                               as before
```

Why a bridge instead of pointing Supabase at Firebase directly: your schema has
27 policies built on `auth.uid()` and `profiles.id uuid references auth.users`.
The bridge keeps all of that untouched — the token the database receives is
indistinguishable in shape from a GoTrue one.

**What changed**

| Area | Before | Now |
| --- | --- | --- |
| Sign in / sign up | Supabase GoTrue | Firebase |
| Google sign-in | not available | popup or redirect |
| Magic link | `signInWithOtp` | Firebase email link |
| Password reset | recovery session | one-time `oobCode` on `#/reset` |
| Session token | GoTrue JWT | bridge-minted JWT, same claims |
| Database, RLS, keys, credits | Supabase | **unchanged** |

---

## 2. Firebase console

1. Create (or open) a project → **Authentication → Get started**.
2. **Sign-in method**: enable **Email/Password** (tick *Email link* too if you
   want magic links) and **Google**.
3. **Settings → Authorized domains**: add `ragestar.bond`, plus `localhost` for
   development.
4. **Templates → Password reset → Customise action URL**: point it at
   `https://ragestar.bond/#/reset`. Do the same for the email-link template if
   you enabled it. Without this the link lands on Firebase's own page and the
   app never sees the code.
5. **Project settings → Your apps → Web app**: copy the config values.

---

## 3. Frontend env

Fill these in `.env` (already stubbed in `.env.example`):

```dotenv
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_APP_ID=1:...:web:...
VITE_FIREBASE_MESSAGING_SENDER_ID=      # optional
VITE_FIREBASE_STORAGE_BUCKET=           # optional
VITE_FIREBASE_BRIDGE_FN=firebase-auth   # edge function name
VITE_GOOGLE_SIGNIN_MODE=popup           # popup | redirect
```

The existing `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GATEWAY_URL`
and `VITE_SITE_URL` stay as they are. If the Firebase keys are missing, the auth
pages show a setup notice instead of failing silently.

Use `redirect` mode if popups are blocked in your environment; `popup` gives the
better experience and is the default.

---

## 4. Supabase secrets

`JWT_SECRET` is the **Legacy JWT secret** from *Project settings → API
→ JWT keys*. It is what lets the bridge mint tokens your database trusts.

```bash
supabase secrets set \
  FIREBASE_PROJECT_ID=your-project \
  JWT_SECRET=<legacy jwt secret> \
  FIREBASE_REQUIRE_VERIFIED_EMAIL=true \
  SESSION_TTL_SECONDS=3600 \
  ALLOWED_ORIGINS="https://ragestar.bond,http://localhost:5173"
```

| Secret | Default | Meaning |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | — | required; the token audience that will be accepted |
| `JWT_SECRET` | — | required; signs the minted session token. `SUPABASE_JWT_SECRET` is still read as a fallback, but `supabase secrets set` rejects names starting with `SUPABASE_`, so set it as `JWT_SECRET` |
| `FIREBASE_REQUIRE_VERIFIED_EMAIL` | `true` | refuse unverified email/password accounts |
| `SESSION_TTL_SECONDS` | `3600` | minted token lifetime, clamped to 5–60 min |
| `ALLOWED_ORIGINS` | — | CORS allowlist shared by every function |

`SUPABASE_URL` and the service-role key are injected by the platform.

---

## 5. Database migration

Run `supabase/upgrade-v10.0-firebase-auth.sql` in the SQL editor. It is additive
and safe to re-run:

- adds `profiles.firebase_uid text` with a unique index, so a Firebase account
  maps to exactly one profile;
- relaxes the signup trigger so bridge-created users get a profile row the same
  way GoTrue users did;
- keeps `email_domain_allowed()` and the allowed-domain rule intact.

Nothing is dropped and no rows are rewritten.

---

## 6. Deploy

```bash
npm install                                        # pulls firebase ^11
supabase functions deploy firebase-auth --no-verify-jwt
supabase functions deploy admin-account   --no-verify-jwt
supabase functions deploy admin-check-keys --no-verify-jwt
npm run build
```

`--no-verify-jwt` matters for `firebase-auth`: it is called *before* a Supabase
session exists. The two admin functions are redeployed because their admin gate
now verifies bridge-minted tokens locally (same rule as before: `role = 'admin'`
and `status = 'active'`).

> Not verified here: this sandbox has no network access, so `npm install` and
> `vite build` could not be run. Every changed file was parsed offline, but run
> the build once locally before deploying.

---

## 7. Existing users

Password hashes cannot be read out of Supabase, so existing accounts have three
paths:

1. **Password reset** (simplest): users click *Forgot password?* once; the
   Firebase account is created on first successful sign-in and linked to their
   existing profile by email.
2. **Google sign-in**: same email → same profile row, no reset needed.
3. **Bulk import**: `firebase auth:import` accepts bcrypt hashes if you can
   export them with the service-role key. Only worth it above a few hundred
   users.

Linking is by email, so a returning user keeps their keys, credits, referrals
and history.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| “Could not confirm your session” with a retry button | bridge unreachable or `JWT_SECRET` missing | check `supabase functions logs firebase-auth` |
| `not_configured` | `FIREBASE_PROJECT_ID` or JWT secret not set | set the secrets, redeploy |
| `email_unverified` | unverified email/password account | verify, or set `FIREBASE_REQUIRE_VERIFIED_EMAIL=false` |
| `domain_blocked` | `app_settings.allowed_email_domains` excludes the address | edit that row in the admin panel |
| Popup closes instantly | popup blocked, or COOP header | `public/_headers` already sends `same-origin-allow-popups`; otherwise use `VITE_GOOGLE_SIGNIN_MODE=redirect` |
| Reset link says “no longer valid” | code already used, or expired after 1 hour | request a new link |
| Every admin action fails with *Your session is not valid. Sign in again, then retry.* | the admin functions cannot read the JWT secret, so they fall back to GoTrue - which always refuses bridge-minted tokens, because those have no `auth.sessions` row | `supabase secrets set JWT_SECRET="<legacy jwt secret>" FIREBASE_PROJECT_ID=<firebase project id>` then `npm run fn:deploy` |
| Admin panel returns 403 after sign-in | profile row is not `admin`/`active` | the gate screen names the exact cause |
| Console loads but tables are empty | minted token rejected by RLS | confirm the JWT secret is the *legacy* one, not an anon key |

---

## 9. Rollback

The Supabase auth stack was never removed. To go back: restore the previous
`src/lib/auth.js`, `src/lib/db.js` and the two admin functions from v9, then
redeploy. The `firebase_uid` column can stay — it is ignored by v9.

---

## 10. The alternative we did not take

Supabase's native third-party auth would remove the bridge function, but it
requires `profiles.id` to become `text` (Firebase UIDs are not UUIDs) and all 27
`auth.uid()` policies to be rewritten against a JWT claim. That is a data
migration — exactly what you asked to avoid. The bridge keeps the blast radius
to the auth layer, and it can be swapped for the native route later without
touching the UI.
