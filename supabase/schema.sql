-- ============================================================================
--  RageStar — full database schema for Supabase
--  Project: https://vxzpiipnsfrnsrrgxdug.supabase.co
-- ----------------------------------------------------------------------------
--  WHAT THIS DOES
--  1. Real auth-backed accounts (profiles mirror auth.users, first user = admin)
--  2. "upstreams"      = the ORIGINAL third-party API (base_url) — SECRET, admin only
--  3. "upstream_keys"  = the API keys YOU paste in for that third-party API,
--                        each one tracks whether it is WORKING or not
--  4. "models"         = your public model id  ->  hidden upstream model id
--  5. "api_keys"       = the rs_live_… keys your users call YOUR gateway with
--  6. "request_logs"   = usage + cost; users only ever see a sanitised view that
--                        contains no upstream name, url, key or model id
--
--  Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query.
--  It is idempotent: safe to re-run.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- 1. WORKSPACE SETTINGS
-- ============================================================================
create table if not exists public.app_settings (
  id                 smallint primary key default 1 check (id = 1),
  brand_name         text        not null default 'RageStar',
  gateway_url        text,                          -- filled in below
  signup_enabled     boolean     not null default true,
  default_policy     text        not null default 'auto:balanced',
  admin_emails       text[]      not null default '{}',
  log_retention_days int         not null default 30,
  failover_enabled   boolean     not null default true,
  max_failover_hops  int         not null default 3,
  free_monthly_usd   numeric(12,4) not null default 0,
  updated_at         timestamptz not null default now()
);

insert into public.app_settings (id, gateway_url, admin_emails)
values (1,
        'https://vxzpiipnsfrnsrrgxdug.supabase.co/functions/v1/router/v1',
        array['genalpha16@outlook.com'])
on conflict (id) do nothing;

-- ============================================================================
-- 2. PROFILES  (1:1 with auth.users)
-- ============================================================================
create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text        not null default '',
  full_name           text,
  org                 text,
  plan                text        not null default 'free',
  role                text        not null default 'user'   check (role   in ('user','admin')),
  status              text        not null default 'active' check (status in ('active','suspended')),
  monthly_budget_usd  numeric(12,4),
  rate_limit_rpm      int         not null default 120,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists profiles_role_idx  on public.profiles (role);
create index if not exists profiles_email_idx on public.profiles (lower(email));

-- ============================================================================
-- 3. UPSTREAMS — the original third-party API. NEVER exposed to end users.
-- ============================================================================
create table if not exists public.upstreams (
  id             uuid primary key default gen_random_uuid(),
  name           text        not null,                       -- internal label
  slug           text        not null unique,
  base_url       text        not null,                        -- SECRET original API
  chat_path      text        not null default '/chat/completions',
  models_path    text                 default '/models',
  health_path    text                 default '/models',
  auth_scheme    text        not null default 'bearer'
                 check (auth_scheme in ('bearer','x-api-key','api-key','query','header')),
  auth_header    text        not null default 'Authorization',
  auth_query_arg text,                                        -- when auth_scheme = 'query'
  extra_headers  jsonb       not null default '{}'::jsonb,
  is_active      boolean     not null default true,
  priority       int         not null default 100,            -- lower = tried first
  timeout_ms     int         not null default 60000,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists upstreams_active_idx on public.upstreams (is_active, priority);

-- ============================================================================
-- 4. UPSTREAM KEYS — the keys YOU provide, with live working/not-working state
-- ============================================================================
create table if not exists public.upstream_keys (
  id                   uuid primary key default gen_random_uuid(),
  upstream_id          uuid not null references public.upstreams (id) on delete cascade,
  label                text not null default 'key',
  api_key              text not null,                         -- SECRET
  key_last4            text generated always as (right(api_key, 4)) stored,
  status               text not null default 'unknown'
                       check (status in ('unknown','working','failing','rate_limited','expired','disabled')),
  is_active            boolean not null default true,
  weight               int     not null default 100,
  last_checked_at      timestamptz,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  last_status_code     int,
  last_latency_ms      int,
  last_error           text,
  success_count        bigint  not null default 0,
  failure_count        bigint  not null default 0,
  consecutive_failures int     not null default 0,
  monthly_budget_usd   numeric(12,4),
  spend_usd            numeric(14,6) not null default 0,
  expires_at           timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (upstream_id, api_key)
);

create index if not exists upstream_keys_pick_idx
  on public.upstream_keys (upstream_id, is_active, status, weight desc);

-- health-check history, so "is this key working" has receipts
create table if not exists public.upstream_key_checks (
  id              uuid primary key default gen_random_uuid(),
  upstream_key_id uuid not null references public.upstream_keys (id) on delete cascade,
  ok              boolean not null,
  status_code     int,
  latency_ms      int,
  message         text,
  checked_by      uuid references auth.users (id) on delete set null,
  source          text not null default 'manual' check (source in ('manual','auto','traffic')),
  created_at      timestamptz not null default now()
);

create index if not exists upstream_key_checks_key_idx
  on public.upstream_key_checks (upstream_key_id, created_at desc);

-- ============================================================================
-- 5. MODELS — public alias  ->  hidden upstream model id
-- ============================================================================
create table if not exists public.models (
  id                uuid primary key default gen_random_uuid(),
  public_id         text not null unique,                     -- what your users send
  display_name      text not null,
  upstream_id       uuid not null references public.upstreams (id) on delete cascade,
  upstream_model_id text not null,                            -- SECRET real model id
  description       text,
  context_window    int,
  max_output_tokens int,
  price_in_per_m    numeric(12,4) not null default 0,
  price_out_per_m   numeric(12,4) not null default 0,
  capabilities      text[] not null default '{}',
  status            text not null default 'active'
                    check (status in ('active','preview','deprecated','disabled')),
  is_active         boolean not null default true,
  is_default        boolean not null default false,
  sort_order        int not null default 100,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists models_public_idx  on public.models (is_active, sort_order);
create unique index if not exists models_one_default_idx
  on public.models ((is_default)) where is_default;

-- ============================================================================
-- 6. API KEYS — YOUR keys, handed to your users (rs_live_… / rs_test_…)
--    Only a SHA-256 hash is stored. The plaintext is shown exactly once.
-- ============================================================================
create table if not exists public.api_keys (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  name               text not null default 'default',
  environment        text not null default 'live' check (environment in ('live','test')),
  key_prefix         text not null,
  key_last4          text not null,
  key_hash           text not null unique,
  status             text not null default 'active' check (status in ('active','disabled','revoked')),
  monthly_budget_usd numeric(12,4),
  spend_usd          numeric(14,6) not null default 0,
  request_count      bigint  not null default 0,
  rate_limit_rpm     int     not null default 120,
  allowed_models     text[]  not null default '{}',   -- empty = all active models
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists api_keys_user_idx on public.api_keys (user_id, created_at desc);
create index if not exists api_keys_hash_idx on public.api_keys (key_hash) where status = 'active';

-- ============================================================================
-- 7. REQUEST LOGS
-- ============================================================================
create table if not exists public.request_logs (
  id               uuid primary key default gen_random_uuid(),
  request_id       text not null default ('req_' || encode(extensions.gen_random_bytes(8), 'hex')),
  user_id          uuid references auth.users (id) on delete set null,
  api_key_id       uuid references public.api_keys (id) on delete set null,
  model_public_id  text,
  policy           text,
  upstream_id      uuid references public.upstreams (id) on delete set null,      -- admin only
  upstream_key_id  uuid references public.upstream_keys (id) on delete set null,  -- admin only
  ok               boolean not null default false,
  status_code      int,
  latency_ms       int,
  tokens_in        int not null default 0,
  tokens_out       int not null default 0,
  cost_usd         numeric(14,6) not null default 0,
  failover_count   int not null default 0,
  streamed         boolean not null default false,
  error_code       text,
  error_message    text,
  created_at       timestamptz not null default now()
);

create index if not exists request_logs_user_idx    on public.request_logs (user_id, created_at desc);
create index if not exists request_logs_key_idx     on public.request_logs (api_key_id, created_at desc);
create index if not exists request_logs_created_idx on public.request_logs (created_at desc);
create index if not exists request_logs_model_idx   on public.request_logs (model_public_id, created_at desc);

-- ============================================================================
-- 8. AUDIT LOG (admin actions)
-- ============================================================================
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  actor_email text,
  action      text not null,
  entity      text,
  entity_id   text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);

-- ============================================================================
-- 9. updated_at triggers
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','upstreams','upstream_keys','models','app_settings']
  loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before update on public.%1$s
                    for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ============================================================================
-- 10. AUTH HELPERS
-- ============================================================================
create or replace function public.is_admin(p_uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_uid and role = 'admin' and status = 'active'
  );
$$;

-- new signup -> profile row. First account (or an email listed in
-- app_settings.admin_emails) automatically becomes the admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_admin  boolean := false;
  v_emails text[];
begin
  select admin_emails into v_emails from public.app_settings where id = 1;

  if new.email is not null and exists (
       select 1 from unnest(coalesce(v_emails, '{}'::text[])) e
       where lower(e) = lower(new.email)) then
    v_admin := true;
  end if;

  if not exists (select 1 from public.profiles where role = 'admin') then
    v_admin := true;
  end if;

  insert into public.profiles (id, email, full_name, org, role)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name',
                         new.raw_user_meta_data ->> 'name', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'org', '')), ''),
    case when v_admin then 'admin' else 'user' end
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        org       = coalesce(public.profiles.org, excluded.org);

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- keep profiles.email in sync when the user changes it
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end $$;

drop trigger if exists on_auth_user_email_change on auth.users;
create trigger on_auth_user_email_change
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- backfill profiles for users that already exist
insert into public.profiles (id, email, role)
select u.id, coalesce(u.email, ''),
       case when exists (select 1 from unnest((select admin_emails from public.app_settings where id = 1)) e
                         where lower(e) = lower(coalesce(u.email, '')))
            then 'admin' else 'user' end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- make sure at least one admin exists
update public.profiles p
set role = 'admin'
where not exists (select 1 from public.profiles where role = 'admin')
  and p.id = (select id from public.profiles order by created_at limit 1);

-- ============================================================================
-- 11. USER-FACING RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- create_api_key  — FIXED in v5.4
-- ----------------------------------------------------------------------------
-- Why the console could not mint keys:
--
--   RETURNS TABLE (id uuid, name text, …) silently declares OUT variables
--   called id / name / api_key / environment / created_at. The old body then
--   ran an unqualified lookup:
--
--       if (select status from public.profiles where id = v_user) = 'suspended'
--
--   `id` matched BOTH the OUT variable and profiles.id, so PostgreSQL aborted
--   every single call with:
--
--       column reference "id" is ambiguous
--
--   PostgREST surfaced that as a generic failure in the console, which is why
--   "Create key" never returned a key.
--
-- Fixes applied here:
--   · every column reference is alias-qualified, so OUT names can never clash
--   · the sha256 hash uses the built-in sha256() instead of
--     extensions.digest(), so the function no longer depends on pgcrypto
--     living in the `extensions` schema
--   · the random secret uses gen_random_uuid() (core Postgres) instead of
--     extensions.gen_random_bytes()
--   · a missing profile row is created on the fly instead of being treated as
--     an unknown account
--   · old overloads are dropped first, so re-running this file cannot leave
--     two create_api_key functions behind for PostgREST to choose between
-- ----------------------------------------------------------------------------
drop function if exists public.create_api_key(text, text, numeric, timestamptz);
drop function if exists public.create_api_key(text, text, numeric);
drop function if exists public.create_api_key(text, text);
drop function if exists public.create_api_key(text);
drop function if exists public.create_api_key();

create function public.create_api_key(
  p_name               text default 'default',
  p_environment        text default 'live',
  p_monthly_budget_usd numeric default null,
  p_expires_at         timestamptz default null
)
returns table (
  id uuid, name text, api_key text, key_prefix text,
  key_last4 text, environment text, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid := auth.uid();
  v_env     text := lower(coalesce(nullif(trim(p_environment), ''), 'live'));
  v_name    text := coalesce(nullif(trim(p_name), ''), 'default');
  v_status  text;
  v_active  int;
  v_prefix  text;
  v_full    text;
  v_id      uuid;
  v_created timestamptz;
begin
  if v_user is null then
    raise exception 'Not authenticated. Sign in again and retry.'
      using errcode = '42501';
  end if;

  if v_env not in ('live', 'test') then
    raise exception 'environment must be live or test';
  end if;

  -- Expiry is optional, but a date already in the past would mint a key that
  -- the router rejects on its very first call. Refuse it here instead.
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future.';
  end if;

  -- account state (alias-qualified: pr.id, never bare id)
  select pr.status into v_status
  from public.profiles pr
  where pr.id = v_user;

  if v_status is null then
    -- profile row missing (signup trigger never ran) — create it now so the
    -- console is not permanently blocked
    insert into public.profiles (id, email, full_name)
    select v_user,
           coalesce(u.email, ''),
           nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '')
    from auth.users u
    where u.id = v_user
    on conflict (id) do nothing;
    v_status := 'active';
  end if;

  if v_status = 'suspended' then
    raise exception 'This account is suspended, so new keys cannot be issued.'
      using errcode = '42501';
  end if;

  select count(*) into v_active
  from public.api_keys k
  where k.user_id = v_user
    and k.status = 'active';

  if v_active >= 25 then
    raise exception 'Key limit reached (25 active keys). Revoke one first.';
  end if;

  -- rs_live_ / rs_test_ + 40 hex chars (160 bits from two v4 UUIDs)
  v_prefix := 'rr_' || v_env || '_';
  v_full   := v_prefix || substr(replace(gen_random_uuid()::text, '-', '') ||
                                replace(gen_random_uuid()::text, '-', ''), 1, 40);

  insert into public.api_keys as k
    (user_id, name, environment, key_prefix, key_last4, key_hash,
     monthly_budget_usd, expires_at)
  values
    (v_user, v_name, v_env, v_prefix, right(v_full, 4),
     encode(sha256(v_full::bytea), 'hex'),
     p_monthly_budget_usd, p_expires_at)
  returning k.id, k.created_at into v_id, v_created;

  return query
    select v_id, v_name, v_full, v_prefix, right(v_full, 4), v_env, v_created;
end $$;

grant execute on function public.create_api_key(text, text, numeric, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- set_api_key_expiry — change (or clear) a key's expiry after it was minted.
--   Kept separate from update_api_key so that function keeps its existing
--   signature: adding a fifth defaulted parameter would leave PostgREST with
--   two overloads to choose between, which is the failure mode v5.4 fixed.
-- ----------------------------------------------------------------------------
create or replace function public.set_api_key_expiry(
  p_key_id     uuid,
  p_expires_at timestamptz
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future.';
  end if;

  update public.api_keys
     set expires_at = p_expires_at
   where id = p_key_id
     and (user_id = auth.uid() or public.is_admin());
  if not found then
    raise exception 'Key not found' using errcode = '42501';
  end if;
end $$;

grant execute on function public.set_api_key_expiry(uuid, timestamptz) to authenticated;

create or replace function public.revoke_api_key(p_key_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.api_keys
     set status = 'revoked', revoked_at = now()
   where id = p_key_id
     and (user_id = auth.uid() or public.is_admin());
  if not found then
    raise exception 'Key not found' using errcode = '42501';
  end if;
end $$;

create or replace function public.update_api_key(
  p_key_id uuid,
  p_name   text default null,
  p_monthly_budget_usd numeric default null,
  p_status text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.api_keys
     set name               = coalesce(nullif(trim(p_name), ''), name),
         monthly_budget_usd = coalesce(p_monthly_budget_usd, monthly_budget_usd),
         status             = coalesce(nullif(p_status, ''), status)
   where id = p_key_id
     and (user_id = auth.uid() or public.is_admin());
  if not found then
    raise exception 'Key not found' using errcode = '42501';
  end if;
end $$;

-- Usage summary for the console (no upstream data in the result)
create or replace function public.my_usage_summary(p_days int default 30)
returns jsonb
language sql stable security definer set search_path = public as $$
  with win as (
    select * from public.request_logs
    where user_id = auth.uid()
      and created_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  )
  select jsonb_build_object(
    'days',          greatest(coalesce(p_days, 30), 1),
    'requests',      (select count(*) from win),
    'ok',            (select count(*) from win where ok),
    'failed',        (select count(*) from win where not ok),
    'tokens_in',     (select coalesce(sum(tokens_in), 0)  from win),
    'tokens_out',    (select coalesce(sum(tokens_out), 0) from win),
    'cost_usd',      (select coalesce(sum(cost_usd), 0)   from win),
    'avg_latency_ms',(select coalesce(round(avg(latency_ms)), 0) from win),
    'active_keys',   (select count(*) from public.api_keys
                       where user_id = auth.uid() and status = 'active'),
    'last_request_at', (select max(created_at) from win)
  );
$$;

-- Daily series for the console chart
create or replace function public.my_usage_series(p_days int default 14)
returns table (day date, requests bigint, failed bigint, tokens bigint, cost_usd numeric)
language sql stable security definer set search_path = public as $$
  select d::date as day,
         count(l.id)                                   as requests,
         count(l.id) filter (where not l.ok)           as failed,
         coalesce(sum(l.tokens_in + l.tokens_out), 0)  as tokens,
         coalesce(sum(l.cost_usd), 0)                  as cost_usd
  from generate_series(
         (current_date - (greatest(coalesce(p_days, 14), 1) - 1))::date,
         current_date, interval '1 day') d
  left join public.request_logs l
         on l.user_id = auth.uid()
        and l.created_at >= d
        and l.created_at <  d + interval '1 day'
  group by d
  order by d;
$$;

-- ============================================================================
-- 12. ADMIN RPCs
-- ============================================================================
create or replace function public.admin_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users',            (select count(*) from public.profiles),
    'admins',           (select count(*) from public.profiles where role = 'admin'),
    'upstreams',        (select count(*) from public.upstreams),
    'upstreams_active', (select count(*) from public.upstreams where is_active),
    'models',           (select count(*) from public.models where is_active),
    'keys_total',       (select count(*) from public.upstream_keys),
    'keys_working',     (select count(*) from public.upstream_keys where status = 'working' and is_active),
    'keys_failing',     (select count(*) from public.upstream_keys where status in ('failing','expired','rate_limited')),
    'keys_unknown',     (select count(*) from public.upstream_keys where status = 'unknown'),
    'user_keys',        (select count(*) from public.api_keys where status = 'active'),
    'requests_24h',     (select count(*) from public.request_logs where created_at > now() - interval '24 hours'),
    'errors_24h',       (select count(*) from public.request_logs where not ok and created_at > now() - interval '24 hours'),
    'cost_24h',         (select coalesce(sum(cost_usd), 0) from public.request_logs where created_at > now() - interval '24 hours'),
    'cost_30d',         (select coalesce(sum(cost_usd), 0) from public.request_logs where created_at > now() - interval '30 days'),
    'avg_latency_24h',  (select coalesce(round(avg(latency_ms)), 0) from public.request_logs where created_at > now() - interval '24 hours')
  );
end $$;

-- Reveal one upstream key in the admin panel (audited)
create or replace function public.admin_reveal_upstream_key(p_key_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select api_key into v_key from public.upstream_keys where id = p_key_id;
  if v_key is null then
    raise exception 'Key not found';
  end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'reveal_upstream_key', 'upstream_keys', p_key_id::text);

  return v_key;
end $$;

-- Manual status override, e.g. mark a key dead without deleting it
create or replace function public.admin_set_upstream_key_status(
  p_key_id uuid, p_status text, p_note text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_status not in ('unknown','working','failing','rate_limited','expired','disabled') then
    raise exception 'Invalid status %', p_status;
  end if;

  update public.upstream_keys
     set status          = p_status,
         is_active       = case when p_status in ('disabled','expired') then false else is_active end,
         last_error      = coalesce(p_note, last_error),
         last_checked_at = now()
   where id = p_key_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'set_upstream_key_status', 'upstream_keys', p_key_id::text,
          jsonb_build_object('status', p_status, 'note', p_note));
end $$;

create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_role not in ('user','admin') then
    raise exception 'Invalid role %', p_role;
  end if;
  if p_role = 'user' and p_user_id = auth.uid() then
    raise exception 'You cannot remove your own admin access';
  end if;

  update public.profiles set role = p_role where id = p_user_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'set_user_role', 'profiles', p_user_id::text, jsonb_build_object('role', p_role));
end $$;

create or replace function public.admin_set_user_status(p_user_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_status not in ('active','suspended') then
    raise exception 'Invalid status %', p_status;
  end if;

  update public.profiles set status = p_status where id = p_user_id;

  if p_status = 'suspended' then
    update public.api_keys set status = 'disabled'
     where user_id = p_user_id and status = 'active';
  end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'set_user_status', 'profiles', p_user_id::text, jsonb_build_object('status', p_status));
end $$;

-- ============================================================================
-- 13. INTERNAL RPCs — used ONLY by the router Edge Function (service role).
--     Execute is revoked from anon/authenticated further down.
-- ============================================================================

-- Authenticate an incoming rs_live_… key by its sha256 hash
create or replace function public.internal_auth_key(p_key_hash text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'api_key_id',        k.id,
    'user_id',           k.user_id,
    'name',              k.name,
    'environment',       k.environment,
    'status',            k.status,
    'allowed_models',    k.allowed_models,
    'rate_limit_rpm',    k.rate_limit_rpm,
    'monthly_budget_usd',k.monthly_budget_usd,
    'spend_usd',         k.spend_usd,
    'expires_at',        k.expires_at,
    'user_status',       p.status,
    'user_budget_usd',   p.monthly_budget_usd,
    'month_spend_usd',   coalesce((
        select sum(l.cost_usd) from public.request_logs l
        where l.api_key_id = k.id
          and l.created_at >= date_trunc('month', now())), 0)
  )
  from public.api_keys k
  join public.profiles p on p.id = k.user_id
  where k.key_hash = p_key_hash;
$$;

-- Resolve "what the caller asked for" -> hidden upstream + real model id.
-- p_model may be a public model id, or a policy: auto | auto:balanced |
-- auto:cheapest | auto:fastest.
create or replace function public.internal_resolve_route(p_model text)
returns table (
  model_id uuid, public_id text, upstream_model_id text,
  price_in_per_m numeric, price_out_per_m numeric,
  upstream_id uuid, upstream_name text, base_url text, chat_path text,
  models_path text, auth_scheme text, auth_header text, auth_query_arg text,
  extra_headers jsonb, timeout_ms int, priority int
)
language sql stable security definer set search_path = public as $$
  with want as (select lower(coalesce(nullif(trim(p_model), ''), 'auto')) as m),
  pool as (
    select mo.*, up.name as up_name, up.base_url, up.chat_path, up.models_path,
           up.auth_scheme, up.auth_header, up.auth_query_arg, up.extra_headers,
           up.timeout_ms, up.priority
    from public.models mo
    join public.upstreams up on up.id = mo.upstream_id
    where mo.is_active
      and mo.status <> 'disabled'
      and up.is_active
      and exists (select 1 from public.upstream_keys uk
                  where uk.upstream_id = up.id
                    and uk.is_active
                    and uk.status in ('working','unknown','rate_limited'))
  )
  select p.id, p.public_id, p.upstream_model_id, p.price_in_per_m, p.price_out_per_m,
         p.upstream_id, p.up_name, p.base_url, p.chat_path, p.models_path,
         p.auth_scheme, p.auth_header, p.auth_query_arg, p.extra_headers,
         p.timeout_ms, p.priority
  from pool p, want w
  where w.m not like 'auto%' and lower(p.public_id) = w.m
  union all
  select p.id, p.public_id, p.upstream_model_id, p.price_in_per_m, p.price_out_per_m,
         p.upstream_id, p.up_name, p.base_url, p.chat_path, p.models_path,
         p.auth_scheme, p.auth_header, p.auth_query_arg, p.extra_headers,
         p.timeout_ms, p.priority
  from pool p, want w
  where w.m like 'auto%'
  order by 1;
$$;

-- Ordered candidate list for a policy (best first) — powers failover
create or replace function public.internal_route_candidates(p_model text)
returns table (
  model_id uuid, public_id text, upstream_model_id text,
  price_in_per_m numeric, price_out_per_m numeric,
  upstream_id uuid, base_url text, chat_path text,
  auth_scheme text, auth_header text, auth_query_arg text,
  extra_headers jsonb, timeout_ms int
)
language sql stable security definer set search_path = public as $$
  with want as (select lower(coalesce(nullif(trim(p_model), ''), 'auto')) as m),
  base as (select r.*, w.m from public.internal_resolve_route(p_model) r, want w)
  select model_id, public_id, upstream_model_id, price_in_per_m, price_out_per_m,
         upstream_id, base_url, chat_path, auth_scheme, auth_header,
         auth_query_arg, extra_headers, timeout_ms
  from base
  order by
    case when m = 'auto:cheapest' then (price_in_per_m + price_out_per_m) end asc nulls last,
    case when m in ('auto','auto:balanced','auto:fastest')
         then priority end asc nulls last,
    case when m = 'auto:fastest' then coalesce((
           select avg(l.latency_ms) from public.request_logs l
           where l.model_public_id = base.public_id
             and l.ok and l.created_at > now() - interval '1 day'), 99999) end asc nulls last,
    (price_in_per_m + price_out_per_m) asc,
    public_id asc;
$$;

-- Healthiest keys for an upstream, best first
create or replace function public.internal_pick_keys(p_upstream_id uuid)
returns table (key_id uuid, api_key text, status text)
language sql stable security definer set search_path = public as $$
  select id, api_key, status
  from public.upstream_keys
  where upstream_id = p_upstream_id
    and is_active
    and status in ('working','unknown','rate_limited')
    and (expires_at is null or expires_at > now())
    and (monthly_budget_usd is null or spend_usd < monthly_budget_usd)
  order by case status when 'working' then 0 when 'unknown' then 1 else 2 end,
           consecutive_failures asc,
           weight desc,
           last_success_at desc nulls last;
$$;

-- Record the outcome of using an upstream key (drives working / not working)
create or replace function public.internal_record_key_result(
  p_key_id uuid, p_ok boolean, p_status_code int default null,
  p_latency_ms int default null, p_error text default null,
  p_cost_usd numeric default 0, p_source text default 'traffic'
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_new text;
begin
  if p_ok then
    v_new := 'working';
  elsif p_status_code in (401, 403) then
    v_new := 'expired';
  elsif p_status_code = 429 then
    v_new := 'rate_limited';
  else
    v_new := 'failing';
  end if;

  update public.upstream_keys
     set status               = v_new,
         last_checked_at      = now(),
         last_status_code     = coalesce(p_status_code, last_status_code),
         last_latency_ms      = coalesce(p_latency_ms, last_latency_ms),
         last_error           = case when p_ok then null else coalesce(p_error, last_error) end,
         last_success_at      = case when p_ok then now() else last_success_at end,
         last_failure_at      = case when p_ok then last_failure_at else now() end,
         success_count        = success_count + case when p_ok then 1 else 0 end,
         failure_count        = failure_count + case when p_ok then 0 else 1 end,
         consecutive_failures = case when p_ok then 0 else consecutive_failures + 1 end,
         spend_usd            = spend_usd + coalesce(p_cost_usd, 0),
         is_active            = case when (not p_ok) and p_status_code in (401, 403)
                                     then false else is_active end
   where id = p_key_id;

  insert into public.upstream_key_checks
    (upstream_key_id, ok, status_code, latency_ms, message, source)
  values (p_key_id, p_ok, p_status_code, p_latency_ms, left(coalesce(p_error, ''), 500),
          case when p_source in ('manual','auto','traffic') then p_source else 'traffic' end);
end $$;

-- Persist one routed request + roll up spend
create or replace function public.internal_log_request(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.request_logs (
    request_id, user_id, api_key_id, model_public_id, policy,
    upstream_id, upstream_key_id, ok, status_code, latency_ms,
    tokens_in, tokens_out, cost_usd, failover_count, streamed,
    error_code, error_message
  )
  values (
    coalesce(p_payload ->> 'request_id', 'req_' || encode(extensions.gen_random_bytes(8), 'hex')),
    nullif(p_payload ->> 'user_id', '')::uuid,
    nullif(p_payload ->> 'api_key_id', '')::uuid,
    p_payload ->> 'model_public_id',
    p_payload ->> 'policy',
    nullif(p_payload ->> 'upstream_id', '')::uuid,
    nullif(p_payload ->> 'upstream_key_id', '')::uuid,
    coalesce((p_payload ->> 'ok')::boolean, false),
    nullif(p_payload ->> 'status_code', '')::int,
    nullif(p_payload ->> 'latency_ms', '')::int,
    coalesce(nullif(p_payload ->> 'tokens_in', '')::int, 0),
    coalesce(nullif(p_payload ->> 'tokens_out', '')::int, 0),
    coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0),
    coalesce(nullif(p_payload ->> 'failover_count', '')::int, 0),
    coalesce((p_payload ->> 'streamed')::boolean, false),
    p_payload ->> 'error_code',
    left(coalesce(p_payload ->> 'error_message', ''), 1000)
  )
  returning id into v_id;

  update public.api_keys
     set request_count = request_count + 1,
         last_used_at  = now(),
         spend_usd     = spend_usd + coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0)
   where id = nullif(p_payload ->> 'api_key_id', '')::uuid;

  return v_id;
end $$;

-- Simple per-minute rate limit check
create or replace function public.internal_rate_check(p_api_key_id uuid, p_limit int)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(count(*), 0) < greatest(coalesce(p_limit, 120), 1)
  from public.request_logs
  where api_key_id = p_api_key_id
    and created_at > now() - interval '1 minute';
$$;

-- Housekeeping: drop logs older than the retention window
create or replace function public.prune_request_logs()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_days int; v_n int;
begin
  select log_retention_days into v_days from public.app_settings where id = 1;
  delete from public.request_logs
   where created_at < now() - make_interval(days => greatest(coalesce(v_days, 30), 1));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ============================================================================
-- 14. SAFE VIEWS
--     These are owner (definer) views: they filter rows themselves and only
--     expose non-secret columns. End users can never read base_url, the
--     upstream name, the upstream model id, or any upstream api key.
-- ============================================================================

drop view if exists public.public_models cascade;
create view public.public_models as
select m.public_id       as id,
       m.display_name    as name,
       m.description,
       m.context_window,
       m.max_output_tokens,
       m.price_in_per_m,
       m.price_out_per_m,
       m.capabilities,
       m.status,
       m.is_default,
       m.sort_order
from public.models m
where m.is_active
  and m.status <> 'disabled'
  and exists (select 1 from public.upstreams u
              where u.id = m.upstream_id and u.is_active);

drop view if exists public.my_api_keys cascade;
create view public.my_api_keys as
select k.id, k.name, k.environment, k.key_prefix, k.key_last4, k.status,
       k.monthly_budget_usd, k.spend_usd, k.request_count, k.rate_limit_rpm,
       k.allowed_models, k.last_used_at, k.expires_at, k.created_at,
       (k.key_prefix || '••••••••' || k.key_last4) as masked_key
from public.api_keys k
where k.user_id = auth.uid();

drop view if exists public.my_request_logs cascade;
create view public.my_request_logs as
select l.id, l.request_id, l.api_key_id, l.model_public_id, l.policy,
       l.ok, l.status_code, l.latency_ms, l.tokens_in, l.tokens_out,
       l.cost_usd, l.failover_count, l.streamed, l.error_code, l.error_message,
       l.created_at
from public.request_logs l
where l.user_id = auth.uid();

-- Aggregate health for the public status page. No upstream identity leaks.
drop view if exists public.route_health cascade;
create view public.route_health as
select m.public_id as model,
       m.display_name as name,
       count(l.id)                                     as requests_24h,
       count(l.id) filter (where l.ok)                 as ok_24h,
       case when count(l.id) = 0 then null
            else round(100.0 * count(l.id) filter (where l.ok) / count(l.id), 2)
       end                                             as success_rate,
       round(avg(l.latency_ms) filter (where l.ok))     as avg_latency_ms,
       max(l.created_at)                               as last_request_at,
       m.status                                        as model_status
from public.models m
left join public.request_logs l
       on l.model_public_id = m.public_id
      and l.created_at > now() - interval '24 hours'
where m.is_active and m.status <> 'disabled'
group by m.public_id, m.display_name, m.status, m.sort_order
order by m.sort_order, m.public_id;

drop view if exists public.gateway_daily_health cascade;
create view public.gateway_daily_health as
select d::date                                      as day,
       count(l.id)                                  as requests,
       count(l.id) filter (where l.ok)              as ok,
       count(l.id) filter (where not l.ok)          as failed,
       round(avg(l.latency_ms) filter (where l.ok)) as avg_latency_ms
from generate_series(current_date - 89, current_date, interval '1 day') d
left join public.request_logs l
       on l.created_at >= d and l.created_at < d + interval '1 day'
group by d
order by d;

-- Admin view of upstream keys: masked by default, full value only via
-- admin_reveal_upstream_key(). Row filter = caller must be an admin.
drop view if exists public.admin_upstream_keys cascade;
create view public.admin_upstream_keys as
select k.id, k.upstream_id, u.name as upstream_name, u.slug as upstream_slug,
       k.label,
       ('••••••••' || k.key_last4)    as masked_key,
       length(k.api_key)               as key_length,
       k.status, k.is_active, k.weight,
       k.last_checked_at, k.last_success_at, k.last_failure_at,
       k.last_status_code, k.last_latency_ms, k.last_error,
       k.success_count, k.failure_count, k.consecutive_failures,
       k.monthly_budget_usd, k.spend_usd, k.expires_at, k.notes, k.created_at
from public.upstream_keys k
join public.upstreams u on u.id = k.upstream_id
where public.is_admin()
order by u.name, k.label;

drop view if exists public.admin_users cascade;
create view public.admin_users as
select p.id, p.email, p.full_name, p.org, p.plan, p.role, p.status,
       p.monthly_budget_usd, p.rate_limit_rpm, p.created_at,
       (select count(*) from public.api_keys k
         where k.user_id = p.id and k.status = 'active')            as active_keys,
       (select count(*) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days')           as requests_30d,
       (select coalesce(sum(l.cost_usd), 0) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days')           as cost_30d,
       (select max(l.created_at) from public.request_logs l
         where l.user_id = p.id)                                    as last_request_at
from public.profiles p
where public.is_admin()
order by p.created_at desc;

-- ============================================================================
-- 15. ROW LEVEL SECURITY
-- ============================================================================
alter table public.app_settings        enable row level security;
alter table public.profiles            enable row level security;
alter table public.upstreams           enable row level security;
alter table public.upstream_keys       enable row level security;
alter table public.upstream_key_checks enable row level security;
alter table public.models              enable row level security;
alter table public.api_keys            enable row level security;
alter table public.request_logs        enable row level security;
alter table public.audit_logs          enable row level security;

-- app_settings: everyone signed in can read the non-secret config, admins write
drop policy if exists app_settings_read  on public.app_settings;
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_read  on public.app_settings for select
  using (true);
create policy app_settings_admin on public.app_settings for all
  using (public.is_admin()) with check (public.is_admin());

-- profiles: own row, admins all
drop policy if exists profiles_self_read   on public.profiles;
drop policy if exists profiles_self_write  on public.profiles;
drop policy if exists profiles_admin_all   on public.profiles;
create policy profiles_self_read  on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy profiles_self_write on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
create policy profiles_admin_all  on public.profiles for all
  using (public.is_admin()) with check (public.is_admin());

-- upstreams / upstream_keys / models: ADMIN ONLY. No policy for normal users,
-- so PostgREST returns nothing for them — the original API stays invisible.
drop policy if exists upstreams_admin      on public.upstreams;
drop policy if exists upstream_keys_admin  on public.upstream_keys;
drop policy if exists key_checks_admin     on public.upstream_key_checks;
drop policy if exists models_admin         on public.models;
create policy upstreams_admin     on public.upstreams for all
  using (public.is_admin()) with check (public.is_admin());
create policy upstream_keys_admin on public.upstream_keys for all
  using (public.is_admin()) with check (public.is_admin());
create policy key_checks_admin    on public.upstream_key_checks for all
  using (public.is_admin()) with check (public.is_admin());
create policy models_admin        on public.models for all
  using (public.is_admin()) with check (public.is_admin());

-- api_keys: owner reads/edits own metadata, admins everything
drop policy if exists api_keys_owner on public.api_keys;
drop policy if exists api_keys_admin on public.api_keys;
create policy api_keys_owner on public.api_keys for select
  using (user_id = auth.uid());
create policy api_keys_admin on public.api_keys for all
  using (public.is_admin()) with check (public.is_admin());

-- request_logs: owner reads own rows (via view), admins everything
drop policy if exists request_logs_owner on public.request_logs;
drop policy if exists request_logs_admin on public.request_logs;
create policy request_logs_owner on public.request_logs for select
  using (user_id = auth.uid());
create policy request_logs_admin on public.request_logs for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists audit_logs_admin on public.audit_logs;
create policy audit_logs_admin on public.audit_logs for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 16. GRANTS
-- ============================================================================
grant usage on schema public to anon, authenticated, service_role;

grant select                         on public.app_settings        to anon, authenticated;
grant select, insert, update, delete on public.app_settings        to authenticated;
grant select, update                 on public.profiles            to authenticated;
grant select, insert, update, delete on public.upstreams           to authenticated;
grant select, insert, update, delete on public.upstream_keys       to authenticated;
grant select, insert, update, delete on public.upstream_key_checks to authenticated;
grant select, insert, update, delete on public.models              to authenticated;
grant select, update                 on public.api_keys            to authenticated;
grant select                         on public.request_logs        to authenticated;
grant select, insert                 on public.audit_logs          to authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- views
grant select on public.public_models        to anon, authenticated;
grant select on public.route_health         to anon, authenticated;
grant select on public.gateway_daily_health to anon, authenticated;
grant select on public.my_api_keys          to authenticated;
grant select on public.my_request_logs      to authenticated;
grant select on public.admin_upstream_keys  to authenticated;
grant select on public.admin_users          to authenticated;

-- user + admin RPCs
grant execute on function public.is_admin(uuid)                                to anon, authenticated;
grant execute on function public.create_api_key(text, text, numeric, timestamptz) to authenticated;
grant execute on function public.set_api_key_expiry(uuid, timestamptz)         to authenticated;
grant execute on function public.revoke_api_key(uuid)                          to authenticated;
grant execute on function public.update_api_key(uuid, text, numeric, text)     to authenticated;
grant execute on function public.my_usage_summary(int)                         to authenticated;
grant execute on function public.my_usage_series(int)                          to authenticated;
grant execute on function public.admin_dashboard()                             to authenticated;
grant execute on function public.admin_reveal_upstream_key(uuid)               to authenticated;
grant execute on function public.admin_set_upstream_key_status(uuid, text, text) to authenticated;
grant execute on function public.admin_set_user_role(uuid, text)               to authenticated;
grant execute on function public.admin_set_user_status(uuid, text)             to authenticated;

-- internal routing RPCs: service role only (never the browser)
revoke execute on function public.internal_auth_key(text)                                  from anon, authenticated;
revoke execute on function public.internal_resolve_route(text)                             from anon, authenticated;
revoke execute on function public.internal_route_candidates(text)                          from anon, authenticated;
revoke execute on function public.internal_pick_keys(uuid)                                 from anon, authenticated;
revoke execute on function public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text) from anon, authenticated;
revoke execute on function public.internal_log_request(jsonb)                              from anon, authenticated;
revoke execute on function public.internal_rate_check(uuid, int)                           from anon, authenticated;
revoke execute on function public.prune_request_logs()                                     from anon, authenticated;

grant execute on function public.internal_auth_key(text)                                   to service_role;
grant execute on function public.internal_resolve_route(text)                              to service_role;
grant execute on function public.internal_route_candidates(text)                           to service_role;
grant execute on function public.internal_pick_keys(uuid)                                  to service_role;
grant execute on function public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text) to service_role;
grant execute on function public.internal_log_request(jsonb)                               to service_role;
grant execute on function public.internal_rate_check(uuid, int)                            to service_role;
grant execute on function public.prune_request_logs()                                      to service_role;

-- Nothing new is auto-exposed to the browser by default
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on functions from anon;

-- ============================================================================
-- 17. CREDITS  (v5.4)
-- ----------------------------------------------------------------------------
-- A prepaid USD balance per account.
--
--   · profiles.credit_balance_usd  — the cached balance the UI reads
--   · public.credit_ledger         — append-only history (the real source of
--                                    truth: every grant, top-up and charge)
--   · every routed request is priced by the router, debited automatically
--     inside internal_log_request(), and written to the ledger as `usage`
--   · when app_settings.credits_enabled is on, the gateway answers 402
--     insufficient_credits once an account is out of balance
--
-- Enforcement ships OFF so nothing breaks the moment you paste this in.
-- Turn it on in Admin → Credits once balances look right.
-- ============================================================================

-- ---------------------------------------------------------------- settings --
alter table public.app_settings
  add column if not exists credits_enabled   boolean       not null default false,
  add column if not exists signup_credit_usd numeric(12,4) not null default 5,
  add column if not exists low_balance_usd   numeric(12,4) not null default 1,
  add column if not exists overdraft_usd     numeric(12,4) not null default 0,
  add column if not exists topup_note        text;

-- ------------------------------------------------------- balance on profile --
alter table public.profiles
  add column if not exists credit_balance_usd numeric(14,6) not null default 0,
  add column if not exists credits_added_usd  numeric(14,6) not null default 0,
  add column if not exists credits_used_usd   numeric(14,6) not null default 0;

-- ------------------------------------------------------------------ ledger --
create table if not exists public.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  kind            text not null check (kind in ('signup_grant','admin_grant',
                    'admin_deduct','topup','usage','refund','adjustment')),
  delta_usd       numeric(14,6) not null,
  balance_after   numeric(14,6) not null,
  description     text,
  request_id      text,
  api_key_id      uuid references public.api_keys (id) on delete set null,
  model_public_id text,
  actor_id        uuid references auth.users (id) on delete set null,
  actor_email     text,
  created_at      timestamptz not null default now()
);

create index if not exists credit_ledger_user_idx    on public.credit_ledger (user_id, created_at desc);
create index if not exists credit_ledger_kind_idx    on public.credit_ledger (kind, created_at desc);
create index if not exists credit_ledger_request_idx on public.credit_ledger (request_id);

-- ------------------------------------------------------------ the one mover --
-- Everything that changes a balance goes through here: it updates the cached
-- balance and writes the matching ledger row in the same statement pair.
-- Positive delta = money in, negative delta = money out.
create or replace function public.internal_credit_move(
  p_user_id     uuid,
  p_delta_usd   numeric,
  p_kind        text,
  p_description text default null,
  p_request_id  text default null,
  p_api_key_id  uuid default null,
  p_model       text default null,
  p_actor_id    uuid default null,
  p_actor_email text default null
)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_delta   numeric(14,6) := round(coalesce(p_delta_usd, 0)::numeric, 6);
  v_balance numeric(14,6);
begin
  if p_user_id is null then
    return null;
  end if;

  if v_delta = 0 then
    select pr.credit_balance_usd into v_balance
    from public.profiles pr where pr.id = p_user_id;
    return v_balance;
  end if;

  update public.profiles pr
     set credit_balance_usd = pr.credit_balance_usd + v_delta,
         credits_added_usd  = pr.credits_added_usd + greatest(v_delta, 0),
         credits_used_usd   = pr.credits_used_usd  + greatest(-v_delta, 0),
         updated_at         = now()
   where pr.id = p_user_id
  returning pr.credit_balance_usd into v_balance;

  if v_balance is null then
    return null;                       -- unknown account: nothing to charge
  end if;

  insert into public.credit_ledger
    (user_id, kind, delta_usd, balance_after, description,
     request_id, api_key_id, model_public_id, actor_id, actor_email)
  values
    (p_user_id, p_kind, v_delta, v_balance, nullif(btrim(coalesce(p_description, '')), ''),
     nullif(p_request_id, ''), p_api_key_id, nullif(p_model, ''),
     p_actor_id, nullif(p_actor_email, ''));

  return v_balance;
end $$;

-- Users may read their profile but must never be able to write themselves
-- free credit, so the credit columns are locked to the billing system.
create or replace function public.guard_profile_credits()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  if new.credit_balance_usd is distinct from old.credit_balance_usd
     or new.credits_added_usd is distinct from old.credits_added_usd
     or new.credits_used_usd  is distinct from old.credits_used_usd then
    raise exception 'Credit balances can only be changed by the billing system'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_credits on public.profiles;
create trigger profiles_guard_credits
  before update on public.profiles
  for each row execute function public.guard_profile_credits();

-- --------------------------------------------------------- user-facing RPC --
create or replace function public.my_credits()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_bal  numeric(14,6);
  v_add  numeric(14,6);
  v_used numeric(14,6);
  v_on   boolean;
  v_low  numeric(12,4);
  v_over numeric(12,4);
  v_30d  numeric(14,6);
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select pr.credit_balance_usd, pr.credits_added_usd, pr.credits_used_usd
    into v_bal, v_add, v_used
  from public.profiles pr where pr.id = v_user;

  select s.credits_enabled, s.low_balance_usd, s.overdraft_usd
    into v_on, v_low, v_over
  from public.app_settings s where s.id = 1;

  select coalesce(sum(l.cost_usd), 0) into v_30d
  from public.request_logs l
  where l.user_id = v_user
    and l.created_at > now() - interval '30 days';

  return jsonb_build_object(
    'balance_usd',     coalesce(v_bal, 0),
    'added_usd',       coalesce(v_add, 0),
    'used_usd',        coalesce(v_used, 0),
    'enforced',        coalesce(v_on, false),
    'overdraft_usd',   coalesce(v_over, 0),
    'low_balance_usd', coalesce(v_low, 0),
    'low',             coalesce(v_bal, 0) <= coalesce(v_low, 0),
    'spend_24h',       (select coalesce(sum(l.cost_usd), 0) from public.request_logs l
                         where l.user_id = v_user and l.created_at > now() - interval '24 hours'),
    'spend_7d',        (select coalesce(sum(l.cost_usd), 0) from public.request_logs l
                         where l.user_id = v_user and l.created_at > now() - interval '7 days'),
    'spend_30d',       coalesce(v_30d, 0),
    'daily_burn_usd',  round(coalesce(v_30d, 0) / 30.0, 6),
    'requests_30d',    (select count(*) from public.request_logs l
                         where l.user_id = v_user and l.created_at > now() - interval '30 days'),
    'last_topup_at',   (select max(c.created_at) from public.credit_ledger c
                         where c.user_id = v_user and c.delta_usd > 0),
    'entries',         (select count(*) from public.credit_ledger c where c.user_id = v_user)
  );
end $$;

drop view if exists public.my_credit_ledger cascade;
create view public.my_credit_ledger as
select c.id, c.kind, c.delta_usd, c.balance_after, c.description,
       c.request_id, c.api_key_id, c.model_public_id, c.created_at
from public.credit_ledger c
where c.user_id = auth.uid();

-- -------------------------------------------------------------- admin RPCs --
-- Positive amount adds credit, negative amount takes it away. Audited.
create or replace function public.admin_adjust_credits(
  p_user_id    uuid,
  p_amount_usd numeric,
  p_note       text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_amount  numeric(14,6) := round(coalesce(p_amount_usd, 0)::numeric, 6);
  v_email   text;
  v_balance numeric(14,6);
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'Pick an account first';
  end if;
  if v_amount = 0 then
    raise exception 'Amount cannot be zero';
  end if;
  if abs(v_amount) > 1000000 then
    raise exception 'Amount looks wrong (max $1,000,000 per adjustment)';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id) then
    raise exception 'Account not found';
  end if;

  select pr.email into v_email from public.profiles pr where pr.id = auth.uid();

  v_balance := public.internal_credit_move(
    p_user_id, v_amount,
    case when v_amount > 0 then 'admin_grant' else 'admin_deduct' end,
    coalesce(nullif(btrim(coalesce(p_note, '')), ''),
             case when v_amount > 0 then 'credit added by admin'
                  else 'credit removed by admin' end),
    null, null, null, auth.uid(), v_email);

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email,
          case when v_amount > 0 then 'grant_credits' else 'deduct_credits' end,
          'profiles', p_user_id::text,
          jsonb_build_object('amount_usd', v_amount,
                             'balance_after', v_balance,
                             'note', p_note));

  return jsonb_build_object('user_id', p_user_id, 'amount_usd', v_amount,
                            'balance_usd', v_balance);
end $$;

-- Set an exact balance instead of nudging it. Audited.
create or replace function public.admin_set_credit_balance(
  p_user_id     uuid,
  p_balance_usd numeric,
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_target  numeric(14,6) := round(coalesce(p_balance_usd, 0)::numeric, 6);
  v_current numeric(14,6);
  v_email   text;
  v_balance numeric(14,6);
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select pr.credit_balance_usd into v_current
  from public.profiles pr where pr.id = p_user_id;
  if v_current is null then
    raise exception 'Account not found';
  end if;

  select pr.email into v_email from public.profiles pr where pr.id = auth.uid();

  if v_target = v_current then
    return jsonb_build_object('user_id', p_user_id, 'balance_usd', v_current,
                              'changed', false);
  end if;

  v_balance := public.internal_credit_move(
    p_user_id, v_target - v_current, 'adjustment',
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'balance set by admin'),
    null, null, null, auth.uid(), v_email);

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'set_credit_balance', 'profiles', p_user_id::text,
          jsonb_build_object('from', v_current, 'to', v_balance, 'note', p_note));

  return jsonb_build_object('user_id', p_user_id, 'balance_usd', v_balance,
                            'changed', true);
end $$;

drop view if exists public.admin_credit_ledger cascade;
create view public.admin_credit_ledger as
select c.id, c.user_id, pr.email as user_email, pr.full_name as user_name,
       c.kind, c.delta_usd, c.balance_after, c.description, c.request_id,
       c.model_public_id, c.actor_email, c.created_at
from public.credit_ledger c
left join public.profiles pr on pr.id = c.user_id
where public.is_admin()
order by c.created_at desc;

-- admin_users gains the credit columns the admin panel shows
drop view if exists public.admin_users cascade;
create view public.admin_users as
select p.id, p.email, p.full_name, p.org, p.plan, p.role, p.status,
       p.monthly_budget_usd, p.rate_limit_rpm, p.created_at,
       p.credit_balance_usd, p.credits_added_usd, p.credits_used_usd,
       (select count(*) from public.api_keys k
         where k.user_id = p.id and k.status = 'active')            as active_keys,
       (select count(*) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days')           as requests_30d,
       (select coalesce(sum(l.cost_usd), 0) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days')           as cost_30d,
       (select max(l.created_at) from public.request_logs l
         where l.user_id = p.id)                                    as last_request_at
from public.profiles p
where public.is_admin()
order by p.created_at desc;

-- ------------------------------------------------- new signups get credit --
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_admin  boolean := false;
  v_emails text[];
  v_credit numeric(12,4);
begin
  select s.admin_emails, s.signup_credit_usd
    into v_emails, v_credit
  from public.app_settings s where s.id = 1;

  if new.email is not null and exists (
       select 1 from unnest(coalesce(v_emails, '{}'::text[])) e
       where lower(e) = lower(new.email)) then
    v_admin := true;
  end if;

  if not exists (select 1 from public.profiles pr where pr.role = 'admin') then
    v_admin := true;
  end if;

  insert into public.profiles (id, email, full_name, org, role)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name',
                         new.raw_user_meta_data ->> 'name', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'org', '')), ''),
    case when v_admin then 'admin' else 'user' end
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        org       = coalesce(public.profiles.org, excluded.org);

  -- welcome credit (once per account)
  if coalesce(v_credit, 0) > 0 and not exists (
       select 1 from public.credit_ledger c
       where c.user_id = new.id and c.kind = 'signup_grant') then
    perform public.internal_credit_move(new.id, v_credit, 'signup_grant',
                                        'welcome credit');
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------- router: auth + metering hooks --
-- internal_auth_key now also reports the balance so the gateway can refuse a
-- call before it spends money upstream.
create or replace function public.internal_auth_key(p_key_hash text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'api_key_id',        k.id,
    'user_id',           k.user_id,
    'name',              k.name,
    'environment',       k.environment,
    'status',            k.status,
    'allowed_models',    k.allowed_models,
    'rate_limit_rpm',    k.rate_limit_rpm,
    'monthly_budget_usd',k.monthly_budget_usd,
    'spend_usd',         k.spend_usd,
    'expires_at',        k.expires_at,
    'user_status',       p.status,
    'user_budget_usd',   p.monthly_budget_usd,
    'credits_enabled',   coalesce((select s.credits_enabled from public.app_settings s where s.id = 1), false),
    'credit_balance_usd',coalesce(p.credit_balance_usd, 0),
    'credit_overdraft_usd', coalesce((select s.overdraft_usd from public.app_settings s where s.id = 1), 0),
    'month_spend_usd',   coalesce((
        select sum(l.cost_usd) from public.request_logs l
        where l.api_key_id = k.id
          and l.created_at >= date_trunc('month', now())), 0)
  )
  from public.api_keys k
  join public.profiles p on p.id = k.user_id
  where k.key_hash = p_key_hash;
$$;

-- internal_log_request now debits the balance for every priced request and
-- returns the request row id exactly as before.
create or replace function public.internal_log_request(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid;
  v_cost numeric(14,6) := coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0);
  v_user uuid          := nullif(p_payload ->> 'user_id', '')::uuid;
  v_key  uuid          := nullif(p_payload ->> 'api_key_id', '')::uuid;
  v_req  text          := coalesce(p_payload ->> 'request_id',
                            'req_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
begin
  insert into public.request_logs (
    request_id, user_id, api_key_id, model_public_id, policy,
    upstream_id, upstream_key_id, ok, status_code, latency_ms,
    tokens_in, tokens_out, cost_usd, failover_count, streamed,
    error_code, error_message
  )
  values (
    v_req,
    v_user,
    v_key,
    p_payload ->> 'model_public_id',
    p_payload ->> 'policy',
    nullif(p_payload ->> 'upstream_id', '')::uuid,
    nullif(p_payload ->> 'upstream_key_id', '')::uuid,
    coalesce((p_payload ->> 'ok')::boolean, false),
    nullif(p_payload ->> 'status_code', '')::int,
    nullif(p_payload ->> 'latency_ms', '')::int,
    coalesce(nullif(p_payload ->> 'tokens_in', '')::int, 0),
    coalesce(nullif(p_payload ->> 'tokens_out', '')::int, 0),
    v_cost,
    coalesce(nullif(p_payload ->> 'failover_count', '')::int, 0),
    coalesce((p_payload ->> 'streamed')::boolean, false),
    p_payload ->> 'error_code',
    left(coalesce(p_payload ->> 'error_message', ''), 1000)
  )
  returning id into v_id;

  if v_key is not null then
    update public.api_keys k
       set request_count = k.request_count + 1,
           last_used_at  = now(),
           spend_usd     = k.spend_usd + v_cost
     where k.id = v_key;
  end if;

  -- charge the account's credit balance
  if v_cost > 0 and v_user is not null then
    perform public.internal_credit_move(
      v_user, -v_cost, 'usage',
      coalesce(nullif(p_payload ->> 'model_public_id', ''), 'gateway request'),
      v_req, v_key, p_payload ->> 'model_public_id');
  end if;

  return v_id;
end $$;

-- request ids no longer need pgcrypto in the extensions schema
alter table public.request_logs
  alter column request_id
  set default ('req_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));

-- --------------------------------------------- give existing accounts credit --
do $$
declare
  v_credit numeric(12,4);
  r        record;
begin
  select s.signup_credit_usd into v_credit
  from public.app_settings s where s.id = 1;

  if coalesce(v_credit, 0) <= 0 then
    return;
  end if;

  for r in
    select p.id from public.profiles p
    where not exists (select 1 from public.credit_ledger c where c.user_id = p.id)
  loop
    perform public.internal_credit_move(r.id, v_credit, 'signup_grant',
                                        'welcome credit (existing account)');
  end loop;
end $$;

-- ------------------------------------------------------------ RLS + grants --
alter table public.credit_ledger enable row level security;

drop policy if exists credit_ledger_owner on public.credit_ledger;
drop policy if exists credit_ledger_admin on public.credit_ledger;
create policy credit_ledger_owner on public.credit_ledger for select
  using (user_id = auth.uid());
create policy credit_ledger_admin on public.credit_ledger for all
  using (public.is_admin()) with check (public.is_admin());

grant select on public.credit_ledger       to authenticated;
grant select on public.my_credit_ledger    to authenticated;
grant select on public.admin_credit_ledger to authenticated;
grant select on public.admin_users         to authenticated;
grant all    on public.credit_ledger       to service_role;

grant execute on function public.my_credits()                                      to authenticated;
grant execute on function public.admin_adjust_credits(uuid, numeric, text)         to authenticated;
grant execute on function public.admin_set_credit_balance(uuid, numeric, text)     to authenticated;

revoke execute on function public.internal_credit_move(uuid, numeric, text, text, text, uuid, text, uuid, text) from anon, authenticated;
grant  execute on function public.internal_credit_move(uuid, numeric, text, text, text, uuid, text, uuid, text) to service_role;
grant  execute on function public.internal_auth_key(text)                          to service_role;
grant  execute on function public.internal_log_request(jsonb)                      to service_role;
revoke execute on function public.internal_auth_key(text)                          from anon, authenticated;
revoke execute on function public.internal_log_request(jsonb)                      from anon, authenticated;

-- ============================================================================
-- 18. DONE
--   Next: run supabase/seed.sql ONLY if you want an example upstream row.
--   Otherwise add your real upstream + keys + models from the Admin panel.
-- ============================================================================
select 'RageStar schema installed' as result,
       (select count(*) from public.profiles) as profiles,
       (select count(*) from public.upstreams) as upstreams,
       (select count(*) from public.models) as models,
       (select credits_enabled from public.app_settings where id = 1) as credits_enforced,
       (select coalesce(sum(credit_balance_usd), 0) from public.profiles) as credits_outstanding;

notify pgrst, 'reload schema';
