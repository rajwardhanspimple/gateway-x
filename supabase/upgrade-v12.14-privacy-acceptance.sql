-- ============================================================================
--  RageStar — upgrade to v12.14  "privacy acceptance"
--  Paste this whole file into the Supabase SQL editor and press Run.
--  Idempotent: re-running changes nothing.
--
--  WHAT THIS DOES
--    A Privacy Policy page now exists, and using the dashboard requires having
--    accepted the current version of it. That needs somewhere to record the
--    acceptance and a way for the browser to write it that the account owner
--    cannot abuse.
--
--    1. public.profiles gains two columns:
--         privacy_accepted_at timestamptz  — when the box was ticked
--         privacy_version     text         — which version of the policy
--    2. public.accept_privacy(p_version text) is the only writer. It is
--       SECURITY DEFINER so it can update the row even though authenticated
--       UPDATE on profiles is column-restricted to (full_name, org) by
--       upgrade-v10.0-firebase-auth.sql. It writes auth.uid()'s own row and
--       nobody else's, and raises if there is no signed-in caller.
--
--  THE APP'S READ PATH
--    There is no my_profile view: the front end reads public.profiles directly
--    (src/lib/auth.js loads the profile; the gate in
--    src/ragestar/RageStarApp.jsx reads the two new columns through
--    myPrivacyAcceptance() in src/lib/db.js). SELECT on public.profiles was
--    granted table-wide to authenticated, so the new columns are visible to the
--    owner with no extra grant — nothing else has to change here for the app to
--    see them.
--
--  A NOTE ON BACKFILL
--    Nothing is backfilled. Every existing account starts with
--    privacy_accepted_at = null and privacy_version = null, so the gate asks
--    them to accept once, the next time they sign in. That is deliberate: an
--    acceptance nobody gave is not an acceptance.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The two columns
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists privacy_accepted_at timestamptz;

alter table public.profiles
  add column if not exists privacy_version text;

comment on column public.profiles.privacy_accepted_at is
  'When this account last accepted the Privacy Policy. Null means it has never accepted one; the sign-in gate then blocks the dashboard until it does.';

comment on column public.profiles.privacy_version is
  'The Privacy Policy version this account accepted (see PRIVACY_VERSION in src/ragestar/pages/privacy.jsx). A mismatch with the current version re-opens the gate.';

-- ----------------------------------------------------------------------------
-- 2. The only writer
-- ----------------------------------------------------------------------------
--    SECURITY DEFINER on purpose: UPDATE on profiles is column-restricted for
--    authenticated, so a plain browser write to these columns would be denied.
--    This function runs as its owner, touches only the caller's row, and takes
--    the version as an argument so the client cannot store a blank one.
create or replace function public.accept_privacy(p_version text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'accept_privacy: not signed in' using errcode = '28000';
  end if;

  if p_version is null or btrim(p_version) = '' then
    raise exception 'accept_privacy: a policy version is required' using errcode = '22023';
  end if;

  update public.profiles
     set privacy_accepted_at = now(),
         privacy_version     = btrim(p_version)
   where id = v_uid;
end
$$;

comment on function public.accept_privacy(text) is
  'Records that auth.uid() accepted the given Privacy Policy version. SECURITY DEFINER so the browser can write the two privacy columns, which a direct profiles UPDATE is not allowed to touch.';

-- ----------------------------------------------------------------------------
-- 3. Grants — exposed to signed-in accounts only, never to anon
-- ----------------------------------------------------------------------------
revoke all on function public.accept_privacy(text) from public;
grant execute on function public.accept_privacy(text) to authenticated;

commit;

-- PostgREST caches the function list; without this the new RPC is not callable
-- until the next schema reload.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFY — eyeball these before walking away
--   privacy_columns          2   both new columns are on public.profiles
--   authenticated_can_accept true the RPC is callable by a signed-in account
-- ----------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name in ('privacy_accepted_at', 'privacy_version'))          as privacy_columns,
  has_function_privilege('authenticated', 'public.accept_privacy(text)', 'execute') as authenticated_can_accept;
