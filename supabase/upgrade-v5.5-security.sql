-- ============================================================================
--  RageStar — security hardening (v5.5)
-- ----------------------------------------------------------------------------
--  Run this ONCE, after schema.sql / upgrade-v5.4.sql, in the Supabase SQL
--  editor (or: psql "$DATABASE_URL" -f supabase/upgrade-v5.5-security.sql).
--  It is idempotent — running it twice is harmless.
--
--  What it fixes:
--    1. Gmail-only accounts, enforced in the database (not just the browser)
--    2. Credit balances can no longer be edited by the account owner
--       (the old guard was SECURITY DEFINER, so its current_user check never
--        matched and the trigger allowed everything through)
--    3. Role / status / budget / rate-limit self-escalation blocked
--    4. app_settings.admin_emails is no longer world-readable — it was an
--       instant path to admin, because handle_new_user() promotes any email
--       found in that list
--    5. Settings writes go through a validating RPC with a column allow-list
--    6. Over-broad table grants removed; nobody can create objects in public
--    7. Input validation (length, range, https-only, no angle brackets) on
--       everything an admin can type, so stored XSS cannot be planted
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Make sure the settings columns this file relies on exist
-- ---------------------------------------------------------------------------
alter table public.app_settings
  add column if not exists allowed_email_domains text[] not null default array['gmail.com'],
  add column if not exists credits_enabled  boolean not null default false,
  add column if not exists signup_credit_usd numeric(12,4) not null default 5,
  add column if not exists low_balance_usd   numeric(12,4) not null default 1,
  add column if not exists overdraft_usd     numeric(12,4) not null default 0,
  add column if not exists topup_note        text;

update public.app_settings
   set allowed_email_domains = array['gmail.com']
 where id = 1
   and (allowed_email_domains is null or cardinality(allowed_email_domains) = 0);

-- Rename the workspace
update public.app_settings set brand_name = 'RageStar' where id = 1;


-- ===========================================================================
-- 1. GMAIL-ONLY SIGN-UP AND SIGN-IN
-- ---------------------------------------------------------------------------
--  The browser check in src/lib/auth.js is a convenience. This is the real
--  gate: it runs inside Postgres, so it also blocks the REST API, magic
--  links, OAuth, curl and anything else that can reach auth.users.
--
--  To allow another domain later:
--    select public.admin_save_settings('{"allowed_email_domains":["gmail.com","yourcompany.com"]}');
-- ===========================================================================

create or replace function public.email_domain_allowed(p_email text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_email, '') ~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$'
     and lower(split_part(p_email, '@', 2)) = any (
           coalesce(
             (select s.allowed_email_domains from public.app_settings s where s.id = 1),
             array['gmail.com']
           )
         );
$$;

create or replace function public.enforce_allowed_email()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.email is not distinct from old.email then
    return new;
  end if;

  if not public.email_domain_allowed(new.email) then
    raise exception 'This workspace only accepts @gmail.com addresses'
      using errcode = '22023';
  end if;

  return new;
end $$;

drop trigger if exists auth_users_allowed_email on auth.users;
create trigger auth_users_allowed_email
  before insert or update on auth.users
  for each row execute function public.enforce_allowed_email();

-- Existing accounts on a now-disallowed domain lose access. Accounts listed in
-- app_settings.admin_emails are kept so you can never lock yourself out of
-- your own workspace.
update public.profiles p
   set status = 'suspended'
 where p.status = 'active'
   and not public.email_domain_allowed(p.email)
   and lower(p.email) not in (
         select lower(e)
         from public.app_settings s,
              unnest(coalesce(s.admin_emails, array[]::text[])) e
         where s.id = 1
       );


-- ===========================================================================
-- 2. CREDITS, ROLES AND LIMITS ARE READ-ONLY TO THE ACCOUNT OWNER
-- ---------------------------------------------------------------------------
--  Column-level privileges are the primary control: a signed-in user can only
--  write full_name and org, whatever any policy says. The trigger is the
--  second line of defence and returns a clear error message.
-- ===========================================================================

revoke update on public.profiles from authenticated;
grant  update (full_name, org) on public.profiles to authenticated;

create or replace function public.guard_profile_credits()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  -- the billing system (service_role) and SECURITY DEFINER routines such as
  -- internal_credit_move() / admin_adjust_credits() run as a privileged role
  if current_user in ('postgres', 'supabase_admin', 'supabase_auth_admin', 'service_role') then
    return new;
  end if;

  if new.credit_balance_usd is distinct from old.credit_balance_usd
     or new.credits_added_usd is distinct from old.credits_added_usd
     or new.credits_used_usd  is distinct from old.credits_used_usd then
    raise exception 'Credit balances can only be changed by the billing system'
      using errcode = '42501';
  end if;

  if (new.id       is distinct from old.id
      or new.email is distinct from old.email
      or new.role  is distinct from old.role
      or new.status is distinct from old.status
      or new.plan  is distinct from old.plan
      or new.monthly_budget_usd is distinct from old.monthly_budget_usd
      or new.rate_limit_rpm     is distinct from old.rate_limit_rpm)
     and not public.is_admin(auth.uid()) then
    raise exception 'Only a workspace admin can change roles, limits or account status'
      using errcode = '42501';
  end if;

  -- stored-XSS guard: no markup in anything that gets rendered back
  new.full_name := left(regexp_replace(coalesce(new.full_name, ''), '[<>]', '', 'g'), 80);
  new.org       := left(regexp_replace(coalesce(new.org, ''),       '[<>]', '', 'g'), 80);

  return new;
end $$;

drop trigger if exists profiles_guard_credits on public.profiles;
create trigger profiles_guard_credits
  before update on public.profiles
  for each row execute function public.guard_profile_credits();

-- Self-service policy no longer needs the racy role sub-select: the trigger
-- and the column grants decide what may change.
drop policy if exists profiles_self_write on public.profiles;
create policy profiles_self_write on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());


-- ===========================================================================
-- 3. app_settings: stop leaking admin_emails, stop direct writes
-- ===========================================================================

-- non-secret settings for the marketing pages, the sign-up page and the console
create or replace view public.public_settings as
  select s.id,
         s.brand_name,
         s.gateway_url,
         s.signup_enabled,
         s.default_policy,
         s.failover_enabled,
         s.max_failover_hops,
         s.log_retention_days,
         s.credits_enabled,
         s.signup_credit_usd,
         s.low_balance_usd,
         s.overdraft_usd,
         s.topup_note,
         s.allowed_email_domains
  from public.app_settings s
  where s.id = 1;

grant select on public.public_settings to anon, authenticated;

revoke select, insert, update, delete on public.app_settings from anon;
revoke insert, update, delete         on public.app_settings from authenticated;
grant  select                         on public.app_settings to authenticated;  -- narrowed by RLS below

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_admin_read on public.app_settings for select
  using (public.is_admin(auth.uid()));

-- Validating, admin-only settings writer with a column allow-list.
-- No dynamic SQL anywhere, so there is nothing for a crafted key to inject.
create or replace function public.admin_save_settings(p_patch jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  k        text;
  v_allowed text[] := array[
    'brand_name','gateway_url','signup_enabled','default_policy','failover_enabled',
    'max_failover_hops','log_retention_days','credits_enabled','signup_credit_usd',
    'low_balance_usd','overdraft_usd','topup_note','admin_emails','allowed_email_domains'
  ];
  v_domains text[];
  v_admins  text[];
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Settings patch must be a JSON object' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (v_allowed)) then
      raise exception 'Setting % cannot be changed here', k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'gateway_url' and coalesce(p_patch->>'gateway_url', '') <> ''
     and p_patch->>'gateway_url' !~ '^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$' then
    raise exception 'Gateway URL must be an https:// URL' using errcode = '22023';
  end if;

  if p_patch ? 'allowed_email_domains' then
    select array_agg(lower(btrim(d))) into v_domains
    from jsonb_array_elements_text(p_patch->'allowed_email_domains') d
    where btrim(d) <> '';
    if v_domains is null or cardinality(v_domains) = 0 then
      raise exception 'At least one email domain must stay allowed' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_domains) d where d !~ '^[a-z0-9.-]+\.[a-z]{2,}$') then
      raise exception 'Email domains must look like gmail.com' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'admin_emails' then
    select array_agg(lower(btrim(e))) into v_admins
    from jsonb_array_elements_text(p_patch->'admin_emails') e
    where btrim(e) <> '';
    v_admins := coalesce(v_admins, array[]::text[]);
    if exists (select 1 from unnest(v_admins) e
               where e !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$') then
      raise exception 'admin_emails must contain valid email addresses' using errcode = '22023';
    end if;
  end if;

  update public.app_settings s set
    brand_name = case when p_patch ? 'brand_name'
      then left(regexp_replace(coalesce(nullif(btrim(p_patch->>'brand_name'), ''), s.brand_name), '[<>]', '', 'g'), 60)
      else s.brand_name end,
    gateway_url = case when p_patch ? 'gateway_url'
      then nullif(btrim(p_patch->>'gateway_url'), '') else s.gateway_url end,
    signup_enabled = case when p_patch ? 'signup_enabled'
      then (p_patch->>'signup_enabled')::boolean else s.signup_enabled end,
    default_policy = case when p_patch ? 'default_policy'
      then left(regexp_replace(coalesce(nullif(btrim(p_patch->>'default_policy'), ''), s.default_policy), '[^a-zA-Z0-9:_.-]', '', 'g'), 40)
      else s.default_policy end,
    failover_enabled = case when p_patch ? 'failover_enabled'
      then (p_patch->>'failover_enabled')::boolean else s.failover_enabled end,
    max_failover_hops = case when p_patch ? 'max_failover_hops'
      then least(greatest((p_patch->>'max_failover_hops')::int, 1), 10) else s.max_failover_hops end,
    log_retention_days = case when p_patch ? 'log_retention_days'
      then least(greatest((p_patch->>'log_retention_days')::int, 1), 365) else s.log_retention_days end,
    credits_enabled = case when p_patch ? 'credits_enabled'
      then (p_patch->>'credits_enabled')::boolean else s.credits_enabled end,
    signup_credit_usd = case when p_patch ? 'signup_credit_usd'
      then least(greatest((p_patch->>'signup_credit_usd')::numeric, 0), 10000) else s.signup_credit_usd end,
    low_balance_usd = case when p_patch ? 'low_balance_usd'
      then least(greatest((p_patch->>'low_balance_usd')::numeric, 0), 10000) else s.low_balance_usd end,
    overdraft_usd = case when p_patch ? 'overdraft_usd'
      then least(greatest((p_patch->>'overdraft_usd')::numeric, 0), 10000) else s.overdraft_usd end,
    topup_note = case when p_patch ? 'topup_note'
      then left(regexp_replace(coalesce(p_patch->>'topup_note', ''), '[<>]', '', 'g'), 500) else s.topup_note end,
    admin_emails = case when p_patch ? 'admin_emails' then v_admins else s.admin_emails end,
    allowed_email_domains = case when p_patch ? 'allowed_email_domains' then v_domains else s.allowed_email_domains end,
    updated_at = now()
  where s.id = 1;

  insert into public.audit_logs (actor_id, action, entity, detail)
  values (auth.uid(), 'save_settings', 'app_settings',
          jsonb_build_object('keys', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
end $$;

revoke execute on function public.admin_save_settings(jsonb) from anon;
grant  execute on function public.admin_save_settings(jsonb) to authenticated;

revoke execute on function public.email_domain_allowed(text) from anon;
grant  execute on function public.email_domain_allowed(text) to authenticated, service_role;


-- ===========================================================================
-- 4. Least privilege on the remaining tables
-- ===========================================================================

-- the browser never writes health checks or key rows directly
revoke insert, update, delete on public.upstream_key_checks from authenticated;
revoke update                 on public.api_keys            from authenticated;

-- nobody but the owner may add objects to the public schema (stops function /
-- table shadowing tricks against SECURITY DEFINER routines)
revoke create on schema public from public;
revoke create on schema public from anon, authenticated;

-- runaway queries are a denial-of-service vector; cap them where allowed
do $$
begin
  execute 'alter role authenticated set statement_timeout = ''20s''';
  execute 'alter role anon set statement_timeout = ''10s''';
exception when others then
  raise notice 'statement_timeout not changed (insufficient privileges): %', sqlerrm;
end $$;

-- cap API-key spam and strip markup from key names
create or replace function public.guard_api_keys()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.name := left(regexp_replace(coalesce(new.name, 'default'), '[[:cntrl:]<>]', '', 'g'), 60);
  if (select count(*) from public.api_keys k
       where k.user_id = new.user_id and k.status = 'active') >= 25 then
    raise exception 'Key limit reached (25 active keys). Revoke one first.'
      using errcode = '22023';
  end if;
  return new;
end $$;

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'api_keys'
         and column_name in ('name', 'user_id', 'status')) = 3 then
    execute 'drop trigger if exists api_keys_guard on public.api_keys';
    execute 'create trigger api_keys_guard before insert on public.api_keys '
         || 'for each row execute function public.guard_api_keys()';
  end if;
end $$;

-- upstream endpoints must be public https hosts: blocks SSRF into the
-- Supabase network or a cloud metadata service from the admin panel
create or replace function public.guard_upstreams()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_host text;
begin
  new.base_url := btrim(coalesce(new.base_url, ''));
  if new.base_url !~ '^https://' then
    raise exception 'Upstream base_url must start with https://' using errcode = '22023';
  end if;
  v_host := lower(split_part(regexp_replace(new.base_url, '^https://', ''), '/', 1));
  if v_host ~ '^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|172\.(1[6-9]|2[0-9]|3[01])\.)'
     or v_host like '%.internal'
     or v_host like '%.local'
     or v_host = 'metadata.google.internal' then
    raise exception 'Upstream host % is private or loopback', v_host using errcode = '22023';
  end if;
  new.name := left(regexp_replace(coalesce(new.name, ''), '[[:cntrl:]<>]', '', 'g'), 80);
  return new;
end $$;

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'upstreams'
         and column_name in ('base_url', 'name')) = 2 then
    execute 'drop trigger if exists upstreams_guard on public.upstreams';
    execute 'create trigger upstreams_guard before insert or update on public.upstreams '
         || 'for each row execute function public.guard_upstreams()';
  end if;
end $$;

-- model rows are rendered on public pages: no markup, sane prices
create or replace function public.guard_models()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.name := left(regexp_replace(coalesce(new.name, ''), '[[:cntrl:]<>]', '', 'g'), 120);
  if new.description is not null then
    new.description := left(regexp_replace(new.description, '[<>]', '', 'g'), 600);
  end if;
  return new;
end $$;

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'models'
         and column_name in ('name', 'description')) = 2 then
    execute 'drop trigger if exists models_guard on public.models';
    execute 'create trigger models_guard before insert or update on public.models '
         || 'for each row execute function public.guard_models()';
  end if;
end $$;

-- user-scoped views should honour row-level security instead of running as
-- their owner
do $$
begin
  execute 'alter view public.my_api_keys     set (security_invoker = on)';
  execute 'alter view public.my_request_logs set (security_invoker = on)';
  execute 'alter view public.my_credit_ledger set (security_invoker = on)';
exception when others then
  raise notice 'security_invoker not set on my_* views: %', sqlerrm;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Verify (run these after the migration)
-- ---------------------------------------------------------------------------
--  select public.email_domain_allowed('you@gmail.com');   -- true
--  select public.email_domain_allowed('you@outlook.com'); -- false
--  -- as a normal signed-in user, this must fail with 42501:
--  --   update profiles set credit_balance_usd = 999 where id = auth.uid();
--  select 'RageStar security hardening installed' as status;
