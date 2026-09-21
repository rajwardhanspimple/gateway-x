-- ============================================================================
--  RageStar — v5.7  ·  IP recording + admin-controlled IP limits
-- ----------------------------------------------------------------------------
--  Run ONCE in Supabase Dashboard -> SQL Editor -> New query, AFTER
--  schema.sql, upgrade-v5.4.sql, upgrade-v5.5-security.sql and
--  upgrade-v5.6-lints-and-ip.sql.  Idempotent: re-running it is harmless.
--
--  WHAT v5.6 LEFT UNFINISHED, AND THIS FILE FIXES
--    1. The IP settings existed as columns but admin_save_settings() refused
--       them, so the admin panel could not write a single one of them.
--    2. Caller IPs only lived inside request_logs, which log retention prunes.
--       There was no durable "which addresses has this account used" record.
--    3. Per-IP limits were counted by scanning request_logs — rows that are
--       only written AFTER a request finishes, so a concurrent burst sailed
--       straight through the ceiling.
--    4. There was no way to say "never apply IP limits to this account".
--
--  WHAT YOU GET
--    · public.ip_registry        durable per-account address book: first seen,
--                                last seen, request + refusal counts, note
--    · public.ip_rate_buckets    real counters, incremented before the request
--                                is routed, so limits actually bite
--    · app_settings.ip_limits_enabled   master switch (off = record only)
--    · app_settings.ip_rate_limit_rph   per-IP requests/hour ceiling
--    · app_settings.ip_exempt_ips       addresses no rule ever touches
--    · app_settings.ip_max_accounts_per_ip  multi-account guard
--    · profiles.ip_limit_exempt         "do not limit this account"
--    · profiles.ip_rate_limit_rpm       per-account override (0 = inherit)
--    · api_keys.ip_limit_exempt         same escape hatch, one key only
--    · admin RPCs for every one of the above, so the panel drives it all
--
--  PRECEDENCE, once and for all (internal_ip_check evaluates top to bottom):
--      1. app_settings.ip_exempt_ips ...... always allowed, nothing else runs
--      2. blocked_ips + ip_denylist ....... always refused
--      3. api_keys.allowed_ips ............ the key owner's own lock, always on
--      4. ip_limit_exempt (account or key)  skips every rule below
--      5. ip_limits_enabled = false ....... skips every rule below
--      6. ip_allowlist_required
--      7. per-IP requests/minute and requests/hour
--      8. distinct-IPs-per-key-per-hour guard
--      9. accounts-per-IP guard
--  Bans and the owner's own allowlist deliberately survive an exemption; an
--  exemption waives the limits YOU impose, not a targeted block.
--
--  The gateway calls internal_ip_check(api_key_id, ip) exactly as it does in
--  v5.6 — the signature is unchanged, so supabase/functions/router needs no
--  redeploy for this upgrade.
-- ============================================================================

begin;

-- ===========================================================================
-- 0. COLUMNS
-- ===========================================================================

alter table public.app_settings
  -- Nothing below is enforced while this is false: collect addresses for a few
  -- days, look at the numbers, then switch it on.
  add column if not exists ip_limits_enabled      boolean not null default false,
  add column if not exists ip_rate_limit_rph      int     not null default 0,
  add column if not exists ip_exempt_ips          text[]  not null default '{}',
  add column if not exists ip_max_accounts_per_ip int     not null default 0,
  add column if not exists ip_registry_retain_days int    not null default 180;

-- v5.6 columns, restated so this file also works on a database that skipped it
alter table public.app_settings
  add column if not exists ip_rate_limit_rpm        int     not null default 0,
  add column if not exists ip_denylist              text[]  not null default '{}',
  add column if not exists ip_allowlist_required    boolean not null default false,
  add column if not exists ip_max_distinct_per_hour int     not null default 0,
  add column if not exists ip_autoblock_minutes     int     not null default 0;

alter table public.profiles
  add column if not exists ip_limit_exempt   boolean not null default false,
  add column if not exists ip_rate_limit_rpm int     not null default 0;

alter table public.api_keys
  add column if not exists ip_limit_exempt   boolean not null default false,
  add column if not exists allowed_ips       text[]  not null default '{}',
  add column if not exists ip_rate_limit_rpm int     not null default 0;

comment on column public.profiles.ip_limit_exempt is
  'true = IP rate limits, fan-out and allowlist-required never apply to this account. Explicit bans still do.';
comment on column public.profiles.ip_rate_limit_rpm is
  'Per-IP requests/minute for this account. 0 = inherit app_settings.ip_rate_limit_rpm.';
comment on column public.app_settings.ip_limits_enabled is
  'Master switch. false = addresses are still recorded, no limit is enforced.';
comment on column public.app_settings.ip_exempt_ips is
  'Addresses/CIDRs that bypass every IP rule, including the ban list. Your own offices and CI runners.';


-- ===========================================================================
-- 1. THE ADDRESS BOOK  —  "IP recorded to the database"
-- ---------------------------------------------------------------------------
--  One row per (address, account). Survives log retention, so you keep the
--  history even after request_logs is pruned.
-- ===========================================================================

create table if not exists public.ip_registry (
  id            uuid        primary key default gen_random_uuid(),
  ip            inet        not null,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  api_key_id    uuid        references public.api_keys (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  request_count bigint      not null default 0,   -- attempts seen, refusals included
  refused_count bigint      not null default 0,   -- how many of those were turned away
  note          text,
  unique (ip, user_id)
);

create index if not exists ip_registry_user_idx on public.ip_registry (user_id, last_seen_at desc);
create index if not exists ip_registry_ip_idx   on public.ip_registry (ip);
create index if not exists ip_registry_seen_idx on public.ip_registry (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Counters. Fixed minute/hour windows: one upsert per request, no scan of
-- request_logs, and the count exists before the upstream is contacted.
-- ---------------------------------------------------------------------------
create table if not exists public.ip_rate_buckets (
  ip           inet        not null,
  window_kind  text        not null check (window_kind in ('minute','hour')),
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (ip, window_kind, window_start)
);

create index if not exists ip_rate_buckets_sweep_idx
  on public.ip_rate_buckets (window_start);


-- ===========================================================================
-- 2. HELPERS (restated from v5.6 so this file stands alone)
-- ===========================================================================

create or replace function public.safe_inet(p_text text)
returns inet
language plpgsql stable security invoker set search_path = public as $$
begin
  return nullif(btrim(coalesce(p_text, '')), '')::inet;
exception when others then
  return null;
end $$;

create or replace function public.ip_in_list(p_ip inet, p_list text[])
returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare e text; c cidr;
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

create or replace function public.to_cidr(p_text text)
returns cidr
language plpgsql immutable security invoker set search_path = public as $$
begin
  return network(btrim(coalesce(p_text, ''))::inet);
exception when others then
  raise exception '% is not a valid IP address or CIDR range', p_text
    using errcode = '22023';
end $$;

-- Normalises a text[] of addresses, drops blanks and duplicates, and rejects
-- the first entry that is not an address. Used by every settings RPC below.
create or replace function public.clean_ip_list(p_list text[], p_max int default 200)
returns text[]
language plpgsql immutable security invoker set search_path = public as $$
declare e text; c cidr; v_out text[] := '{}';
begin
  if p_list is null then
    return null;
  end if;
  foreach e in array p_list loop
    e := btrim(coalesce(e, ''));
    continue when e = '';
    c := public.to_cidr(e);
    v_out := array_append(v_out, host(c::inet) || '/' || masklen(c));
  end loop;
  select coalesce(array_agg(distinct x), '{}') into v_out from unnest(v_out) x;
  if cardinality(v_out) > greatest(p_max, 1) then
    raise exception 'At most % IP rules allowed here', p_max using errcode = '22023';
  end if;
  return v_out;
end $$;

grant execute on function public.safe_inet(text)              to authenticated, service_role;
grant execute on function public.ip_in_list(inet, text[])     to authenticated, service_role;
grant execute on function public.to_cidr(text)                to authenticated, service_role;
grant execute on function public.clean_ip_list(text[], int)   to authenticated, service_role;

commit;
begin;

-- ===========================================================================
-- 3. THE GATE  --  records the address, then applies your rules
-- ---------------------------------------------------------------------------
--  Same signature as v5.6, so the deployed router keeps working untouched.
--  Every path records the caller into ip_registry first: you get the address
--  book even for requests you end up refusing.
-- ===========================================================================

create or replace function public.internal_ip_check(p_api_key_id uuid, p_ip text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_ip          inet    := public.safe_inet(p_ip);
  v_user        uuid;
  v_key_allowed text[]  := '{}';
  v_key_rpm     int     := 0;
  v_key_exempt  boolean := false;
  v_user_rpm    int     := 0;
  v_user_exempt boolean := false;
  v_enabled     boolean := false;
  v_global_rpm  int     := 0;
  v_global_rph  int     := 0;
  v_deny        text[]  := '{}';
  v_exempt_ips  text[]  := '{}';
  v_required    boolean := false;
  v_fanout      int     := 0;
  v_acct_cap    int     := 0;
  v_autoblock   int     := 0;
  v_rpm         int     := 0;
  v_min_hits    int     := 0;
  v_hour_hits   int     := 0;
  v_distinct    int     := 0;
  v_accounts    int     := 0;
  v_exempt      boolean := false;
  v_code        text;
  v_reason      text;
  v_limit       int     := 0;
  v_used        int     := 0;
begin
  select k.user_id,
         coalesce(k.allowed_ips, '{}'),
         coalesce(k.ip_rate_limit_rpm, 0),
         coalesce(k.ip_limit_exempt, false)
    into v_user, v_key_allowed, v_key_rpm, v_key_exempt
  from public.api_keys k
  where k.id = p_api_key_id;

  if v_user is null then
    return jsonb_build_object('allowed', false, 'code', 'invalid_api_key',
                              'reason', 'Unknown API key.');
  end if;

  select coalesce(p.ip_limit_exempt, false), coalesce(p.ip_rate_limit_rpm, 0)
    into v_user_exempt, v_user_rpm
  from public.profiles p
  where p.id = v_user;

  select coalesce(s.ip_limits_enabled, false),
         coalesce(s.ip_rate_limit_rpm, 0),
         coalesce(s.ip_rate_limit_rph, 0),
         coalesce(s.ip_denylist, '{}'),
         coalesce(s.ip_exempt_ips, '{}'),
         coalesce(s.ip_allowlist_required, false),
         coalesce(s.ip_max_distinct_per_hour, 0),
         coalesce(s.ip_max_accounts_per_ip, 0),
         coalesce(s.ip_autoblock_minutes, 0)
    into v_enabled, v_global_rpm, v_global_rph, v_deny, v_exempt_ips,
         v_required, v_fanout, v_acct_cap, v_autoblock
  from public.app_settings s
  where s.id = 1;

  v_exempt := v_user_exempt or v_key_exempt;

  -- ---- 0. record the caller ----------------------------------------------
  if v_ip is not null then
    insert into public.ip_registry (ip, user_id, api_key_id, request_count)
    values (v_ip, v_user, p_api_key_id, 1)
    on conflict (ip, user_id) do update
      set last_seen_at  = now(),
          request_count = ip_registry.request_count + 1,
          api_key_id    = excluded.api_key_id;
  end if;

  -- ---- caller address unknown --------------------------------------------
  if v_ip is null then
    if not v_exempt and (v_required or cardinality(v_key_allowed) > 0) then
      return jsonb_build_object(
        'allowed', false, 'code', 'ip_not_allowed',
        'reason', 'This key only accepts approved IP addresses and the caller address could not be determined.');
    end if;
    return jsonb_build_object('allowed', true, 'code', 'ok', 'ip', null);
  end if;

  -- One pass, one exit, so refusal bookkeeping lives in a single place.
  for _i in 1..1 loop

    -- ---- 1. your own always-allow list -----------------------------------
    if public.ip_in_list(v_ip, v_exempt_ips) then
      return jsonb_build_object('allowed', true, 'code', 'ip_exempt',
                                'ip', host(v_ip));
    end if;

    -- ---- 2. bans and denylist (an exemption does not waive these) --------
    if exists (
      select 1 from public.blocked_ips b
       where (b.expires_at is null or b.expires_at > now())
         and v_ip <<= b.ip_range
    ) then
      v_code   := 'ip_blocked';
      v_reason := 'This IP address is blocked.';
      exit;
    end if;

    if public.ip_in_list(v_ip, v_deny) then
      v_code   := 'ip_blocked';
      v_reason := 'This IP address is blocked.';
      exit;
    end if;

    -- ---- 3. the key owner's own allowlist --------------------------------
    if cardinality(v_key_allowed) > 0 and not public.ip_in_list(v_ip, v_key_allowed) then
      v_code   := 'ip_not_allowed';
      v_reason := 'This API key is locked to other IP addresses.';
      exit;
    end if;

    -- ---- 4. never limit this account -------------------------------------
    if v_exempt then
      return jsonb_build_object('allowed', true, 'code', 'ip_limit_exempt',
                                'ip', host(v_ip),
                                'exempt', case when v_user_exempt then 'account' else 'key' end);
    end if;

    -- ---- 5. master switch -------------------------------------------------
    if not v_enabled then
      return jsonb_build_object('allowed', true, 'code', 'ok', 'ip', host(v_ip),
                                'enforced', false);
    end if;

    -- ---- 6. every key must declare its addresses -------------------------
    if cardinality(v_key_allowed) = 0 and v_required then
      v_code   := 'ip_allowlist_required';
      v_reason := 'This workspace requires every key to declare its allowed IP addresses.';
      exit;
    end if;

    -- ---- 7. per-IP requests/minute and requests/hour ---------------------
    --  Key limit beats account limit beats workspace default.
    v_rpm := case when v_key_rpm  > 0 then v_key_rpm
                  when v_user_rpm > 0 then v_user_rpm
                  else v_global_rpm end;

    if v_rpm > 0 or v_global_rph > 0 then
      insert into public.ip_rate_buckets (ip, window_kind, window_start, hits)
      values (v_ip, 'minute', date_trunc('minute', now()), 1)
      on conflict (ip, window_kind, window_start)
        do update set hits = ip_rate_buckets.hits + 1
      returning hits into v_min_hits;

      insert into public.ip_rate_buckets (ip, window_kind, window_start, hits)
      values (v_ip, 'hour', date_trunc('hour', now()), 1)
      on conflict (ip, window_kind, window_start)
        do update set hits = ip_rate_buckets.hits + 1
      returning hits into v_hour_hits;
    end if;

    if v_rpm > 0 and v_min_hits > v_rpm then
      -- A sustained flood, not a brief spike: park the address on the ban list.
      if v_autoblock > 0 and v_min_hits >= v_rpm * 3 then
        insert into public.blocked_ips (ip_range, reason, source, expires_at)
        values (network(v_ip),
                'auto: ' || v_min_hits || ' requests/min from one address',
                'auto',
                now() + make_interval(mins => v_autoblock))
        on conflict (ip_range) do update
          set expires_at = greatest(coalesce(blocked_ips.expires_at, now()),
                                    excluded.expires_at),
              reason     = excluded.reason;
      end if;

      v_code   := 'ip_rate_limit_exceeded';
      v_reason := 'Too many requests from this IP address.';
      v_limit  := v_rpm;
      v_used   := v_min_hits;
      exit;
    end if;

    if v_global_rph > 0 and v_hour_hits > v_global_rph then
      v_code   := 'ip_rate_limit_exceeded';
      v_reason := 'Hourly request limit reached for this IP address.';
      v_limit  := v_global_rph;
      v_used   := v_hour_hits;
      exit;
    end if;

    -- ---- 8. one key used from too many addresses ------------------------
    --  Counted from request_logs, not ip_registry: a registry row is keyed by
    --  (address, account) and only remembers the most recent key, so it cannot
    --  answer "how many addresses did THIS key come from". The
    --  request_logs_key_ip_idx index from v5.6 makes this cheap.
    if v_fanout > 0 then
      select count(distinct l.client_ip) into v_distinct
      from public.request_logs l
      where l.api_key_id = p_api_key_id
        and l.client_ip is not null
        and l.created_at > now() - interval '1 hour';

      -- the current request is not logged yet, so count it in by hand
      if not exists (
        select 1 from public.request_logs l
         where l.api_key_id = p_api_key_id
           and l.client_ip = v_ip
           and l.created_at > now() - interval '1 hour'
      ) then
        v_distinct := v_distinct + 1;
      end if;

      if v_distinct > v_fanout then
        v_code   := 'ip_fanout_exceeded';
        v_reason := 'This key has been used from too many different IP addresses this hour.';
        v_limit  := v_fanout;
        v_used   := v_distinct;
        exit;
      end if;
    end if;

    -- ---- 9. too many accounts behind one address ------------------------
    if v_acct_cap > 0 then
      select count(distinct r.user_id) into v_accounts
      from public.ip_registry r
      where r.ip = v_ip
        and r.last_seen_at > now() - interval '30 days';

      if v_accounts > v_acct_cap then
        v_code   := 'ip_account_limit_exceeded';
        v_reason := 'Too many accounts are using this IP address.';
        v_limit  := v_acct_cap;
        v_used   := v_accounts;
        exit;
      end if;
    end if;

  end loop;

  if v_code is null then
    return jsonb_build_object('allowed', true, 'code', 'ok', 'ip', host(v_ip),
                              'limit', v_rpm, 'used', v_min_hits,
                              'enforced', true);
  end if;

  update public.ip_registry r
     set refused_count = r.refused_count + 1
   where r.ip = v_ip and r.user_id = v_user;

  return jsonb_build_object('allowed', false, 'code', v_code, 'reason', v_reason,
                            'ip', host(v_ip),
                            'limit', nullif(v_limit, 0),
                            'used', nullif(v_used, 0),
                            'retry_after', case when v_code = 'ip_rate_limit_exceeded'
                                                then 5 else null end);
end $fn$;

revoke execute on function public.internal_ip_check(uuid, text) from anon, authenticated;
grant  execute on function public.internal_ip_check(uuid, text) to service_role;

commit;
begin;

-- ===========================================================================
-- 4. HOUSEKEEPING
-- ---------------------------------------------------------------------------
--  Optional pg_cron schedule:
--    select cron.schedule('rs-ip-sweep', '*/15 * * * *',
--                         $job$select public.prune_ip_data()$job$);
-- ===========================================================================

create or replace function public.prune_ip_data()
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_buckets int;
  v_bans    int;
  v_seen    int;
  v_days    int;
begin
  delete from public.ip_rate_buckets where window_start < now() - interval '3 hours';
  get diagnostics v_buckets = row_count;

  delete from public.blocked_ips where expires_at is not null and expires_at < now();
  get diagnostics v_bans = row_count;

  select greatest(coalesce(s.ip_registry_retain_days, 180), 1)
    into v_days from public.app_settings s where s.id = 1;

  delete from public.ip_registry
   where last_seen_at < now() - make_interval(days => coalesce(v_days, 180));
  get diagnostics v_seen = row_count;

  return jsonb_build_object('buckets', v_buckets, 'bans', v_bans, 'addresses', v_seen);
end $fn$;

revoke execute on function public.prune_ip_data() from anon, authenticated;
grant  execute on function public.prune_ip_data() to service_role;


-- ===========================================================================
-- 5. ADMIN PANEL RPCs
-- ---------------------------------------------------------------------------
--  v5.6 shipped the IP columns but admin_save_settings() rejected every one
--  of them, so none of this was reachable from the UI. These RPCs are the
--  panel's write path; they are SECURITY DEFINER, re-check admin rights and
--  validate every address server-side.
-- ===========================================================================

-- ---------------------------------------------------- read the IP settings
create or replace function public.admin_get_ip_settings()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v jsonb;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'ip_limits_enabled',        coalesce(s.ip_limits_enabled, false),
           'ip_rate_limit_rpm',        coalesce(s.ip_rate_limit_rpm, 0),
           'ip_rate_limit_rph',        coalesce(s.ip_rate_limit_rph, 0),
           'ip_max_distinct_per_hour', coalesce(s.ip_max_distinct_per_hour, 0),
           'ip_max_accounts_per_ip',   coalesce(s.ip_max_accounts_per_ip, 0),
           'ip_autoblock_minutes',     coalesce(s.ip_autoblock_minutes, 0),
           'ip_allowlist_required',    coalesce(s.ip_allowlist_required, false),
           'ip_denylist',              coalesce(s.ip_denylist, '{}'),
           'ip_exempt_ips',            coalesce(s.ip_exempt_ips, '{}'),
           'ip_registry_retain_days',  coalesce(s.ip_registry_retain_days, 180))
    into v
  from public.app_settings s where s.id = 1;

  return coalesce(v, '{}'::jsonb);
end $fn$;

-- --------------------------------------------------- write the IP settings
--  Deliberately separate from admin_save_settings(): that function keeps its
--  own column list and its own validation, and this one cannot be tricked
--  into touching anything outside the ten keys below.
create or replace function public.admin_save_ip_settings(p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  k         text;
  v_allowed text[] := array[
    'ip_limits_enabled','ip_rate_limit_rpm','ip_rate_limit_rph',
    'ip_max_distinct_per_hour','ip_max_accounts_per_ip','ip_autoblock_minutes',
    'ip_allowlist_required','ip_denylist','ip_exempt_ips','ip_registry_retain_days'
  ];
  v_deny   text[];
  v_ex     text[];
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

  -- Addresses are normalised to CIDR here, so a typo fails loudly at save
  -- time instead of silently never matching at request time.
  if p_patch ? 'ip_denylist' then
    select public.clean_ip_list(
             array(select jsonb_array_elements_text(p_patch -> 'ip_denylist')), 200)
      into v_deny;
  end if;
  if p_patch ? 'ip_exempt_ips' then
    select public.clean_ip_list(
             array(select jsonb_array_elements_text(p_patch -> 'ip_exempt_ips')), 200)
      into v_ex;
  end if;

  update public.app_settings s set
    ip_limits_enabled = case when p_patch ? 'ip_limits_enabled'
      then coalesce((p_patch ->> 'ip_limits_enabled')::boolean, false)
      else s.ip_limits_enabled end,
    ip_rate_limit_rpm = case when p_patch ? 'ip_rate_limit_rpm'
      then least(greatest(coalesce((p_patch ->> 'ip_rate_limit_rpm')::int, 0), 0), 100000)
      else s.ip_rate_limit_rpm end,
    ip_rate_limit_rph = case when p_patch ? 'ip_rate_limit_rph'
      then least(greatest(coalesce((p_patch ->> 'ip_rate_limit_rph')::int, 0), 0), 10000000)
      else s.ip_rate_limit_rph end,
    ip_max_distinct_per_hour = case when p_patch ? 'ip_max_distinct_per_hour'
      then least(greatest(coalesce((p_patch ->> 'ip_max_distinct_per_hour')::int, 0), 0), 100000)
      else s.ip_max_distinct_per_hour end,
    ip_max_accounts_per_ip = case when p_patch ? 'ip_max_accounts_per_ip'
      then least(greatest(coalesce((p_patch ->> 'ip_max_accounts_per_ip')::int, 0), 0), 100000)
      else s.ip_max_accounts_per_ip end,
    ip_autoblock_minutes = case when p_patch ? 'ip_autoblock_minutes'
      then least(greatest(coalesce((p_patch ->> 'ip_autoblock_minutes')::int, 0), 0), 525600)
      else s.ip_autoblock_minutes end,
    ip_allowlist_required = case when p_patch ? 'ip_allowlist_required'
      then coalesce((p_patch ->> 'ip_allowlist_required')::boolean, false)
      else s.ip_allowlist_required end,
    ip_denylist  = coalesce(v_deny, s.ip_denylist),
    ip_exempt_ips = coalesce(v_ex, s.ip_exempt_ips),
    ip_registry_retain_days = case when p_patch ? 'ip_registry_retain_days'
      then least(greatest(coalesce((p_patch ->> 'ip_registry_retain_days')::int, 180), 1), 3650)
      else s.ip_registry_retain_days end
  where s.id = 1;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'save_ip_settings', 'app_settings', '1', p_patch);

  return public.admin_get_ip_settings();
end $fn$;

-- ------------------------------------------ per-account limit / exemption
--  This is the "do not limit this account" switch. p_exempt = true means no
--  rate limit, no fan-out guard and no allowlist requirement ever applies to
--  the account; explicit bans still do.
--  p_rpm: 0 inherits the workspace default, any other number overrides it.
create or replace function public.admin_set_user_ip_rules(
  p_user_id uuid,
  p_exempt  boolean default null,
  p_rpm     int     default null
)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select p.email into v_email from public.profiles p where p.id = p_user_id;
  if v_email is null then
    raise exception 'Account not found' using errcode = '22023';
  end if;

  update public.profiles p set
    ip_limit_exempt   = coalesce(p_exempt, p.ip_limit_exempt),
    ip_rate_limit_rpm = case when p_rpm is null then p.ip_rate_limit_rpm
                             else least(greatest(p_rpm, 0), 100000) end
  where p.id = p_user_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'set_user_ip_rules', 'profiles', p_user_id::text,
          jsonb_build_object('email', v_email, 'exempt', p_exempt, 'rpm', p_rpm));

  return (select jsonb_build_object('id', p.id, 'email', p.email,
                                    'ip_limit_exempt', p.ip_limit_exempt,
                                    'ip_rate_limit_rpm', p.ip_rate_limit_rpm)
            from public.profiles p where p.id = p_user_id);
end $fn$;

-- ------------------------------------------------ per-key exemption (admin)
create or replace function public.admin_set_key_ip_exempt(p_key_id uuid, p_exempt boolean)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  update public.api_keys k set ip_limit_exempt = coalesce(p_exempt, false)
  where k.id = p_key_id;

  if not found then
    raise exception 'Key not found' using errcode = '22023';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'set_key_ip_exempt', 'api_keys', p_key_id::text,
          jsonb_build_object('exempt', p_exempt));

  return jsonb_build_object('id', p_key_id, 'ip_limit_exempt', coalesce(p_exempt, false));
end $fn$;

commit;
begin;

-- ------------------------------------------------- the recorded address book
--  One row per address per account, newest activity first. This is what the
--  admin panel's "Recorded addresses" table renders.
create or replace function public.admin_ip_registry(
  p_hours  int  default 168,
  p_search text default null,
  p_limit  int  default 200
)
returns table (
  ip                text,
  user_id           uuid,
  email             text,
  full_name         text,
  requests          bigint,
  refused           bigint,
  first_seen_at     timestamptz,
  last_seen_at      timestamptz,
  accounts_on_ip    bigint,
  minute_hits       int,
  hour_hits         int,
  blocked           boolean,
  exempt_ip         boolean,
  account_exempt    boolean,
  account_rpm       int,
  note              text
)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_needle text := nullif(btrim(coalesce(p_search, '')), '');
  v_ex     text[];
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select coalesce(s.ip_exempt_ips, '{}') into v_ex
  from public.app_settings s where s.id = 1;

  return query
  select host(r.ip),
         r.user_id,
         p.email,
         p.full_name,
         r.request_count,
         r.refused_count,
         r.first_seen_at,
         r.last_seen_at,
         (select count(distinct r2.user_id) from public.ip_registry r2 where r2.ip = r.ip),
         coalesce((select b.hits from public.ip_rate_buckets b
                    where b.ip = r.ip and b.window_kind = 'minute'
                      and b.window_start = date_trunc('minute', now())), 0),
         coalesce((select b.hits from public.ip_rate_buckets b
                    where b.ip = r.ip and b.window_kind = 'hour'
                      and b.window_start = date_trunc('hour', now())), 0),
         exists (select 1 from public.blocked_ips b
                  where (b.expires_at is null or b.expires_at > now())
                    and r.ip <<= b.ip_range),
         public.ip_in_list(r.ip, v_ex),
         coalesce(p.ip_limit_exempt, false),
         coalesce(p.ip_rate_limit_rpm, 0),
         r.note
  from public.ip_registry r
  left join public.profiles p on p.id = r.user_id
  where r.last_seen_at > now() - make_interval(hours => greatest(coalesce(p_hours, 168), 1))
    and (v_needle is null
         or host(r.ip) like '%' || v_needle || '%'
         or coalesce(p.email, '') ilike '%' || v_needle || '%')
  order by r.last_seen_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $fn$;

-- ----------------------------------- add / remove one always-allow address
--  Convenience wrappers so the panel never has to read-modify-write the
--  whole array (and cannot lose a concurrent edit doing so).
create or replace function public.admin_exempt_ip(p_cidr text, p_on boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare c cidr; v_entry text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  c := public.to_cidr(p_cidr);
  v_entry := host(c::inet) || '/' || masklen(c);

  if coalesce(p_on, true) then
    update public.app_settings s
       set ip_exempt_ips = (select coalesce(array_agg(distinct x), '{}')
                              from unnest(s.ip_exempt_ips || array[v_entry]) x)
     where s.id = 1;
  else
    update public.app_settings s
       set ip_exempt_ips = (select coalesce(array_agg(x), '{}')
                              from unnest(s.ip_exempt_ips) x where x <> v_entry)
     where s.id = 1;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), case when coalesce(p_on, true) then 'exempt_ip' else 'unexempt_ip' end,
          'app_settings', v_entry, jsonb_build_object('ip', v_entry));

  return public.admin_get_ip_settings();
end $fn$;

-- ------------------------------------------------- forget a recorded address
create or replace function public.admin_forget_ip(p_ip text, p_user_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_ip inet; v_n int;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  v_ip := public.safe_inet(p_ip);
  if v_ip is null then
    raise exception '% is not a valid IP address', p_ip using errcode = '22023';
  end if;

  delete from public.ip_registry r
   where r.ip = v_ip and (p_user_id is null or r.user_id = p_user_id);
  get diagnostics v_n = row_count;

  delete from public.ip_rate_buckets b where b.ip = v_ip;

  insert into public.audit_logs (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'forget_ip', 'ip_registry', host(v_ip),
          jsonb_build_object('removed', v_n, 'user_id', p_user_id));

  return jsonb_build_object('ip', host(v_ip), 'removed', v_n);
end $fn$;

-- ------------------------------------------------------ note on one address
create or replace function public.admin_note_ip(p_ip text, p_user_id uuid, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_ip inet;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  v_ip := public.safe_inet(p_ip);
  if v_ip is null then
    raise exception '% is not a valid IP address', p_ip using errcode = '22023';
  end if;

  update public.ip_registry r
     set note = left(regexp_replace(coalesce(p_note, ''), '[<>]', '', 'g'), 200)
   where r.ip = v_ip and r.user_id = p_user_id;

  return jsonb_build_object('ip', host(v_ip), 'note', p_note);
end $fn$;

-- --------------------------------------- the caller's own recorded addresses
create or replace function public.my_ip_registry()
returns table (
  ip            text,
  requests      bigint,
  refused       bigint,
  first_seen_at timestamptz,
  last_seen_at  timestamptz
)
language sql stable security definer set search_path = public as $fn$
  select host(r.ip), r.request_count, r.refused_count, r.first_seen_at, r.last_seen_at
  from public.ip_registry r
  where r.user_id = auth.uid()
  order by r.last_seen_at desc
  limit 100;
$fn$;


-- ===========================================================================
-- 6. RLS + GRANTS FOR THE NEW TABLES
-- ===========================================================================

alter table public.ip_registry    enable row level security;
alter table public.ip_rate_buckets enable row level security;

-- An account may read its own address history; admins read everything.
-- Every write goes through the RPCs above, never straight from the browser.
drop policy if exists ip_registry_read on public.ip_registry;
create policy ip_registry_read on public.ip_registry for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists ip_registry_admin_write on public.ip_registry;
create policy ip_registry_admin_write on public.ip_registry for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Counters are operational plumbing: service role only, nobody else.
drop policy if exists ip_rate_buckets_admin on public.ip_rate_buckets;
create policy ip_rate_buckets_admin on public.ip_rate_buckets for select to authenticated
  using ((select public.is_admin()));

revoke all on public.ip_registry     from anon;
revoke all on public.ip_rate_buckets from anon;
revoke insert, update, delete on public.ip_registry from authenticated;
revoke insert, update, delete on public.ip_rate_buckets from authenticated;
grant select on public.ip_registry     to authenticated;
grant select on public.ip_rate_buckets to authenticated;
grant all    on public.ip_registry     to service_role;
grant all    on public.ip_rate_buckets to service_role;

revoke execute on function public.admin_get_ip_settings()                     from anon;
revoke execute on function public.admin_save_ip_settings(jsonb)               from anon;
revoke execute on function public.admin_set_user_ip_rules(uuid, boolean, int) from anon;
revoke execute on function public.admin_set_key_ip_exempt(uuid, boolean)      from anon;
revoke execute on function public.admin_ip_registry(int, text, int)           from anon;
revoke execute on function public.admin_exempt_ip(text, boolean)              from anon;
revoke execute on function public.admin_forget_ip(text, uuid)                 from anon;
revoke execute on function public.admin_note_ip(text, uuid, text)             from anon;
revoke execute on function public.my_ip_registry()                            from anon;

grant execute on function public.admin_get_ip_settings()                     to authenticated;
grant execute on function public.admin_save_ip_settings(jsonb)               to authenticated;
grant execute on function public.admin_set_user_ip_rules(uuid, boolean, int) to authenticated;
grant execute on function public.admin_set_key_ip_exempt(uuid, boolean)      to authenticated;
grant execute on function public.admin_ip_registry(int, text, int)           to authenticated;
grant execute on function public.admin_exempt_ip(text, boolean)              to authenticated;
grant execute on function public.admin_forget_ip(text, uuid)                 to authenticated;
grant execute on function public.admin_note_ip(text, uuid, text)             to authenticated;
grant execute on function public.my_ip_registry()                            to authenticated;


-- ===========================================================================
-- 7. VIEWS THAT NOW CARRY THE EXEMPTION FLAGS
-- ===========================================================================

drop view if exists public.admin_users cascade;
create view public.admin_users with (security_invoker = on) as
select p.id, p.email, p.full_name, p.org, p.plan, p.role, p.status,
       p.monthly_budget_usd, p.rate_limit_rpm, p.created_at,
       p.credit_balance_usd, p.credits_added_usd, p.credits_used_usd,
       coalesce(p.ip_limit_exempt, false) as ip_limit_exempt,
       coalesce(p.ip_rate_limit_rpm, 0)   as ip_rate_limit_rpm,
       (select count(*) from public.api_keys k
         where k.user_id = p.id and k.status = 'active')  as active_keys,
       (select count(distinct r.ip) from public.ip_registry r
         where r.user_id = p.id)                          as known_ips,
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

drop view if exists public.my_api_keys cascade;
create view public.my_api_keys with (security_invoker = on) as
select k.id, k.name, k.environment, k.key_prefix, k.key_last4, k.status,
       k.monthly_budget_usd, k.spend_usd, k.request_count, k.rate_limit_rpm,
       k.allowed_models, k.allowed_ips, k.ip_rate_limit_rpm,
       coalesce(k.ip_limit_exempt, false) as ip_limit_exempt,
       k.last_used_at, k.expires_at, k.created_at,
       (k.key_prefix || '••••••••' || k.key_last4) as masked_key
from public.api_keys k
where k.user_id = (select auth.uid());

grant select on public.admin_users to authenticated;
grant select on public.my_api_keys to authenticated;

commit;

-- ============================================================================
--  HOW TO DRIVE THIS
-- ----------------------------------------------------------------------------
--  Everything below is also a button in Admin -> IP limits. The SQL is here
--  so you can do it from the dashboard when the panel is not to hand.
--
--  1. WATCH FIRST, LIMIT LATER
--     Addresses are recorded from the moment this file is applied, even with
--     ip_limits_enabled = false. Leave it off for a day, then look at:
--       select * from public.admin_ip_registry(168);
--
--  2. TURN LIMITS ON
--     select public.admin_save_ip_settings('{
--       "ip_limits_enabled": true,
--       "ip_rate_limit_rpm": 120,
--       "ip_rate_limit_rph": 3000,
--       "ip_autoblock_minutes": 15
--     }');
--
--  3. DO NOT LIMIT ONE ACCOUNT  (the exemption you asked for)
--     select public.admin_set_user_ip_rules(
--       (select id from public.profiles where email = 'you@gmail.com'),
--       true, 0);
--     Undo it with false. An exempt account is still recorded, still visible
--     in the panel, and still subject to an explicit ban.
--
--  4. GIVE ONE ACCOUNT A DIFFERENT CEILING INSTEAD OF A FULL EXEMPTION
--     select public.admin_set_user_ip_rules(
--       (select id from public.profiles where email = 'partner@gmail.com'),
--       false, 600);          -- 600 req/min per address, 0 = inherit default
--
--  5. NEVER TOUCH THESE ADDRESSES  (your office, your CI, your own server)
--     select public.admin_exempt_ip('203.0.113.7');
--     select public.admin_exempt_ip('203.0.113.7', false);   -- remove
--
--  6. BAN / UNBAN
--     select public.admin_block_ip('198.51.100.23', 'scraping', 1440);
--     select public.admin_unblock_ip('198.51.100.23');
--
--  7. SWEEP
--     select public.prune_ip_data();
--
--  WHICH NUMBER WINS
--     api_keys.ip_rate_limit_rpm  >  profiles.ip_rate_limit_rpm
--                                 >  app_settings.ip_rate_limit_rpm
--     A zero means "inherit the next one down". All zeros means unlimited.
-- ============================================================================
