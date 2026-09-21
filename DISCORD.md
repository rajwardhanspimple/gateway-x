# Discord sign-in, connect and guild join (v12.6)

Discord works as a **custom OAuth2 flow that ends as an ordinary Firebase
sign-in**. Firebase Authentication has no Discord provider, so the
`discord-auth` Edge Function runs the OAuth handshake server-side (the client
secret and bot token never touch the browser), mints a Firebase **custom
token**, and the browser finishes with `signInWithCustomToken`. Everything
downstream — the `firebase-auth` bridge, the Supabase JWT, all 27 RLS
policies, credits, keys, referrals — is untouched.

---

## 1. How it works

```
browser                         supabase edge                 discord / google
───────                         ────────────                  ────────────────
POST /functions/v1/discord-auth {action:"start"}
      │  signed state (HMAC, 10 min) + authorize URL
      ▼
discord.com/oauth2/authorize  (scope: identify email guilds.join)
      │  redirect to <site root>/?code=…&state=…
      ▼
POST /functions/v1/discord-auth {action:"exchange"}
      │  verifies the HMAC state
      │  swaps the code for a Discord token (client_secret server-side)
      │  GET /users/@me → verified email + domain gate (app_settings)
      │  finds or creates the auth.users row (same rules as the bridge)
      │  upserts public.discord_identities
      │  PUT /guilds/{id}/members/{user} with the bot token (non-fatal)
      │  pays the one-time join credit (v12.7, once per account)
      │  mints a Firebase custom token (service-account RS256, WebCrypto)
      ▼
signInWithCustomToken() ──▶ onIdTokenChanged ──▶ firebase-auth bridge
                                                   mints the Supabase JWT
```

**Connect** (Profile tab) is the same trip with `mode: "connect"`: the state
is bound to the caller's uid and the caller's session rides along, so a
Discord identity can never be grafted onto someone else's account.

**Guild join** uses the `guilds.join` scope plus a bot token:
`PUT /guilds/{DISCORD_GUILD_ID}/members/{discord_user_id}` with the user's own
OAuth access token in the body. `201` = joined, `204` = already a member. Any
other outcome is recorded as `guild_member = false` and **never blocks the
sign-in** — the Profile tab shows a Retry button that re-runs the connect
flow. A confirmed join also pays the one-time join credit (section 5).

---

## 2. Discord developer portal

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2 → General**: copy the **Client ID** and **Client Secret**.
3. **OAuth2 → Redirects**: add `https://ragestar.bond/` and
   `http://localhost:5173/` — trailing slash included, no `#` path. The
   redirect is always the site root because OAuth URIs cannot carry a hash.
4. **Bot → Reset Token**: copy the bot token. No privileged gateway intents
   are needed — the bot only ever calls *add guild member*.
5. Invite the bot to your server (it needs no permissions, only membership):
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot
   ```
6. Copy the guild id: Discord client → User Settings → Advanced → Developer
   Mode on → right-click the server → **Copy Server ID**.

## 3. Firebase service account

Custom tokens are minted server-side **without the Admin SDK** (WebCrypto
RS256, matching `_shared/firebase.ts`), so the function needs a service
account:

1. Firebase console → **Project settings → Service accounts → Generate new
   private key**.
2. From the downloaded JSON take `client_email` and `private_key`.

## 4. Secrets and deploy

```bash
supabase secrets set DISCORD_CLIENT_ID="1550636979928961165" DISCORD_CLIENT_SECRET="21sf8Nm28b6zWJmiI8KPNiz9nxhyQ9-J" DISCORD_BOT_TOKEN="MTU1MDYzNjk3OTkyODk2MTE2NQ.GHbTEX.gJWh4J6fk77BTHnl5BxbBObv4o3Uco3LGHd65A" DISCORD_GUILD_ID="1548317703410946180" DISCORD_REDIRECT_URI="https://ragestar.bond/" DISCORD_STATE_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" FIREBASE_CLIENT_EMAIL="firebase-adminsdk-fbsvc@ragestar-original.iam.gserviceaccount.com" FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCufCFbJhtdA3ja\n2lJXmolIIH4e9kwJw3R3/LOvdKjNYO89wt35RfocT6gfiPy55gBWFTGxdRJBMt6A\nFyxqyK4XzUUQTbQGFnc7D0f7Hhbu/iGSgOMVqcRTPkD7WZKvXx2vdoNU3UvM542B\n2k92dE8hcsBRTiqbC71bHwB+fjg7yAHhbu38Zlk3fcpYMVZweFZE5CcFGJjHilwC\npLaquYQ79LGjLJkvuxNVuJoUQZRQIVvr4Gv77eR9QSwRK8rzWGVvXTN3WFFmLhQR\nYbFOxeawrHrp+T8xsFDhwvGiWoSsLVOT4xOj2sAmyvkWap9uXxMUjbmLVBjsdZfu\nn62O2Sm9AgMBAAECggEACIpPWKaGFtilaPLgLmUEPKlIewv7n0u3jurpwZgAbiMF\nOrznv/x2mD2m4TpDgnbZQ91gNAsipFnQzay0shpV+RjFPV3MRrMBTXz7PTWVEkgS\njRjtZIFNeHSW2iaheR969Lxkg7ocLHCV+sncc1QQjnbPJnugtruNnmDnVYmoh3Z3\nLrlHjoDmChB7NyMFiIaY0Hz8ucktpcMo1okEGvqPRJky077oOaXXEuphYGQXCQm0\nBQqKi8xjgQDTMCttrS4KwHTXzAsNmk/GnJu7uDLqgvO2EtW2qyE/9DLqTJV6anvo\n7kcdItbMepTriue2+Cp8bx0pQP2558mBdqAFkxdEmQKBgQDkWsREOwBoTlzi9vgr\n4int9p+n6HHxiHY+f6Gm6jXf1pjuR/u65oGFirFcT4uUxDrw8QCVBKQMgYxeiDsI\n5ERWLBI65IDy6MfRGgyE7y6l/lkR9NsHMil7mXndMRm9xs27s4g4EsAtBm96b6b3\nWuiWtwoZt63Bpq5sWW+lGfP5VQKBgQDDm9GGzCfeMu2bDiAnOF0vN5ksoTzQoYP/\nDMo6WWklh9FTCF9q+xvZHDcfOH5CVaHmM7Y7xk/x2Wcs8bzBnH+VrW2gdMQfwKqP\n8u+Nn5Cm4THKFB63nyBvNrLS69BjnpQsONtkrbMjyR3k252eY5ejNAbqu7B8D/m1\nMvJdzQjOyQKBgQCZx15ArJMbqxn2Zma99rJR5DGkO27wPvuSHxVXeIYLVVLrtGIb\nfTtgGQRTq+XNq1AeDc5cjCGFooBK8OcAl+hFN6yXKGaGLqjRcf9YTlJVyrFk3EXb\n1LYG3FYq1PQGzyig7MghKs9sAtdz1ljUXs4fIOiWZRGIRZ1Ure33e0DHeQKBgDmb\nmUCOvasV6p5Asb17Pw5Z3HWlYsi62KnztVcr3+iasE446AkUvSXaxm0ecSjOGWk3\nj5LZG9BJS7aT1xhaI8UMF34rBVuonVLZpC1ccfiD1+sAs+82IRI/1LiDlJLSMCc5\n83saIOkIIRK2jxwHjrAU8XiOIDLZbZwsze5MJSzpAoGBAM5tEHuXFOurWzFby4CX\nR6fdrtpskyU3yrqv/sbpH/39MEzoa8uDKdMV2YC6fGjVc0yShUpfNzGgKS6h3x9R\nsG4lyZPvsFGf9eDLI4iEzgyDMbkPnpor9tL58Bvk++FkivGEt/mKEVnm9FzU5EU3\n4UDxmDbxebjPk074IF38KVtX\n-----END PRIVATE KEY-----\n"

supabase functions deploy discord-auth --no-verify-jwt
```

Notes:

- `DISCORD_STATE_SECRET` is optional — the state HMAC falls back to
  `JWT_SECRET`.
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` are optional — without them the
  guild join is skipped and `guild_member` stays `false`.
- `DISCORD_EXTRA_REDIRECTS` (comma-separated) adds redirect URIs beyond the
  production one and the two built-in localhost entries.
- None of these is ever a `VITE_*` variable. The only client-side value is
  the optional `VITE_DISCORD_INVITE_URL` (a plain invite link shown on the
  Profile tab).

## 5. Database

Run `supabase/upgrade-v12.6-discord.sql` in the SQL editor. It creates
`public.discord_identities` (one row per account, `discord_id` unique) with
RLS: the owner reads and deletes their own row; all writes go through the
function with the service role.

Then run `supabase/upgrade-v12.7-announcements-discord-credit.sql`. It adds
the **join credit**: `app_settings.discord_join_credit_usd` (default 50, 0
disables the offer) and `public.discord_join_grants`, the once-per-account
record. The function pays through the billing system's
`internal_credit_move` only after Discord confirms the membership (201/204) —
a failed join never pays, and because the grant table survives a disconnect,
a disconnect + reconnect can never collect twice. Tune or disable the amount
in Admin → Settings (`discord_join_credit_usd`) or with SQL. The same
migration carries the site-announcements table used by Admin → Announcements.

## 6. Failure modes, on purpose

| Situation | Outcome |
| --- | --- |
| Discord email missing or unverified | `403 email_unverified`, clear message |
| Email domain not allowed | `403 domain_blocked` (same Gmail-only gate as every other door) |
| Email matches an existing account | Signs into that account and attaches the Discord identity |
| Cancel on Discord's consent screen | Back at `#/login` with a neutral notice, no half-session |
| Guild join fails / bot misconfigured | Sign-in proceeds, `guild_member=false`, no credit, Retry on the Profile tab |
| Join credit already claimed | `credit_granted_usd: 0` — once per account, disconnecting does not reset it |
| Account suspended | The bridge's existing status check refuses the session |
| Function undeployed / secrets missing | The error names the exact `supabase secrets set` / deploy command |

---

## 7. The gate is ON (v12.12)

`upgrade-v12.9-discord-gate.sql` built the gate and shipped it **off**, so that
turning it on before anyone had linked would not 403 every key at once.
`upgrade-v12.12-discord-compulsory.sql` turns it on and makes on the default:

```bash
psql "$DATABASE_URL" -f supabase/upgrade-v12.12-discord-compulsory.sql
```

From that point an account needs **both** a linked Discord **and** community
server membership, or the router answers `403 discord_not_linked` /
`discord_not_in_server` and logs the request like any other refusal. Keys are
not deleted and nothing is billed while blocked.

**Where you comply.** Dashboard → **Settings → Discord**
([`src/ragestar/dashboard/DiscordPanel.jsx`](src/ragestar/dashboard/DiscordPanel.jsx)).
That card is first on the screen, shows the linked account, the username, and
whether you are in the server, and carries *Connect Discord* / *Retry server
join* / *Disconnect* plus the "API access is paused" banner while you are
non-compliant.

> Earlier revisions of the refusal text pointed at **Profile → Discord**. That
> tab belonged to the console, which v12.8 retired — `#/console` now redirects
> to `#/dashboard/...` and neither `src/pages/Console.jsx` nor
> `src/pages/Workspace.jsx` is imported by anything, so the old card was
> unreachable. v12.12 repoints the text at Settings and puts the card where it
> can actually be used.

**Relaxing it again** — either Admin → Settings → *Require Discord for API
access* → *No*, or:

```sql
update public.app_settings set discord_required = false where id = 1;
alter table public.app_settings alter column discord_required set default false;
```
