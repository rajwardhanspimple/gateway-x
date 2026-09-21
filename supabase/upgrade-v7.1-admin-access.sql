-- =============================================================================
-- upgrade-v7.1-admin-access.sql
--
-- Fixes "I cannot open #/admin even though I am the admin".
--
-- The admin panel does NOT care that you own the Supabase project or that you
-- are logged into the dashboard. RequireAuth renders the panel only when the
-- browser can read YOUR OWN row in public.profiles and see:
--
--     profiles.role   = 'admin'
--     profiles.status = 'active'
--
-- (public.is_admin() requires both.) Three things in this schema can stop
-- that from being true:
--
--   1. handle_new_user() only grants 'admin' when the signup email is listed
--      in app_settings.admin_emails, or when no admin exists yet. Otherwise
--      you get role = 'user'.
--   2. upgrade-v5.5-security.sql added a Gmail-only rule. It suspends any
--      profile whose domain is not allowed:
--          update public.profiles set status = 'suspended' ...
--      A suspended admin fails is_admin() and every admin policy.
--   3. The same file added a BEFORE INSERT OR UPDATE trigger on auth.users
--      that raises 'This workspace only accepts @gmail.com addresses'. While
--      your domain is not allowed you cannot even create or update the user.
--
-- Run this whole file in the Supabase SQL editor (it runs as `postgres`, which
-- the profiles guard trigger exempts). Safe to run more than once.
-- =============================================================================

begin;

-- Columns v5.5 introduced, in case this project never applied it.
alter table public.app_settings
  add column if not exists admin_emails text[] not null default '{}';

alter table public.app_settings
  add column if not exists allowed_email_domains text[] not null
  default array['gmail.com'];

do $$
declare
  -- >>> EDIT THIS ONE LINE: the address you sign in with <<<
  v_email  text := 'genalpha30@outlook.com';

  v_domain text;
  v_rows   int;
  v_state  record;
begin
  v_email  := lower(trim(v_email));
  v_domain := split_part(v_email, '@', 2);

  if v_domain = '' then
    raise exception 'v_email must be a full email address, got %', v_email;
  end if;

  insert into public.app_settings (id) values (1) on conflict (id) do nothing;

  -- 1. allow your domain, so the auth.users trigger stops rejecting you and
  --    v5.5 stops suspending you.
  update public.app_settings
     set allowed_email_domains = (
           select array_agg(distinct d)
             from unnest(allowed_email_domains || array[v_domain]) as d
         )
   where id = 1
     and not (v_domain = any (allowed_email_domains));

  -- 2. whitelist the address, so any future signup with it is born an admin.
  update public.app_settings
     set admin_emails = (
           select array_agg(distinct e)
             from unnest(admin_emails || array[v_email]) as e
         )
   where id = 1
     and not exists (
           select 1 from unnest(admin_emails) as e where lower(e) = v_email
         );

  -- 3. promote (and un-suspend) the existing profile row.
  update public.profiles
     set role   = 'admin',
         status = 'active'
   where lower(email) = v_email;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise notice '--';
    raise notice 'No profiles row matches %.', v_email;
    raise notice 'Create the account first (sign up in the app, or run';
    raise notice '  node scripts/recover-admin.mjs % --role admin', v_email;
    raise notice 'with SUPABASE_SERVICE_ROLE_KEY set), then re-run this file.';
    raise notice '--';
  else
    raise notice 'Promoted % -> role=admin, status=active (% row(s)).',
      v_email, v_rows;
  end if;

  select allowed_email_domains, admin_emails
    into v_state
    from public.app_settings
   where id = 1;

  raise notice 'allowed_email_domains = %', v_state.allowed_email_domains;
  raise notice 'admin_emails          = %', v_state.admin_emails;
end $$;

-- -----------------------------------------------------------------------------
-- Diagnostic the app can call as the signed-in user.
--
-- This answers the question the old "Admin only" screen refused to answer:
-- is the session even reaching a profiles row, and what does that row say?
--
--   select public.admin_self_check();
--
-- Run it from the app (or from the SQL editor with an auth context); from the
-- dashboard as `postgres`, auth.uid() is null and it will report no profile.
-- -----------------------------------------------------------------------------
create or replace function public.admin_self_check()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'auth_uid',        auth.uid(),
    'jwt_email',       lower(coalesce(auth.jwt() ->> 'email', '')),
    'profile_found',   p.id is not null,
    'profile_email',   p.email,
    'role',            p.role,
    'status',          p.status,
    'is_admin',        public.is_admin(),
    'in_admin_emails', exists (
      select 1
        from public.app_settings s,
             unnest(coalesce(s.admin_emails, '{}')) as e
       where s.id = 1
         and lower(e) = lower(coalesce(p.email, auth.jwt() ->> 'email', ''))
    ),
    'domain_allowed',  exists (
      select 1
        from public.app_settings s
       where s.id = 1
         and lower(split_part(coalesce(p.email, auth.jwt() ->> 'email', ''), '@', 2))
             = any (s.allowed_email_domains)
    ),
    'allowed_domains', (select allowed_email_domains from public.app_settings where id = 1)
  )
    from (select 1) as anchor
    left join public.profiles p on p.id = auth.uid()
$$;

revoke all on function public.admin_self_check() from public;
grant execute on function public.admin_self_check() to authenticated;

commit;

-- -----------------------------------------------------------------------------
-- Verify (run separately, after the commit):
--
--   select id, email, role, status from public.profiles
--    where lower(email) = lower('genalpha30@outlook.com');
--
--   select allowed_email_domains, admin_emails from public.app_settings where id = 1;
--
-- Then sign out and sign in again in the app: the role is read once per
-- session, so an open tab keeps the stale value until it reloads.
-- -----------------------------------------------------------------------------
