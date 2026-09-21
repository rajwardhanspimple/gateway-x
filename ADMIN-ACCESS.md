# Why the admin panel locked you out, and how to get back in

> Short version: owning the Supabase project is not what `#/admin` checks.
> It checks whether **the browser** can read **your own row** in
> `public.profiles` and see `role = 'admin'` **and** `status = 'active'`.
> Three separate things in this schema can make that false.

## How the gate actually works

```
#/admin
  -> App.jsx            GUARDED["#/admin"] = true
  -> RequireAuth        admin={true}
  -> useSession()       isAdmin = profile?.role === "admin"
  -> profiles           read by the signed-in user, under RLS
```

On the database side every admin policy, view and RPC goes through:

```sql
create function public.is_admin(p_uid uuid default auth.uid())
  ... select exists (
        select 1 from public.profiles
         where id = p_uid and role = 'admin' and status = 'active'
      )
```

So `status` matters just as much as `role`, and the dashboard / service-role
key plays no part in it.

## The three causes

### 1. The role was probably never written

`handle_new_user()` grants `'admin'` only when the signup email is listed in
`app_settings.admin_emails` (case-insensitive), or when no admin row exists
yet. Any other signup gets `role = 'user'`. Signing up first and adding your
email to `admin_emails` afterwards does **not** backfill the role.

### 2. `upgrade-v5.5-security.sql` is Gmail-only, and it suspends everyone else

That migration added:

- `public.email_domain_allowed(p_email)`, driven by
  `app_settings.allowed_email_domains`, which defaults to `array['gmail.com']`
- a trigger on `auth.users` (`auth_users_allowed_email`, BEFORE INSERT **OR
  UPDATE**) that raises
  `This workspace only accepts @gmail.com addresses`
- a one-time statement that suspends every off-domain profile:

  ```sql
  update public.profiles set status = 'suspended'
   where status = 'active' and not public.email_domain_allowed(email) ...
  ```

Your login is `@outlook.com`. Under that rule you are off-domain, so your
profile can be suspended, and because `is_admin()` also requires
`status = 'active'`, a **suspended admin fails every admin check**. The
trigger firing on UPDATE is also why some account changes fail outright until
the domain is allowed.

The front end has the same rule, from `.env`:

```
VITE_ALLOWED_EMAIL_DOMAINS=gmail.com
```

`enforceSessionDomain()` in `src/lib/auth.js` signs out any session whose email
is off-domain, exempting only `profile.role === "admin"` - an exemption that
cause 3 could erase.

### 3. A failed profile read looked exactly like "not an admin"

`loadProfile()` used to fall back to a **synthetic** profile whenever the read
failed for any reason (RLS denial, a credit column that does not exist yet, a
dropped request):

```js
profile: { ..., role: "user", status: "active" }   // <- silently not an admin
```

So an infrastructure error and a genuine non-admin produced the identical dead
end: *"This area is restricted to workspace admins."* v5.5 also made
`admin_emails` non-world-readable, so the UI could not even hint at the cause.

## Fix it

### Step 1 - run the SQL (Supabase dashboard -> SQL editor)

Open `supabase/upgrade-v7.1-admin-access.sql`, put your address in the single
marked line, and run the file. It is idempotent and it:

1. adds your email domain to `app_settings.allowed_email_domains`
2. adds your email to `app_settings.admin_emails`
3. sets `role = 'admin'`, `status = 'active'` on your profile row
4. installs `public.admin_self_check()` so the app can report the real state

It runs as `postgres`, which `guard_profile_credits()` exempts - that guard is
why a plain `update ... set role='admin'` from the client always fails with
*"Only a workspace admin can change roles, limits or account status"*.

If it reports **no profiles row matched**, the account does not exist yet.
Sign up in the app first, or create it with the service-role key:

```bash
# supabase/.env.server needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
node scripts/recover-admin.mjs genalpha30@outlook.com --role admin
node scripts/recover-admin.mjs genalpha30@outlook.com --role admin --password "a-new-password"
```

Then run the SQL file again.

### Step 2 - match the front end

In `.env` (and in your host's environment variables), widen or clear the
domain rule so the browser stops rejecting the same address:

```
VITE_ALLOWED_EMAIL_DOMAINS=gmail.com,outlook.com
```

### Step 3 - sign out and sign in again

The role is read once when the session loads, so an open tab keeps the old
value until it reloads.

### Step 4 - confirm

```sql
select id, email, role, status from public.profiles
 where lower(email) = lower('genalpha30@outlook.com');

select allowed_email_domains, admin_emails from public.app_settings where id = 1;
```

From inside the app, `select public.admin_self_check();` now returns
`auth_uid`, `role`, `status`, `is_admin`, `in_admin_emails`, `domain_allowed`
and the allowed-domain list for the signed-in user.

## What changed in the app

- **`src/lib/auth.js`** - a failed profile read no longer pretends
  `role: "user"`. It records `profileError` and leaves the role `null`
  (`roleKnown: false`), so "you are not an admin" and "we could not find out"
  are different states. `enforceSessionDomain()` no longer signs you out while
  the role is unknown, which is what could boot an owner off their own site.
- **`src/components/RequireAuth.jsx`** - the admin dead end now names the
  actual cause (wrong role / not active / no profile row / read failed, with
  the error code) and offers **Recheck my role**, which re-reads the profile
  without a full reload.
- **`supabase/upgrade-v7.1-admin-access.sql`** - the recovery migration above.

## Guard rails worth keeping

The Gmail-only rule is a real protection on a public signup form; widening it
to `outlook.com` also lets anyone with an Outlook address sign up. If that is
not what you want, keep the domain list narrow and instead keep your own
address in `app_settings.admin_emails` - admins are exempt from the front-end
domain check once the role is readable.
