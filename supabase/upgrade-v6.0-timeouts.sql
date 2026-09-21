-- ============================================================================
--  RageStar v6.0 — response deadlines + key rotation on timeout
-- ----------------------------------------------------------------------------
--  WHAT THIS ADDS
--  1. A response deadline you can set at three levels, most specific wins:
--       model.timeout_ms  ->  upstream.timeout_ms  ->  app_settings.default_timeout_ms
--  2. A key attempt budget: how many DIFFERENT upstream keys the gateway may
--     try for one request before it gives up on that provider.
--       model.max_key_attempts -> upstream.max_key_attempts -> app_settings.max_key_attempts
--  3. Timeout bookkeeping per key: timeout_count, last_timeout_at and a
--     cooldown_until window, so a key that just stalled is skipped for a while
--     instead of stalling the next caller too.
--  4. request_logs now records attempts, keys_tried, timed_out and the
--     deadline that was in force, so "why was this slow" has an answer.
--  5. Admin views + RPCs that drive the Timeouts & failover screen.
--
--  Run once in: Supabase Dashboard -> SQL Editor -> New query. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------- 1. columns
alter table public.app_settings
  add column if not exists default_timeout_ms   int     not null default 60000,
  add column if not exists max_key_attempts     int     not null default 3,
  add column if not exists retry_on_timeout     boolean not null default true,
  add column if not exists key_cooldown_seconds int     not null default 120;

alter table public.upstreams
  add column if not exists max_key_attempts int,       -- null = inherit workspace
  add column if not exists retry_on_timeout boolean;   -- null = inherit workspace

alter table public.models
  add column if not exists timeout_ms       int,       -- null = inherit provider
  add column if not exists max_key_attempts int;       -- null = inherit provider

alter table public.upstream_keys
  add column if not exists timeout_count   bigint not null default 0,
  add column if not exists last_timeout_at timestamptz,
  add column if not exists cooldown_until  timestamptz;

alter table public.request_logs
  add column if not exists attempts   int     not null default 1,
  add column if not exists keys_tried int     not null default 0,
  add column if not exists timed_out  boolean not null default false,
  add column if not exists timeout_ms int;

create index if not exists upstream_keys_cooldown_idx
  on public.upstream_keys (upstream_id, cooldown_until);
create index if not exists request_logs_timeout_idx
  on public.request_logs (timed_out, created_at desc) where timed_out;

-- Keep the numbers sane wherever they are written from.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'models_timeout_range') then
    alter table public.models add constraint models_timeout_range
      check (timeout_ms is null or timeout_ms between 1000 and 600000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'upstreams_timeout_range') then
    alter table public.upstreams add constraint upstreams_timeout_range
      check (timeout_ms between 1000 and 600000);
  end if;
end $$;

-- ------------------------------------------------------- 2. effective values
-- One place that answers "how long do we wait for this model, on this
-- provider, right now" so the gateway, the admin screen and any report all
-- agree on the same number.
create or replace function public.route_deadline(p_model_id uuid)
returns table (
  timeout_ms       int,
  max_key_attempts int,
  retry_on_timeout boolean
)
language sql stable security definer set search_path = public as $$
  select coalesce(m.timeout_ms, u.timeout_ms, s.default_timeout_ms, 60000)::int,
         greatest(coalesce(m.max_key_attempts, u.max_key_attempts, s.max_key_attempts, 3), 1)::int,
         coalesce(u.retry_on_timeout, s.retry_on_timeout, true)
  from public.models m
  join public.upstreams u on u.id = m.upstream_id
  cross join public.app_settings s
  where m.id = p_model_id and s.id = 1;
$$;

-- ------------------------------------------- 3. routing now carries deadlines
drop function if exists public.internal_resolve_route(text);
create function public.internal_resolve_route(p_model text)
returns table (
  model_id uuid, public_id text, upstream_model_id text,
  price_in_per_m numeric, price_out_per_m numeric,
  upstream_id uuid, upstream_name text, base_url text, chat_path text,
  models_path text, auth_scheme text, auth_header text, auth_query_arg text,
  extra_headers jsonb, timeout_ms int, priority int,
  max_key_attempts int, retry_on_timeout boolean
)
language sql stable security definer set search_path = public as $$
  with want as (select lower(coalesce(nullif(trim(p_model), ''), 'auto')) as m),
  cfg as (select default_timeout_ms, max_key_attempts, retry_on_timeout
          from public.app_settings where id = 1),
  pool as (
    select mo.*, up.name as up_name, up.base_url, up.chat_path, up.models_path,
           up.auth_scheme, up.auth_header, up.auth_query_arg, up.extra_headers,
           up.priority,
           -- model deadline wins, then the provider's, then the workspace default
           coalesce(mo.timeout_ms, up.timeout_ms, cfg.default_timeout_ms, 60000)::int
             as eff_timeout_ms,
           greatest(coalesce(mo.max_key_attempts, up.max_key_attempts,
                             cfg.max_key_attempts, 3), 1)::int as eff_attempts,
           coalesce(up.retry_on_timeout, cfg.retry_on_timeout, true) as eff_retry
    from public.models mo
    join public.upstreams up on up.id = mo.upstream_id
    cross join cfg
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
         p.eff_timeout_ms, p.priority, p.eff_attempts, p.eff_retry
  from pool p, want w
  where w.m not like 'auto%' and lower(p.public_id) = w.m
  union all
  select p.id, p.public_id, p.upstream_model_id, p.price_in_per_m, p.price_out_per_m,
         p.upstream_id, p.up_name, p.base_url, p.chat_path, p.models_path,
         p.auth_scheme, p.auth_header, p.auth_query_arg, p.extra_headers,
         p.eff_timeout_ms, p.priority, p.eff_attempts, p.eff_retry
  from pool p, want w
  where w.m like 'auto%'
  order by 1;
$$;

drop function if exists public.internal_route_candidates(text);
create function public.internal_route_candidates(p_model text)
returns table (
  model_id uuid, public_id text, upstream_model_id text,
  price_in_per_m numeric, price_out_per_m numeric,
  upstream_id uuid, base_url text, chat_path text,
  auth_scheme text, auth_header text, auth_query_arg text,
  extra_headers jsonb, timeout_ms int,
  max_key_attempts int, retry_on_timeout boolean, keys_available int
)
language sql stable security definer set search_path = public as $$
  with want as (select lower(coalesce(nullif(trim(p_model), ''), 'auto')) as m),
  base as (select r.*, w.m from public.internal_resolve_route(p_model) r, want w)
  select model_id, public_id, upstream_model_id, price_in_per_m, price_out_per_m,
         upstream_id, base_url, chat_path, auth_scheme, auth_header,
         auth_query_arg, extra_headers, timeout_ms,
         max_key_attempts, retry_on_timeout,
         (select count(*)::int from public.upstream_keys k
           where k.upstream_id = base.upstream_id
             and k.is_active
             and k.status in ('working','unknown','rate_limited')) as keys_available
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

-- ------------------------------------------ 4. key rotation, timeout-aware
-- Keys that just timed out sit in a cooldown window and are handed out last
-- (or not at all while the window is open), so the next caller does not pay
-- the same stall. Everything else is unchanged: healthiest first.
drop function if exists public.internal_pick_keys(uuid);
create function public.internal_pick_keys(p_upstream_id uuid)
returns table (
  key_id uuid, api_key text, status text, label text,
  timeout_count bigint, cooling boolean
)
language sql stable security definer set search_path = public as $$
  select id, api_key, status, label, timeout_count,
         (cooldown_until is not null and cooldown_until > now()) as cooling
  from public.upstream_keys
  where upstream_id = p_upstream_id
    and is_active
    and status in ('working','unknown','rate_limited')
    and (expires_at is null or expires_at > now())
    and (monthly_budget_usd is null or spend_usd < monthly_budget_usd)
  order by (cooldown_until is not null and cooldown_until > now()) asc,
           case status when 'working' then 0 when 'unknown' then 1 else 2 end,
           consecutive_failures asc,
           timeout_count asc,
           weight desc,
           last_success_at desc nulls last;
$$;

-- Outcome recorder, now with an explicit "it never answered in time" case.
drop function if exists public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text);
create function public.internal_record_key_result(
  p_key_id uuid, p_ok boolean, p_status_code int default null,
  p_latency_ms int default null, p_error text default null,
  p_cost_usd numeric default 0, p_source text default 'traffic',
  p_timed_out boolean default false
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_new  text;
  v_cool int;
begin
  select greatest(coalesce(key_cooldown_seconds, 120), 0) into v_cool
  from public.app_settings where id = 1;

  if p_ok then
    v_new := 'working';
  elsif p_timed_out then
    v_new := 'failing';                      -- alive, just too slow to use
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
         timeout_count        = timeout_count + case when p_timed_out then 1 else 0 end,
         last_timeout_at      = case when p_timed_out then now() else last_timeout_at end,
         cooldown_until       = case
                                  when p_ok then null
                                  when p_timed_out and v_cool > 0
                                    then now() + make_interval(secs => v_cool)
                                  when p_status_code = 429 and v_cool > 0
                                    then now() + make_interval(secs => v_cool)
                                  else cooldown_until
                                end,
         spend_usd            = spend_usd + coalesce(p_cost_usd, 0),
         is_active            = case when (not p_ok) and p_status_code in (401, 403)
                                     then false else is_active end
   where id = p_key_id;

  insert into public.upstream_key_checks
    (upstream_key_id, ok, status_code, latency_ms, message, source)
  values (p_key_id, p_ok, p_status_code, p_latency_ms,
          left(coalesce(case when p_timed_out then 'timeout: ' || coalesce(p_error, 'no response in time')
                             else p_error end, ''), 500),
          case when p_source in ('manual','auto','traffic') then p_source else 'traffic' end);
end $$;

-- ------------------------------------------------ 5. logging the new facts
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
    error_code, error_message, attempts, keys_tried, timed_out, timeout_ms
  )
  values (
    v_req, v_user, v_key,
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
    greatest(coalesce(nullif(p_payload ->> 'attempts', '')::int, 1), 1),
    coalesce(nullif(p_payload ->> 'keys_tried', '')::int, 0),
    coalesce((p_payload ->> 'timed_out')::boolean, false),
    nullif(p_payload ->> 'timeout_ms', '')::int
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

-- ------------------------------------------------------- 6. admin reporting
-- One row per model: where it points, what deadline applies and where that
-- deadline came from, plus how that has actually been going for 24h.
drop view if exists public.admin_route_timeouts cascade;
create view public.admin_route_timeouts as
select m.id                                as model_id,
       m.public_id,
       m.display_name,
       m.status,
       m.is_active,
       u.id                                as upstream_id,
       u.name                              as provider,
       u.slug                              as provider_slug,
       u.is_active                         as provider_active,
       m.upstream_model_id,
       m.timeout_ms                        as model_timeout_ms,
       u.timeout_ms                        as provider_timeout_ms,
       s.default_timeout_ms,
       coalesce(m.timeout_ms, u.timeout_ms, s.default_timeout_ms) as effective_timeout_ms,
       case when m.timeout_ms is not null then 'model'
            when u.timeout_ms is not null then 'provider'
            else 'workspace' end           as timeout_source,
       m.max_key_attempts                  as model_key_attempts,
       u.max_key_attempts                  as provider_key_attempts,
       s.max_key_attempts                  as default_key_attempts,
       greatest(coalesce(m.max_key_attempts, u.max_key_attempts, s.max_key_attempts), 1)
                                           as effective_key_attempts,
       coalesce(u.retry_on_timeout, s.retry_on_timeout) as retry_on_timeout,
       k.keys_total,
       k.keys_ready,
       k.keys_cooling,
       l.requests_24h,
       l.timeouts_24h,
       l.avg_latency_ms,
       l.p95_latency_ms,
       l.max_latency_ms
from public.models m
join public.upstreams u on u.id = m.upstream_id
cross join public.app_settings s
left join lateral (
  select count(*)::int                                              as keys_total,
         count(*) filter (where kk.is_active
           and kk.status in ('working','unknown','rate_limited')
           and (kk.cooldown_until is null or kk.cooldown_until <= now()))::int as keys_ready,
         count(*) filter (where kk.cooldown_until > now())::int      as keys_cooling
  from public.upstream_keys kk where kk.upstream_id = u.id
) k on true
left join lateral (
  select count(*)::int                                          as requests_24h,
         count(*) filter (where ll.timed_out)::int               as timeouts_24h,
         round(avg(ll.latency_ms) filter (where ll.ok))::int     as avg_latency_ms,
         round(percentile_cont(0.95) within group (order by ll.latency_ms)
               filter (where ll.ok))::int                        as p95_latency_ms,
         max(ll.latency_ms) filter (where ll.ok)::int            as max_latency_ms
  from public.request_logs ll
  where ll.model_public_id = m.public_id
    and ll.created_at > now() - interval '24 hours'
) l on true
where s.id = 1 and public.is_admin()
order by u.name, m.public_id;

-- One row per provider: the deadline and key budget it hands to its models,
-- and how its key pool is holding up.
drop view if exists public.admin_provider_health cascade;
create view public.admin_provider_health as
select u.id                     as upstream_id,
       u.name                    as provider,
       u.slug,
       u.base_url,
       u.is_active,
       u.priority,
       u.timeout_ms,
       coalesce(u.max_key_attempts, s.max_key_attempts) as key_attempts,
       coalesce(u.retry_on_timeout, s.retry_on_timeout) as retry_on_timeout,
       (select count(*)::int from public.models m where m.upstream_id = u.id)  as models,
       k.keys_total, k.keys_ready, k.keys_working, k.keys_cooling, k.keys_timed_out,
       l.requests_24h, l.timeouts_24h, l.failures_24h, l.avg_latency_ms, l.p95_latency_ms
from public.upstreams u
cross join public.app_settings s
left join lateral (
  select count(*)::int                                           as keys_total,
         count(*) filter (where kk.is_active
           and kk.status in ('working','unknown','rate_limited')
           and (kk.cooldown_until is null or kk.cooldown_until <= now()))::int as keys_ready,
         count(*) filter (where kk.status = 'working')::int       as keys_working,
         count(*) filter (where kk.cooldown_until > now())::int   as keys_cooling,
         count(*) filter (where kk.timeout_count > 0)::int        as keys_timed_out
  from public.upstream_keys kk where kk.upstream_id = u.id
) k on true
left join lateral (
  select count(*)::int                                        as requests_24h,
         count(*) filter (where ll.timed_out)::int             as timeouts_24h,
         count(*) filter (where not ll.ok)::int                as failures_24h,
         round(avg(ll.latency_ms) filter (where ll.ok))::int   as avg_latency_ms,
         round(percentile_cont(0.95) within group (order by ll.latency_ms)
               filter (where ll.ok))::int                      as p95_latency_ms
  from public.request_logs ll
  where ll.upstream_id = u.id and ll.created_at > now() - interval '24 hours'
) l on true
where s.id = 1 and public.is_admin()
order by u.priority, u.name;

-- Key-level rotation state, for the key pool table.
drop view if exists public.admin_key_rotation cascade;
create view public.admin_key_rotation as
select k.id, k.upstream_id, u.name as provider, u.slug as provider_slug,
       k.label, ('••••' || k.key_last4) as masked_key, k.status, k.is_active,
       k.weight, k.timeout_count, k.last_timeout_at, k.cooldown_until,
       (k.cooldown_until is not null and k.cooldown_until > now()) as cooling,
       k.consecutive_failures, k.success_count, k.failure_count,
       k.last_latency_ms, k.last_status_code, k.last_error,
       k.last_success_at, k.spend_usd, k.expires_at
from public.upstream_keys k
join public.upstreams u on u.id = k.upstream_id
where public.is_admin()
order by u.name, k.label;

-- ------------------------------------------------------------- 7. admin RPCs
create or replace function public.admin_get_timeout_settings()
returns json
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then json_build_object(
    'default_timeout_ms',   s.default_timeout_ms,
    'max_key_attempts',     s.max_key_attempts,
    'retry_on_timeout',     s.retry_on_timeout,
    'key_cooldown_seconds', s.key_cooldown_seconds,
    'failover_enabled',     s.failover_enabled,
    'max_failover_hops',    s.max_failover_hops
  ) end
  from public.app_settings s where s.id = 1;
$$;

create or replace function public.admin_save_timeout_settings(p_patch jsonb)
returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  update public.app_settings s set
    default_timeout_ms = case when p_patch ? 'default_timeout_ms'
      then least(greatest((p_patch ->> 'default_timeout_ms')::int, 1000), 600000)
      else s.default_timeout_ms end,
    max_key_attempts = case when p_patch ? 'max_key_attempts'
      then least(greatest((p_patch ->> 'max_key_attempts')::int, 1), 10)
      else s.max_key_attempts end,
    retry_on_timeout = case when p_patch ? 'retry_on_timeout'
      then (p_patch ->> 'retry_on_timeout')::boolean else s.retry_on_timeout end,
    key_cooldown_seconds = case when p_patch ? 'key_cooldown_seconds'
      then least(greatest((p_patch ->> 'key_cooldown_seconds')::int, 0), 3600)
      else s.key_cooldown_seconds end,
    failover_enabled = case when p_patch ? 'failover_enabled'
      then (p_patch ->> 'failover_enabled')::boolean else s.failover_enabled end,
    max_failover_hops = case when p_patch ? 'max_failover_hops'
      then least(greatest((p_patch ->> 'max_failover_hops')::int, 1), 10)
      else s.max_failover_hops end,
    updated_at = now()
  where s.id = 1;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'timeout_settings_saved', 'app_settings', '1', p_patch);

  return public.admin_get_timeout_settings();
end $$;

-- Per-model deadline. Pass null to fall back to the provider's value.
create or replace function public.admin_set_model_timeout(
  p_model_id uuid,
  p_timeout_ms int default null,
  p_max_key_attempts int default null
)
returns json
language plpgsql security definer set search_path = public as $$
declare v_row public.models;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  update public.models m set
    timeout_ms = case when p_timeout_ms is null then null
                      else least(greatest(p_timeout_ms, 1000), 600000) end,
    max_key_attempts = case when p_max_key_attempts is null then null
                            else least(greatest(p_max_key_attempts, 1), 10) end,
    updated_at = now()
  where m.id = p_model_id
  returning * into v_row;

  if v_row.id is null then raise exception 'model not found'; end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'model_timeout_set', 'models', p_model_id::text,
          jsonb_build_object('timeout_ms', v_row.timeout_ms,
                             'max_key_attempts', v_row.max_key_attempts));

  return json_build_object('model_id', v_row.id, 'public_id', v_row.public_id,
                           'timeout_ms', v_row.timeout_ms,
                           'max_key_attempts', v_row.max_key_attempts);
end $$;

-- Per-provider deadline, key budget and whether a stall may rotate keys.
create or replace function public.admin_set_upstream_timeout(
  p_upstream_id uuid,
  p_timeout_ms int default null,
  p_max_key_attempts int default null,
  p_retry_on_timeout boolean default null
)
returns json
language plpgsql security definer set search_path = public as $$
declare v_row public.upstreams;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  update public.upstreams u set
    timeout_ms = case when p_timeout_ms is null then u.timeout_ms
                      else least(greatest(p_timeout_ms, 1000), 600000) end,
    max_key_attempts = case when p_max_key_attempts is null then null
                            else least(greatest(p_max_key_attempts, 1), 10) end,
    retry_on_timeout = p_retry_on_timeout,
    updated_at = now()
  where u.id = p_upstream_id
  returning * into v_row;

  if v_row.id is null then raise exception 'upstream not found'; end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'upstream_timeout_set', 'upstreams', p_upstream_id::text,
          jsonb_build_object('timeout_ms', v_row.timeout_ms,
                             'max_key_attempts', v_row.max_key_attempts,
                             'retry_on_timeout', v_row.retry_on_timeout));

  return json_build_object('upstream_id', v_row.id, 'timeout_ms', v_row.timeout_ms,
                           'max_key_attempts', v_row.max_key_attempts,
                           'retry_on_timeout', v_row.retry_on_timeout);
end $$;

-- Clear a cooldown by hand when you know the provider recovered.
create or replace function public.admin_clear_key_cooldown(p_key_id uuid)
returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.upstream_keys
     set cooldown_until = null,
         consecutive_failures = 0,
         status = case when status = 'failing' then 'unknown' else status end
   where id = p_key_id;
  return json_build_object('ok', true, 'key_id', p_key_id);
end $$;

-- ---------------------------------------------------------------- 8. grants
grant select on public.admin_route_timeouts  to authenticated;
grant select on public.admin_provider_health to authenticated;
grant select on public.admin_key_rotation    to authenticated;

grant execute on function public.admin_get_timeout_settings()                     to authenticated;
grant execute on function public.admin_save_timeout_settings(jsonb)               to authenticated;
grant execute on function public.admin_set_model_timeout(uuid, int, int)          to authenticated;
grant execute on function public.admin_set_upstream_timeout(uuid, int, int, boolean) to authenticated;
grant execute on function public.admin_clear_key_cooldown(uuid)                   to authenticated;

revoke execute on function public.internal_resolve_route(text)        from anon, authenticated;
revoke execute on function public.internal_route_candidates(text)     from anon, authenticated;
revoke execute on function public.internal_pick_keys(uuid)            from anon, authenticated;
revoke execute on function public.route_deadline(uuid)                from anon, authenticated;
revoke execute on function public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text, boolean)
  from anon, authenticated;

grant execute on function public.internal_resolve_route(text)         to service_role;
grant execute on function public.internal_route_candidates(text)      to service_role;
grant execute on function public.internal_pick_keys(uuid)             to service_role;
grant execute on function public.route_deadline(uuid)                 to service_role;
grant execute on function public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text, boolean)
  to service_role;
grant execute on function public.internal_log_request(jsonb)          to service_role;

notify pgrst, 'reload schema';

select 'v6.0 timeouts + key rotation installed' as result,
       (select default_timeout_ms from public.app_settings where id = 1) as default_timeout_ms,
       (select max_key_attempts   from public.app_settings where id = 1) as key_attempts,
       (select count(*) from public.models where timeout_ms is not null) as models_with_own_deadline;
