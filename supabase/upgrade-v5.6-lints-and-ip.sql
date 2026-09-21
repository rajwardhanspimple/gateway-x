-- ============================================================================
--  RageStar — v5.6  ·  Supabase linter fixes + IP limits
-- ----------------------------------------------------------------------------
--  Run ONCE in Supabase Dashboard -> SQL Editor -> New query, after
--  schema.sql, upgrade-v5.4.sql and upgrade-v5.5-security.sql.
--  Idempotent: re-running it is harmless.
--
--  PART A — clears every warning in Advisors -> Security / Performance:
--    A1. "Security Definer View" x9
--        admin_users, admin_credit_ledger, admin_upstream_keys,
--        my_api_keys, my_request_logs, my_credit_ledger,
--        public_models, route_health, gateway_daily_health (+ public_settings)
--        Fix: every view becomes security_invoker = on. Views that must stay
--        readable by anon (models / status page / public settings) now read
--        through a SECURITY DEFINER *function* that returns only safe columns,
--        so the upstream name, base_url, real model id and admin_emails still
--        never leave the database.
--    A2. "Auth RLS Initialization Plan" x5 (profiles, api_keys, request_logs,
--        credit_ledger)  Fix: auth.uid() / is_admin() wrapped in (select ...)
--        so Postgres evaluates them once per query instead of once per row.
--    A3. "Multiple Permissive Policies" x3 on api_keys (and the same latent
--        problem on profiles / request_logs / credit_ledger / app_settings)
--        Fix: exactly one policy per table per action, owner OR admin inside.
--    A4. "Function Search Path Mutable" on touch_updated_at (plus a sweep that
--        pins search_path on every other public function).
--    A5. "Leaked Password Protection Disabled" — Auth setting, not SQL.
--        See the note at the bottom of this file; it is one dashboard toggle.
--
--  PART B — IP limits:
--    · api_keys.allowed_ips           per-key IP/CIDR allowlist ({} = any IP)
--    · api_keys.ip_rate_limit_rpm     per-IP requests/minute for that key
--    · app_settings.ip_rate_limit_rpm global per-IP requests/minute default
--    · app_settings.ip_denylist       CIDRs refused everywhere
--    · app_settings.ip_allowlist_required   keys must declare their IPs
--    · app_settings.ip_max_distinct_per_hour  key-sharing guard
--    · app_settings.ip_autoblock_minutes      auto-ban abusive IPs
--    · public.blocked_ips             manual + automatic bans, with expiry
--    · request_logs.client_ip         every request records its caller IP
--    · internal_ip_check()            the gateway calls this before routing
-- ============================================================================

begin;

-- ===========================================================================
-- 0. COLUMNS THIS FILE RELIES ON
-- ===========================================================================

alter table public.app_settings
  add column if not exists allowed_email_domains   text[]        not null default array['gmail.com'],
  add column if not exists credits_enabled         boolean       not null default false,
  add column if not exists signup_credit_usd       numeric(12,4) not null default 5,
  add column if not exists low_balance_usd         numeric(12,4) not null default 1,
  add column if not exists overdraft_usd           numeric(12,4) not null default 0,
  add column if not exists topup_note              text,
  -- IP controls -------------------------------------------------------------
  add column if not exists ip_rate_limit_rpm       int           not null default 0,
  add column if not exists ip_denylist             text[]        not null default '{}',
  add column if not exists ip_allowlist_required   boolean       not null default false,
  add column if not exists ip_max_distinct_per_hour int          not null default 0,
  add column if not exists ip_autoblock_minutes    int           not null default 0;

alter table public.api_keys
  add column if not exists allowed_ips       text[] not null default '{}',
  add column if not exists ip_rate_limit_rpm int    not null default 0;

alter table public.request_logs
  add column if not exists client_ip inet;

create index if not exists request_logs_ip_idx
  on public.request_logs (client_ip, created_at desc);
create index if not exists request_logs_key_ip_idx
  on public.request_logs (api_key_id, client_ip, created_at desc);

comment on column public.api_keys.allowed_ips is
  'IP or CIDR allowlist for this key. Empty array = callable from any address.';
comment on column public.api_keys.ip_rate_limit_rpm is
  'Requests per minute allowed from a single IP using this key. 0 = inherit app_settings.ip_rate_limit_rpm.';

-- ---------------------------------------------------------------------------
-- Ban list (manual bans from the admin panel + automatic bans from the edge)
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_ips (
  id         uuid primary key default gen_random_uuid(),
  ip_range   cidr        not null unique,
  reason     text,
  source     text        not null default 'manual' check (source in ('manual','auto')),
  expires_at timestamptz,                                  -- null = forever
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists blocked_ips_active_idx on public.blocked_ips (expires_at);


-- ===========================================================================
-- 1. IP HELPERS
-- ===========================================================================

-- Never raises: a malformed address becomes NULL instead of a 500.
create or replace function public.safe_inet(p_text text)
returns inet
language plpgsql stable security invoker set search_path = public as $$
begin
  return nullif(btrim(coalesce(p_text, '')), '')::inet;
exception when others then
  return null;
end $$;

-- Is p_ip inside any of the text CIDRs in p_list? Bad entries are skipped.
create or replace function public.ip_in_list(p_ip inet, p_list text[])
returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare
  e text;
  c cidr;
begin
  if p_ip is null or p_list is null then
    return false;
  end if;
  foreach e in array p_list loop
    begin
      c := network(btrim(e)::inet);
      if p_ip <<= c then
        return true;
      end if;
    exception when others then
      continue;
    end;
  end loop;
  return false;
end $$;

-- '1.2.3.4' -> '1.2.3.4/32', '10.0.0.7/8' -> '10.0.0.0/8'. Raises on garbage.
create or replace function public.to_cidr(p_text text)
returns cidr
language plpgsql immutable security invoker set search_path = public as $$
begin
  return network(btrim(coalesce(p_text, ''))::inet);
exception when others then
  raise exception '% is not a valid IP address or CIDR range', p_text
    using errcode = '22023';
end $$;


-- ===========================================================================
-- 2. THE GATEWAY'S IP GATE
-- ---------------------------------------------------------------------------
--  Called by supabase/functions/router with the caller's IP, straight after
--  the API key is authenticated and before any upstream is contacted.
--  Checks, in order: ban list -> workspace denylist -> per-key allowlist ->
--  per-IP rate limit -> key-sharing (distinct IPs per hour) guard.
-- ===========================================================================

create or replace function public.internal_ip_check(p_api_key_id uuid, p_ip text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ip        inet := public.safe_inet(p_ip);
  v_allowed   text[] := '{}';
  v_key_rpm   int  := 0;
  v_global    int  := 0;
  v_deny      text[] := '{}';
  v_required  boolean := false;
  v_fanout    int  := 0;
  v_autoblock int  := 0;
  v_limit     int  := 0;
  v_used      int  := 0;
  v_distinct  int  := 0;
begin
  select coalesce(k.allowed_ips, '{}'), coalesce(k.ip_rate_limit_rpm, 0)
    into v_allowed, v_key_rpm
  from public.api_keys k
  where k.id = p_api_key_id;

  if not found then
    return jsonb_build_object('allowed', false, 'code', 'invalid_api_key',
                              'reason', 'Unknown API key.');
  end if;

  select coalesce(s.ip_rate_limit_rpm, 0),
         coalesce(s.ip_denylist, '{}'),
         coalesce(s.ip_allowlist_required, false),
         coalesce(s.ip_max_distinct_per_hour, 0),
         coalesce(s.ip_autoblock_minutes, 0)
    into v_global, v_deny, v_required, v_fanout, v_autoblock
  from public.app_settings s
  where s.id = 1;

  -- ---- caller IP unknown --------------------------------------------------
  if v_ip is null then
    if v_required or cardinality(v_allowed) > 0 then
      return jsonb_build_object(
        'allowed', false, 'code', 'ip_not_allowed',
        'reason', 'This key only accepts approved IP addresses and the caller address could not be determined.');
    end if;
    return jsonb_build_object('allowed', true, 'code', 'ok', 'ip', null);
  end if;

  -- ---- 1. ban list --------------------------------------------------------
  if exists (
    select 1 from public.blocked_ips b
     where (b.expires_at is null or b.expires_at > now())
       and v_ip <<= b.ip_range
  ) then
    return jsonb_build_object('allowed', false, 'code', 'ip_blocked',
                              'ip', host(v_ip),
                              'reason', 'This IP address is blocked.');
  end if;

  -- ---- 2. workspace denylist ---------------------------------------------
  if public.ip_in_list(v_ip, v_deny) then
    return jsonb_build_object('allowed', false, 'code', 'ip_blocked',
                              'ip', host(v_ip),
                              'reason', 'This IP address is blocked.');
  end if;

  -- ---- 3. per-key allowlist ----------------------------------------------
  if cardinality(v_allowed) > 0 then
    if not public.ip_in_list(v_ip, v_allowed) then
      return jsonb_build_object('allowed', false, 'code', 'ip_not_allowed',
                                'ip', host(v_ip),
                                'reason', 'This API key is locked to other IP addresses.');
    end if;
  elsif v_required then
    return jsonb_build_object('allowed', false, 'code', 'ip_allowlist_required',
                              'ip', host(v_ip),
                              'reason', 'This workspace requires every key to declare its allowed IP addresses.');
  end if;

  -- ---- 4. per-IP rate limit ----------------------------------------------
  v_limit := case when v_key_rpm > 0 then v_key_rpm else v_global end;

  if v_limit > 0 then
    select count(*) into v_used
    from public.request_logs l
    where l.client_ip = v_ip
      and l.created_at > now() - interval '1 minute';

    if v_used >= v_limit then
      -- sustained flood: park the address on the ban list for a while
      if v_autoblock > 0 and v_used >= v_limit * 3 then
        insert into public.blocked_ips (ip_range, reason, source, expires_at)
        values (network(v_ip),
                'auto: ' || v_used || ' requests/min from one address',
                'auto',
                now() + make_interval(mins => v_autoblock))
        on conflict (ip_range) do update
          set expires_at = greatest(coalesce(blocked_ips.expires_at, now()),
                                    excluded.expires_at),
              reason     = excluded.reason;
      end if;

      return jsonb_build_object('allowed', false, 'code', 'ip_rate_limit_exceeded',
                                'ip', host(v_ip), 'limit', v_limit, 'used', v_used,
                                'retry_after', 5,
                                'reason', 'Too many requests from this IP address.');
    end if;
  end if;

  -- ---- 5. key-sharing guard: distinct IPs per key per hour ---------------
  if v_fanout > 0 then
    select count(distinct l.client_ip) into v_distinct
    from public.request_logs l
    where l.api_key_id = p_api_key_id
      and l.client_ip is not null
      and l.created_at > now() - interval '1 hour';

    if v_distinct >= v_fanout
       and not exists (
         select 1 from public.request_logs l
          where l.api_key_id = p_api_key_id
            and l.client_ip = v_ip
            and l.created_at > now() - interval '1 hour'
       ) then
      return jsonb_build_object('allowed', false, 'code', 'ip_fanout_exceeded',
                                'ip', host(v_ip), 'limit', v_fanout,
                                'used', v_distinct,
                                'reason', 'This key has been used from too many different IP addresses this hour.');
    end if;
  end if;

  return jsonb_build_object('allowed', true, 'code', 'ok', 'ip', host(v_ip),
                            'limit', v_limit, 'used', v_used);
end $$;

revoke execute on function public.internal_ip_check(uuid, text) from anon, authenticated;
grant  execute on function public.internal_ip_check(uuid, text) to service_role;

-- Housekeeping: drop bans that have expired.
create or replace function public.prune_ip_blocks()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  delete from public.blocked_ips
   where expires_at is not null and expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function public.prune_ip_blocks() from anon, authenticated;
grant  execute on function public.prune_ip_blocks() to service_role;


-- ===========================================================================
-- 3. LOG THE CALLER IP  (adds client_ip to the metering path)
-- ===========================================================================

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
    error_code, error_message, client_ip
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
    left(coalesce(p_payload ->> 'error_message', ''), 1000),
    public.safe_inet(p_payload ->> 'client_ip')
  )
  returning id into v_id;

  if v_key is not null then
    update public.api_keys k
       set request_count = k.request_count + 1,
           last_used_at  = now(),
           spend_usd     = k.spend_usd + v_cost
     where k.id = v_key;
  end if;

  if v_cost > 0 and v_user is not null then
    perform public.internal_credit_move(
      v_user, -v_cost, 'usage',
      coalesce(nullif(p_payload ->> 'model_public_id', ''), 'gateway request'),
      v_req, v_key, p_payload ->> 'model_public_id');
  end if;

  return v_id;
end $$;

revoke execute on function public.internal_log_request(jsonb) from anon, authenticated;
grant  execute on function public.internal_log_request(jsonb) to service_role;


-- ===========================================================================
-- 4. IP RULES FROM THE UI
-- ===========================================================================

-- Key owner (or an admin) sets the allowlist / per-IP limit for one key.
create or replace function public.set_api_key_ip_rules(
  p_key_id            uuid,
  p_allowed_ips       text[] default null,
  p_ip_rate_limit_rpm int    default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_clean text[] := '{}';
  e       text;
  c       cidr;
begin
  select k.user_id into v_owner from public.api_keys k where k.id = p_key_id;
  if v_owner is null then
    raise exception 'Key not found' using errcode = '22023';
  end if;
  if v_owner <> auth.uid() and not public.is_admin(auth.uid()) then
    raise exception 'You can only change IP rules on your own keys'
      using errcode = '42501';
  end if;

  if p_allowed_ips is not null then
    if cardinality(p_allowed_ips) > 20 then
      raise exception 'At most 20 IP rules per key' using errcode = '22023';
    end if;
    foreach e in array p_allowed_ips loop
      e := btrim(coalesce(e, ''));
      continue when e = '';
      c := public.to_cidr(e);
      v_clean := array_append(v_clean, host(c::inet) || '/' || masklen(c));
    end loop;
    select coalesce(array_agg(distinct x), '{}') into v_clean from unnest(v_clean) x;
  end if;

  update public.api_keys k
     set allowed_ips = case when p_allowed_ips is null then k.allowed_ips else v_clean end,
         ip_rate_limit_rpm = case
           when p_ip_rate_limit_rpm is null then k.ip_rate_limit_rpm
           else least(greatest(p_ip_rate_limit_rpm, 0), 100000) end
   where k.id = p_key_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'set_key_ip_rules', 'api_keys', p_key_id::text,
          jsonb_build_object('allowed_ips', v_clean,
                             'ip_rate_limit_rpm', p_ip_rate_limit_rpm));

  return (select jsonb_build_object('id', k.id,
                                    'allowed_ips', k.allowed_ips,
                                    'ip_rate_limit_rpm', k.ip_rate_limit_rpm)
            from public.api_keys k where k.id = p_key_id);
end $$;

revoke execute on function public.set_api_key_ip_rules(uuid, text[], int) from anon;
grant  execute on function public.set_api_key_ip_rules(uuid, text[], int) to authenticated;

-- Admin: ban / unban an address or range. p_minutes null or 0 = permanent.
create or replace function public.admin_block_ip(
  p_cidr    text,
  p_reason  text default null,
  p_minutes int  default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c       cidr;
  v_until timestamptz;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  c := public.to_cidr(p_cidr);
  v_until := case when coalesce(p_minutes, 0) > 0
                  then now() + make_interval(mins => least(p_minutes, 525600))
                  else null end;

  insert into public.blocked_ips (ip_range, reason, source, expires_at, created_by)
  values (c, left(regexp_replace(coalesce(p_reason, 'blocked by admin'), '[<>]', '', 'g'), 200),
          'manual', v_until, auth.uid())
  on conflict (ip_range) do update
    set reason     = excluded.reason,
        source     = 'manual',
        expires_at = excluded.expires_at,
        created_by = excluded.created_by;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'block_ip', 'blocked_ips', c::text,
          jsonb_build_object('reason', p_reason, 'until', v_until));

  return jsonb_build_object('ip_range', c::text, 'expires_at', v_until);
end $$;

create or replace function public.admin_unblock_ip(p_cidr text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare c cidr; v_n int;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  c := public.to_cidr(p_cidr);
  delete from public.blocked_ips where ip_range = c;
  get diagnostics v_n = row_count;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'unblock_ip', 'blocked_ips', c::text,
          jsonb_build_object('removed', v_n));

  return jsonb_build_object('ip_range', c::text, 'removed', v_n);
end $$;

revoke execute on function public.admin_block_ip(text, text, int) from anon;
revoke execute on function public.admin_unblock_ip(text)          from anon;
grant  execute on function public.admin_block_ip(text, text, int) to authenticated;
grant  execute on function public.admin_unblock_ip(text)          to authenticated;

-- Admin: busiest addresses, so you know what to ban.
create or replace function public.admin_ip_activity(p_hours int default 24)
returns table (
  client_ip  text,
  requests   bigint,
  ok         bigint,
  failed     bigint,
  keys_used  bigint,
  accounts   bigint,
  cost_usd   numeric,
  last_seen  timestamptz,
  blocked    boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select host(l.client_ip),
         count(*),
         count(*) filter (where l.ok),
         count(*) filter (where not l.ok),
         count(distinct l.api_key_id),
         count(distinct l.user_id),
         round(coalesce(sum(l.cost_usd), 0), 6),
         max(l.created_at),
         exists (select 1 from public.blocked_ips b
                  where (b.expires_at is null or b.expires_at > now())
                    and l.client_ip <<= b.ip_range)
  from public.request_logs l
  where l.client_ip is not null
    and l.created_at > now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
  group by l.client_ip
  order by count(*) desc
  limit 200;
end $$;

-- The same list, scoped to the caller's own keys, for the console.
create or replace function public.my_ip_activity(p_hours int default 24)
returns table (
  client_ip text,
  requests  bigint,
  ok        bigint,
  cost_usd  numeric,
  last_seen timestamptz
)
language sql stable security definer set search_path = public as $$
  select host(l.client_ip),
         count(*),
         count(*) filter (where l.ok),
         round(coalesce(sum(l.cost_usd), 0), 6),
         max(l.created_at)
  from public.request_logs l
  where l.user_id = auth.uid()
    and l.client_ip is not null
    and l.created_at > now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
  group by l.client_ip
  order by count(*) desc
  limit 100;
$$;

revoke execute on function public.admin_ip_activity(int) from anon;
revoke execute on function public.my_ip_activity(int)    from anon;
grant  execute on function public.admin_ip_activity(int) to authenticated;
grant  execute on function public.my_ip_activity(int)    to authenticated;

-- Direct table writes are never needed: validate anything that slips through.
create or replace function public.guard_api_key_ips()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare e text;
begin
  new.allowed_ips := coalesce(new.allowed_ips, '{}');
  if cardinality(new.allowed_ips) > 20 then
    raise exception 'At most 20 IP rules per key' using errcode = '22023';
  end if;
  foreach e in array new.allowed_ips loop
    perform public.to_cidr(e);
  end loop;
  new.ip_rate_limit_rpm := least(greatest(coalesce(new.ip_rate_limit_rpm, 0), 0), 100000);
  return new;
end $$;

drop trigger if exists api_keys_guard_ips on public.api_keys;
create trigger api_keys_guard_ips
  before insert or update of allowed_ips, ip_rate_limit_rpm on public.api_keys
  for each row execute function public.guard_api_key_ips();


-- ===========================================================================
-- 5. A1 — VIEWS STOP BEING "SECURITY DEFINER"
-- ---------------------------------------------------------------------------
--  Owner- and admin-scoped views simply become security_invoker = on: RLS on
--  the base tables now decides what the caller sees, which is strictly
--  tighter than before.
--  The three views anon must read (models, status, public settings) would
--  return nothing under invoker rights, because models / upstreams /
--  request_logs / app_settings are admin-only. They now select from a
--  SECURITY DEFINER function that exposes only non-secret columns.
-- ===========================================================================

-- ---------------------------------------------------- public model catalogue
create or replace function public.fn_public_models()
returns table (
  id                text,
  name              text,
  description       text,
  context_window    int,
  max_output_tokens int,
  price_in_per_m    numeric,
  price_out_per_m   numeric,
  capabilities      text[],
  status            text,
  is_default        boolean,
  sort_order        int
)
language sql stable security definer set search_path = public as $$
  select m.public_id, m.display_name, m.description, m.context_window,
         m.max_output_tokens, m.price_in_per_m, m.price_out_per_m,
         m.capabilities, m.status, m.is_default, m.sort_order
  from public.models m
  where m.is_active
    and m.status <> 'disabled'
    and exists (select 1 from public.upstreams u
                 where u.id = m.upstream_id and u.is_active);
$$;

drop view if exists public.public_models cascade;
create view public.public_models with (security_invoker = on) as
  select * from public.fn_public_models();

-- ------------------------------------------------------- status page health
create or replace function public.fn_route_health()
returns table (
  model           text,
  name            text,
  requests_24h    bigint,
  ok_24h          bigint,
  success_rate    numeric,
  avg_latency_ms  numeric,
  last_request_at timestamptz,
  model_status    text,
  sort_order      int
)
language sql stable security definer set search_path = public as $$
  select m.public_id,
         m.display_name,
         count(l.id),
         count(l.id) filter (where l.ok),
         case when count(l.id) = 0 then null
              else round(100.0 * count(l.id) filter (where l.ok) / count(l.id), 2) end,
         round(avg(l.latency_ms) filter (where l.ok)),
         max(l.created_at),
         m.status,
         m.sort_order
  from public.models m
  left join public.request_logs l
         on l.model_public_id = m.public_id
        and l.created_at > now() - interval '24 hours'
  where m.is_active and m.status <> 'disabled'
  group by m.public_id, m.display_name, m.status, m.sort_order
  order by m.sort_order, m.public_id;
$$;

drop view if exists public.route_health cascade;
create view public.route_health with (security_invoker = on) as
  select * from public.fn_route_health();

create or replace function public.fn_gateway_daily_health()
returns table (
  day            date,
  requests       bigint,
  ok             bigint,
  failed         bigint,
  avg_latency_ms numeric
)
language sql stable security definer set search_path = public as $$
  select d::date,
         count(l.id),
         count(l.id) filter (where l.ok),
         count(l.id) filter (where not l.ok),
         round(avg(l.latency_ms) filter (where l.ok))
  from generate_series(current_date - 89, current_date, interval '1 day') d
  left join public.request_logs l
         on l.created_at >= d and l.created_at < d + interval '1 day'
  group by d
  order by d;
$$;

drop view if exists public.gateway_daily_health cascade;
create view public.gateway_daily_health with (security_invoker = on) as
  select * from public.fn_gateway_daily_health();

-- --------------------------------------------- non-secret workspace settings
create or replace function public.fn_public_settings()
returns table (
  id                    smallint,
  brand_name            text,
  gateway_url           text,
  signup_enabled        boolean,
  default_policy        text,
  failover_enabled      boolean,
  max_failover_hops     int,
  log_retention_days    int,
  credits_enabled       boolean,
  signup_credit_usd     numeric,
  low_balance_usd       numeric,
  overdraft_usd         numeric,
  topup_note            text,
  allowed_email_domains text[]
)
language sql stable security definer set search_path = public as $$
  select s.id, s.brand_name, s.gateway_url, s.signup_enabled, s.default_policy,
         s.failover_enabled, s.max_failover_hops, s.log_retention_days,
         s.credits_enabled, s.signup_credit_usd, s.low_balance_usd,
         s.overdraft_usd, s.topup_note, s.allowed_email_domains
  from public.app_settings s
  where s.id = 1;
$$;

drop view if exists public.public_settings cascade;
create view public.public_settings with (security_invoker = on) as
  select * from public.fn_public_settings();

-- ------------------------------------------------------ owner-scoped views
drop view if exists public.my_api_keys cascade;
create view public.my_api_keys with (security_invoker = on) as
select k.id, k.name, k.environment, k.key_prefix, k.key_last4, k.status,
       k.monthly_budget_usd, k.spend_usd, k.request_count, k.rate_limit_rpm,
       k.allowed_models, k.allowed_ips, k.ip_rate_limit_rpm,
       k.last_used_at, k.expires_at, k.created_at,
       (k.key_prefix || '••••••••' || k.key_last4) as masked_key
from public.api_keys k
where k.user_id = (select auth.uid());

drop view if exists public.my_request_logs cascade;
create view public.my_request_logs with (security_invoker = on) as
select l.id, l.request_id, l.api_key_id, l.model_public_id, l.policy,
       l.ok, l.status_code, l.latency_ms, l.tokens_in, l.tokens_out,
       l.cost_usd, l.failover_count, l.streamed, l.error_code, l.error_message,
       host(l.client_ip) as client_ip,
       l.created_at
from public.request_logs l
where l.user_id = (select auth.uid());

drop view if exists public.my_credit_ledger cascade;
create view public.my_credit_ledger with (security_invoker = on) as
select c.id, c.kind, c.delta_usd, c.balance_after, c.description,
       c.request_id, c.api_key_id, c.model_public_id, c.created_at
from public.credit_ledger c
where c.user_id = (select auth.uid());

-- ------------------------------------------------------ admin-scoped views
drop view if exists public.admin_upstream_keys cascade;
create view public.admin_upstream_keys with (security_invoker = on) as
select k.id, k.upstream_id, u.name as upstream_name, u.slug as upstream_slug,
       k.label,
       ('••••••••' || k.key_last4) as masked_key,
       length(k.api_key)            as key_length,
       k.status, k.is_active, k.weight,
       k.last_checked_at, k.last_success_at, k.last_failure_at,
       k.last_status_code, k.last_latency_ms, k.last_error,
       k.success_count, k.failure_count, k.consecutive_failures,
       k.monthly_budget_usd, k.spend_usd, k.expires_at, k.notes, k.created_at
from public.upstream_keys k
join public.upstreams u on u.id = k.upstream_id
where (select public.is_admin())
order by u.name, k.label;

drop view if exists public.admin_credit_ledger cascade;
create view public.admin_credit_ledger with (security_invoker = on) as
select c.id, c.user_id, pr.email as user_email, pr.full_name as user_name,
       c.kind, c.delta_usd, c.balance_after, c.description, c.request_id,
       c.model_public_id, c.actor_email, c.created_at
from public.credit_ledger c
left join public.profiles pr on pr.id = c.user_id
where (select public.is_admin())
order by c.created_at desc;

drop view if exists public.admin_users cascade;
create view public.admin_users with (security_invoker = on) as
select p.id, p.email, p.full_name, p.org, p.plan, p.role, p.status,
       p.monthly_budget_usd, p.rate_limit_rpm, p.created_at,
       p.credit_balance_usd, p.credits_added_usd, p.credits_used_usd,
       (select count(*) from public.api_keys k
         where k.user_id = p.id and k.status = 'active')  as active_keys,
       (select count(*) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days') as requests_30d,
       (select coalesce(sum(l.cost_usd), 0) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days') as cost_30d,
       (select max(l.created_at) from public.request_logs l
         where l.user_id = p.id)                          as last_request_at
from public.profiles p
where (select public.is_admin())
order by p.created_at desc;


-- ===========================================================================
-- 6. A2 + A3 — ONE POLICY PER TABLE PER ACTION, auth.uid() EVALUATED ONCE
-- ---------------------------------------------------------------------------
--  (select auth.uid()) and (select public.is_admin()) become InitPlans, so
--  they run once per statement instead of once per row. Merging the old
--  "owner" + "admin" pair into a single policy removes the multiple-
--  permissive-policies penalty without widening access by one row.
-- ===========================================================================

-- ---------------------------------------------------------------- profiles
drop policy if exists profiles_self_read  on public.profiles;
drop policy if exists profiles_self_write on public.profiles;
drop policy if exists profiles_admin_all  on public.profiles;
drop policy if exists profiles_read       on public.profiles;
drop policy if exists profiles_update     on public.profiles;
drop policy if exists profiles_insert     on public.profiles;
drop policy if exists profiles_delete     on public.profiles;

create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy profiles_update on public.profiles for update to authenticated
  using      (id = (select auth.uid()) or (select public.is_admin()))
  with check (id = (select auth.uid()) or (select public.is_admin()));
create policy profiles_insert on public.profiles for insert to authenticated
  with check ((select public.is_admin()));
create policy profiles_delete on public.profiles for delete to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------- api_keys
drop policy if exists api_keys_owner  on public.api_keys;
drop policy if exists api_keys_admin  on public.api_keys;
drop policy if exists api_keys_read   on public.api_keys;
drop policy if exists api_keys_insert on public.api_keys;
drop policy if exists api_keys_update on public.api_keys;
drop policy if exists api_keys_delete on public.api_keys;

create policy api_keys_read on public.api_keys for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy api_keys_insert on public.api_keys for insert to authenticated
  with check ((select public.is_admin()));
create policy api_keys_update on public.api_keys for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy api_keys_delete on public.api_keys for delete to authenticated
  using ((select public.is_admin()));

-- ------------------------------------------------------------ request_logs
drop policy if exists request_logs_owner  on public.request_logs;
drop policy if exists request_logs_admin  on public.request_logs;
drop policy if exists request_logs_read   on public.request_logs;
drop policy if exists request_logs_write  on public.request_logs;
drop policy if exists request_logs_update on public.request_logs;
drop policy if exists request_logs_delete on public.request_logs;

create policy request_logs_read on public.request_logs for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy request_logs_write on public.request_logs for insert to authenticated
  with check ((select public.is_admin()));
create policy request_logs_update on public.request_logs for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy request_logs_delete on public.request_logs for delete to authenticated
  using ((select public.is_admin()));

-- ----------------------------------------------------------- credit_ledger
drop policy if exists credit_ledger_owner  on public.credit_ledger;
drop policy if exists credit_ledger_admin  on public.credit_ledger;
drop policy if exists credit_ledger_read   on public.credit_ledger;
drop policy if exists credit_ledger_write  on public.credit_ledger;
drop policy if exists credit_ledger_update on public.credit_ledger;
drop policy if exists credit_ledger_delete on public.credit_ledger;

create policy credit_ledger_read on public.credit_ledger for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy credit_ledger_write on public.credit_ledger for insert to authenticated
  with check ((select public.is_admin()));
create policy credit_ledger_update on public.credit_ledger for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy credit_ledger_delete on public.credit_ledger for delete to authenticated
  using ((select public.is_admin()));

-- ------------------------------------------------------------ app_settings
-- anon reads public_settings, never the base row (admin_emails lives there).
drop policy if exists app_settings_read         on public.app_settings;
drop policy if exists app_settings_admin        on public.app_settings;
drop policy if exists app_settings_admin_read   on public.app_settings;
drop policy if exists app_settings_admin_write  on public.app_settings;
drop policy if exists app_settings_admin_insert on public.app_settings;

create policy app_settings_admin_read on public.app_settings for select to authenticated
  using ((select public.is_admin()));
create policy app_settings_admin_write on public.app_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy app_settings_admin_insert on public.app_settings for insert to authenticated
  with check ((select public.is_admin()));

-- --------------------------------------------- admin-only tables (one each)
drop policy if exists upstreams_admin     on public.upstreams;
drop policy if exists upstream_keys_admin on public.upstream_keys;
drop policy if exists key_checks_admin    on public.upstream_key_checks;
drop policy if exists models_admin        on public.models;
drop policy if exists audit_logs_admin    on public.audit_logs;

create policy upstreams_admin on public.upstreams for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy upstream_keys_admin on public.upstream_keys for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy key_checks_admin on public.upstream_key_checks for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy models_admin on public.models for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy audit_logs_admin on public.audit_logs for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- -------------------------------------------------------------- blocked_ips
alter table public.blocked_ips enable row level security;

drop policy if exists blocked_ips_admin on public.blocked_ips;
create policy blocked_ips_admin on public.blocked_ips for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));


-- ===========================================================================
-- 7. A4 — EVERY FUNCTION GETS A PINNED search_path
-- ===========================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and (p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) c
                           where c like 'search\_path=%'))
  loop
    begin
      execute format('alter function %s set search_path = public', r.sig);
    exception when others then
      raise notice 'search_path not pinned on % (%)', r.sig, sqlerrm;
    end;
  end loop;
end $$;


-- ===========================================================================
-- 8. GRANTS
-- ===========================================================================

grant execute on function public.fn_public_models()         to anon, authenticated, service_role;
grant execute on function public.fn_route_health()          to anon, authenticated, service_role;
grant execute on function public.fn_gateway_daily_health()  to anon, authenticated, service_role;
grant execute on function public.fn_public_settings()       to anon, authenticated, service_role;
grant execute on function public.safe_inet(text)            to authenticated, service_role;
grant execute on function public.ip_in_list(inet, text[])   to authenticated, service_role;
grant execute on function public.to_cidr(text)              to authenticated, service_role;

grant select on public.public_models        to anon, authenticated, service_role;
grant select on public.route_health         to anon, authenticated, service_role;
grant select on public.gateway_daily_health to anon, authenticated, service_role;
grant select on public.public_settings      to anon, authenticated, service_role;
grant select on public.my_api_keys          to authenticated;
grant select on public.my_request_logs      to authenticated;
grant select on public.my_credit_ledger     to authenticated;
grant select on public.admin_upstream_keys  to authenticated;
grant select on public.admin_credit_ledger  to authenticated;
grant select on public.admin_users          to authenticated;
grant select on public.blocked_ips          to authenticated;
grant all    on public.blocked_ips          to service_role;

-- app_settings base row: admins only (RLS above), anon has nothing
revoke select, insert, update, delete on public.app_settings from anon;
revoke insert, update, delete         on public.app_settings from authenticated;
grant  select                         on public.app_settings to authenticated;

-- api_keys: the browser reads metadata, all writes go through RPCs
revoke insert, update, delete on public.api_keys from anon, authenticated;
grant  select                 on public.api_keys to authenticated;

commit;

-- ============================================================================
--  A5. LEAKED PASSWORD PROTECTION  (the one warning SQL cannot fix)
-- ----------------------------------------------------------------------------
--  Dashboard -> Authentication -> Sign In / Providers -> Email -> Passwords:
--    · Prevent use of leaked passwords  -> ON   (checks HaveIBeenPwned)
--    · Minimum password length          -> 10 or more
--    · Password requirements            -> letters, digits and symbols
--  Then re-run Advisors -> Security; the list should be empty.
-- ============================================================================

-- ============================================================================
--  HOW TO TURN ON IP LIMITS (nothing is enforced until you set a number)
-- ----------------------------------------------------------------------------
--  Global per-IP ceiling, 120 requests/min, auto-ban floods for 15 minutes:
--    select public.admin_save_settings(
--      '{"ip_rate_limit_rpm":120,"ip_autoblock_minutes":15}');
--
--  NOTE: admin_save_settings() from v5.5 only allows its own column list.
--  Run supabase/upgrade-v5.6-settings-rpc.sql (below in this same folder) or
--  update the six IP columns as an admin with:
--    update public.app_settings set ip_rate_limit_rpm = 120,
--           ip_autoblock_minutes = 15 where id = 1;
--
--  Lock one key to your own servers and give it 60 req/min per address:
--    select public.set_api_key_ip_rules(
--      '<key-uuid>', array['203.0.113.7','2001:db8::/48'], 60);
--
--  Ban an address for a day / unban it:
--    select public.admin_block_ip('198.51.100.23', 'scraping', 1440);
--    select public.admin_unblock_ip('198.51.100.23');
--
--  Who is hammering the gateway:
--    select * from public.admin_ip_activity(24);
-- ============================================================================
