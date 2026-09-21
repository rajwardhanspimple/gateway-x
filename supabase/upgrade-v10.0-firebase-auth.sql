-- ============================================================================
--  RageStar v10.0 - Firebase Auth bridge (additive)
-- ----------------------------------------------------------------------------
--  Run this ONCE, after v9.0, in the Supabase SQL editor.
--
--  WHAT THIS DOES
--    Adds one nullable column, profiles.firebase_uid, so a Firebase account
--    can be linked to the Supabase auth user it already maps to.
--
--  WHAT THIS DOES NOT DO
--    Nothing else changes. profiles.id stays a uuid referencing auth.users(id),
--    every one of the existing RLS policies still reads auth.uid(), and no
--    data is moved, copied or rewritten. Only *authentication* moved to
--    Firebase; the database is untouched, which is why this migration is four
--    statements long instead of a rewrite.
--
--  Safe to re-run: every statement is guarded.
-- ============================================================================

begin;

-- 1. the link column -------------------------------------------------------
--    Set by the firebase-auth Edge Function with the service role, on the
--    first successful sign-in. Unique, so two Firebase accounts can never
--    claim the same profile row.
alter table public.profiles
  add column if not exists firebase_uid text;

comment on column public.profiles.firebase_uid is
  'Firebase Auth uid linked to this profile. Written only by the firebase-auth Edge Function (service role). Authentication lives in Firebase; identity for RLS is still profiles.id = auth.uid().';

-- 2. uniqueness + lookup ---------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'profiles_firebase_uid_key'
  ) then
    create unique index profiles_firebase_uid_key
      on public.profiles (firebase_uid)
      where firebase_uid is not null;
  end if;
end $$;

-- 3. keep the column out of reach of the browser ---------------------------
--    The account owner may update only full_name and org. Re-asserting the
--    column grant here means a new column cannot silently become writable.
revoke update on public.profiles from authenticated;
grant update (full_name, org) on public.profiles to authenticated;

-- 4. make the domain allowlist readable by the bridge ----------------------
--    The Edge Function reads app_settings.allowed_email_domains with the
--    service role (which bypasses RLS), so there is nothing to grant - this
--    is only a sanity check that the setting exists and is populated.
do $$
declare
  n int;
begin
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'app_settings'
    and column_name = 'allowed_email_domains';

  if n = 0 then
    raise notice 'app_settings.allowed_email_domains not found - the bridge will fall back to the auth.users trigger for domain enforcement.';
  end if;
end $$;

commit;

-- ============================================================================
--  VERIFY
-- ============================================================================
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'profiles'
--    and column_name = 'firebase_uid';
--
-- -- who is linked so far
-- select email, role, status, firebase_uid is not null as linked
--   from public.profiles
--  order by created_at;
--
-- -- unlink an account so its next Firebase sign-in re-links it
-- -- update public.profiles set firebase_uid = null where email = 'you@gmail.com';

-- ============================================================================
--  ROLLBACK (back to Supabase Auth)
-- ----------------------------------------------------------------------------
--  Because nothing was migrated, rolling back is a front-end change: restore
--  the previous src/lib/auth.js, drop VITE_FIREBASE_* from .env, redeploy.
--  Every password that existed in Supabase Auth before the switch still works.
--  Accounts CREATED in Firebase after the switch have no Supabase password,
--  so those users would need a password reset email. The column below can
--  stay; it is inert without the bridge.
--
--  drop index if exists public.profiles_firebase_uid_key;
--  alter table public.profiles drop column if exists firebase_uid;
-- ============================================================================
