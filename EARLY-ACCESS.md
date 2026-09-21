# Early access — roles and gated models

v12.4 adds one new role and one new model flag.

- An account is `user`, `early_access`, or `admin`.
- A model is `public` or `early_access`.

An `early_access` model is visible and callable only to accounts with the
`early_access` role, plus admins. Everything else keeps working exactly as it
did in v12.3 — a fresh install has no gated models, so nothing changes until
you mark one.

## 1. Run the migration

Supabase SQL editor, or psql:

```
psql "$DATABASE_URL" -f supabase/upgrade-v12.4-early-access.sql
```

It is idempotent and safe to re-run. It widens the `profiles.role` check
constraint, adds `models.access_tier` / `models.access_note`, rebuilds
`public_models`, and adds the admin RPCs the dashboard calls.

## 2. Redeploy the gateway

```
supabase functions deploy router
```

The router reads the caller's entitlement through `internal_access_context`
and filters the catalogue with `internal_models_for_user`. Both calls are
wrapped in `try`/`catch`: an un-migrated database simply behaves like v12.3
rather than erroring, but until you redeploy, a gated model is hidden in the
UI while still being callable over the API. Do both steps.

## 3. Give somebody early access

**Admin → Users → Role.** The column that used to be a *Make admin* button is
now a three-way select:

| Role | Sees | Notes |
| --- | --- | --- |
| User | public models | the default for every signup |
| Early access | public + early access models | no admin rights at all |
| Admin | everything | full console, can grant roles |

You cannot demote yourself — `admin_set_user_role` refuses when
`p_user_id = auth.uid()`, so a workspace can never end up with zero admins by
accident. Every change is written to `audit_logs` with action
`set_user_role`, so Admin → Audit shows who moved whom and when.

## 4. Mark a model early access

**Admin → Models.** Two ways, same result:

- The **Access** select in the mapping form (`Everyone` / `Early access
  only`). When it is set to early access, an optional **Early access note**
  appears — free text shown beside the locked model, e.g. *Beta group only*
  or *Ask in #early-access*.
- The **Access** chip in the models table. Click it to flip a single model
  without opening the form.

## 5. What each audience sees

The public models page and the console model tree read the same
`public_models` view, so the three views stay consistent:

- **User** — a gated model shows as a greyed row with an *early access* chip
  and the note underneath. The curl sample on the models page always picks a
  model the visitor can actually call.
- **Early access / admin** — the same row, chip still shown, but live: it is
  selectable in the console and returned by `/v1/models`.

If you would rather not advertise gated models at all, turn the teaser off:

```sql
select public.admin_save_early_access(false);
```

With `app_settings.early_access_teaser = false`, gated models disappear
entirely for accounts without the role.

## 6. At the gateway

`GET /v1/models` now returns `access_tier` on every entry and omits models the
key's owner cannot use.

A gated model asked for by name without the role returns 403 rather than a
vague routing failure:

```json
{
  "error": {
    "message": "Model `sonnet-4.6-thinking` is in early access. Ask an admin to enable early access for this account.",
    "type": "early_access_required"
  }
}
```

The response carries `x-rs-access-tier` alongside the usual
`x-rs-request-id`. `auto:*` policies never fail over into a model the account
is not entitled to — the candidate pool is filtered before key selection, so
an early access model cannot leak through failover.

Per-key `allowed_models` still applies on top of this. A key is allowed to
reach a model only if the key permits it *and* the owner is entitled to it.

## 7. SQL reference

Everything below ships in `supabase/upgrade-v12.4-early-access.sql`.

| Function | Who can call it | Does |
| --- | --- | --- |
| `is_early_access(uuid)` | anyone | true for `early_access` and `admin` |
| `my_access_tier()` | anyone | `'public'` or `'early_access'` for the caller |
| `can_use_model(text)` | anyone | entitlement check for one public id |
| `early_access_config()` | anyone | teaser flag, caller tier, gated model list |
| `admin_set_user_role(uuid, text)` | admins | `user` / `early_access` / `admin` |
| `admin_set_early_access(uuid, boolean)` | admins | the same thing as a toggle |
| `admin_set_model_access(uuid, text, text)` | admins | tier + note for one model |
| `admin_save_early_access(boolean)` | admins | the teaser flag |
| `internal_access_context(uuid)` | service role | router: role, entitlement, gated ids |
| `internal_models_for_user(uuid)` | service role | router: the catalogue for one account |

The two `internal_*` functions are revoked from `anon` and `authenticated` —
only the edge function's service role key can read another account's
entitlement.

## 8. Rolling back

```sql
-- everyone back to public models
update public.models set access_tier = 'public';
-- and, if you want the role gone as well
update public.profiles set role = 'user' where role = 'early_access';
```

The columns and functions can stay in place; with no gated models and no
early access accounts the feature is inert.
