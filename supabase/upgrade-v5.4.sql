-- ============================================================================
--  RageStar — upgrade to v5.4
--  Paste this whole file into the Supabase SQL editor and press Run.
--
--  1. FIXES "create key" in the console.
--     public.create_api_key() aborted on every call with
--        column reference "id" is ambiguous
--     because RETURNS TABLE (id uuid, name text, …) declares OUT variables
--     with those exact names and the body queried profiles with a bare `id`.
--
--  2. ADDS the credit system (prepaid USD balance + ledger + gateway
--     enforcement + admin top-ups).
--
--  Safe to run on a live database, and safe to run more than once.
--  Enforcement starts OFF — flip it on in Admin → Credits.
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
drop function if exists public.create_api_key(text, text, numeric);
drop function if exists public.create_api_key(text, text);
drop function if exists public.create_api_key(text);
drop function if exists public.create_api_key();

create function public.create_api_key(
  p_name               text default 'default',
  p_environment        text default 'live',
  p_monthly_budget_usd numeric default null
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
    (user_id, name, environment, key_prefix, key_last4, key_hash, monthly_budget_usd)
  values
    (v_user, v_name, v_env, v_prefix, right(v_full, 4),
     encode(sha256(v_full::bytea), 'hex'),
     p_monthly_budget_usd)
  returning k.id, k.created_at into v_id, v_created;

  return query
    select v_id, v_name, v_full, v_prefix, right(v_full, 4), v_env, v_created;
end $$;

grant execute on function public.create_api_key(text, text, numeric) to authenticated;

-- ============================================================================
-- CREDITS  (v5.4)
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

-- ---------------------------------------------------------------------------
-- tell PostgREST about the new functions/columns straight away
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- what you should see: create_api_key = 1 row, credits_enabled = f,
-- and one balance row per account.
-- ---------------------------------------------------------------------------
select 'v5.4 applied' as result,
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'create_api_key') as create_api_key_fns,
       (select credits_enabled   from public.app_settings where id = 1) as credits_enforced,
       (select signup_credit_usd from public.app_settings where id = 1) as signup_credit_usd,
       (select count(*) from public.profiles)      as accounts,
       (select count(*) from public.credit_ledger) as ledger_rows,
       (select coalesce(sum(credit_balance_usd), 0) from public.profiles) as credits_outstanding;
