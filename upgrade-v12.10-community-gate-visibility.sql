-- ============================================================================
-- v12.10 — Community-gate refusals are NOT errors, and get their own surface
-- ----------------------------------------------------------------------------
-- The community gate (v12.3) refuses a call with 403 until the account has
-- checked into the portal. Those refusals were written to request_logs as
-- ok=false like any upstream failure, so a busy morning of "post first" denials
-- dragged the success rate down and sat in Request logs as if they were faults.
--
--   · request_logs.community_gate_denied  — marks a refusal that came from the
--     community gate, not from an upstream. Set by the router and, as a safety
--     net, derived from error_code inside internal_log_request.
--   · success/failure math EXCLUDES them: route_health, gateway_daily_health
--     and admin_dashboard count only real failures (not ok AND not a gate
--     denial). The denial is still recorded — it is simply no longer "failed".
--   · my_request_logs / admin request logs no longer list them; two new views
--     (my_gate_denials / admin_gate_denials) power a dedicated tab instead.
--
-- Run after upgrade-v12.9-discord-gate.sql. Idempotent — safe to re-run.
-- ============================================================================

begin;

-- 1. the marker column ---------------------------------------------------------
alter table public.request_logs
  add column if not exists community_gate_denied boolean not null default false;

create index if not exists request_logs_gate_idx
  on public.request_logs (community_gate_denied, created_at desc)
  where community_gate_denied;

-- Backfill anything the gate refused before this column existed. Both codes are
-- 403s with no upstream spend, so reclassifying them is safe.
update public.request_logs
   set community_gate_denied = true
 where error_code in ('community_checkin_required', 'community_participation_required');

-- 2. internal_log_request(): store the flag ------------------------------------
-- Full replacement of the v11.6 body (dialect/harness + safe_inet client_ip),
-- plus the debit block restored by v12.8, plus the new marker. The marker is
-- taken from the payload when the router sets it, and derived from error_code
-- otherwise, so an older router still classifies correctly.
create or replace function public.internal_log_request(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_user  uuid := nullif(p_payload ->> 'user_id', '')::uuid;
  v_key   uuid := nullif(p_payload ->> 'api_key_id', '')::uuid;
  v_cost  numeric(12,6) := coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0);
  v_req   text := coalesce(p_payload ->> 'request_id',
                  'req_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
  v_ecode text := nullif(p_payload ->> 'error_code', '');
  v_gate  boolean := coalesce((p_payload ->> 'community_gate_denied')::boolean, false)
                     or v_ecode in ('community_checkin_required', 'community_participation_required');
begin
  insert into public.request_logs (
    request_id, user_id, api_key_id, model_public_id, policy,
    upstream_id, upstream_key_id, ok, status_code, latency_ms,
    tokens_in, tokens_out, cost_usd, failover_count, streamed,
    error_code, error_message, tokens_saved, compressors_applied,
    dialect, harness, client_ip, community_gate_denied
  ) values (
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
    v_ecode,
    left(coalesce(p_payload ->> 'error_message', ''), 1000),
    coalesce(nullif(p_payload ->> 'tokens_saved', '')::int, 0),
    coalesce(
      (select array_agg(value::text)
         from jsonb_array_elements_text(
           case jsonb_typeof(p_payload -> 'compressors_applied')
             when 'array' then p_payload -> 'compressors_applied'
             else '[]'::jsonb
           end
         ) as value),
      '{}'::text[]
    ),
    nullif(p_payload ->> 'dialect', ''),
    nullif(p_payload ->> 'harness', ''),
    public.safe_inet(p_payload ->> 'client_ip'),
    v_gate
  ) returning id into v_id;

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
grant execute on function public.internal_log_request(jsonb) to service_role;

commit;

-- 3. success rate excludes gate denials ---------------------------------------
-- Per-model health (public status + console Status tab): a gate denial is not
-- a failure, so it drops out of ok_24h / success_rate. Denied rows still count
-- toward requests_24h so the volume stays honest.
begin;

drop view if exists public.route_health cascade;
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
         case when count(l.id) filter (where not l.community_gate_denied) = 0 then null
              else round(
                100.0 * count(l.id) filter (where l.ok)
                / count(l.id) filter (where not l.community_gate_denied), 2)
         end,
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

create view public.route_health with (security_invoker = on) as
  select * from public.fn_route_health();

-- Daily rollup (console "Daily volume" chart): same exclusion on `failed`.
drop view if exists public.gateway_daily_health cascade;
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
         count(l.id) filter (where not l.ok and not l.community_gate_denied),
         round(avg(l.latency_ms) filter (where l.ok))
  from generate_series(current_date - 89, current_date, interval '1 day') d
  left join public.request_logs l
         on l.created_at >= d and l.created_at < d + interval '1 day'
  group by d
  order by d;
$$;

create view public.gateway_daily_health with (security_invoker = on) as
  select * from public.fn_gateway_daily_health();

grant select on public.route_health         to anon, authenticated;
grant select on public.gateway_daily_health to anon, authenticated;
grant execute on function public.fn_route_health()        to anon, authenticated;
grant execute on function public.fn_gateway_daily_health() to anon, authenticated;

commit;

-- 4. admin dashboard: errors_24h no longer counts gate denials -----------------
begin;

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
    'errors_24h',       (select count(*) from public.request_logs where not ok and not community_gate_denied and created_at > now() - interval '24 hours'),
    'gate_denied_24h',  (select count(*) from public.request_logs where community_gate_denied and created_at > now() - interval '24 hours'),
    'cost_24h',         (select coalesce(sum(cost_usd), 0) from public.request_logs where created_at > now() - interval '24 hours'),
    'cost_30d',         (select coalesce(sum(cost_usd), 0) from public.request_logs where created_at > now() - interval '30 days'),
    'avg_latency_24h',  (select coalesce(round(avg(latency_ms)), 0) from public.request_logs where created_at > now() - interval '24 hours')
  );
end $$;

-- 5. log views drop the denials; a dedicated surface lists them ----------------
-- my_request_logs: same columns as v5.6, minus community-gate refusals (they
-- are not requests that reached an upstream).
drop view if exists public.my_request_logs cascade;
create view public.my_request_logs with (security_invoker = on) as
select l.id, l.request_id, l.api_key_id, l.model_public_id, l.policy,
       l.ok, l.status_code, l.latency_ms, l.tokens_in, l.tokens_out,
       l.cost_usd, l.failover_count, l.streamed, l.error_code, l.error_message,
       host(l.client_ip) as client_ip,
       l.created_at
from public.request_logs l
where l.user_id = (select auth.uid())
  and not l.community_gate_denied;

-- The new tab: gate denials only. One row per refused call, newest first.
drop view if exists public.my_gate_denials cascade;
create view public.my_gate_denials with (security_invoker = on) as
select l.id, l.request_id, l.model_public_id, l.error_code, l.error_message,
       l.created_at
from public.request_logs l
where l.user_id = (select auth.uid())
  and l.community_gate_denied
order by l.created_at desc;

drop view if exists public.admin_gate_denials cascade;
create view public.admin_gate_denials as
select l.id, l.request_id, l.user_id, p.email as user_email, l.model_public_id,
       l.error_code, l.error_message, l.created_at
from public.request_logs l
left join public.profiles p on p.id = l.user_id
where l.community_gate_denied
  and public.is_admin()
order by l.created_at desc;

grant select on public.my_request_logs    to authenticated;
grant select on public.my_gate_denials    to authenticated;
grant select on public.admin_gate_denials to authenticated;

-- 6. the usage sheets and the console summary follow the same rule -----------
begin;

-- Console → Usage (the spreadsheet): drop the denials out of the row list.
create or replace function public.my_usage_sheet(p_days int default 30, p_limit int default 2000)
returns table (
  created_at timestamptz, request_id text, model text, provider text,
  dialect text, harness text, policy text, ok boolean,
  status_code int, latency_ms int, tokens_in int, tokens_out int,
  tokens_total int, cost_usd numeric, streamed boolean, error_code text, kie boolean
)
language sql stable security definer set search_path = public as $$
  select
    l.created_at, l.request_id, l.model_public_id,
    case when u.wire_format = 'kie_responses' then 'KIE ORIGINAL' else null end,
    coalesce(l.dialect, 'chat'), coalesce(l.harness, 'api'), l.policy, l.ok,
    l.status_code, l.latency_ms,
    coalesce(l.tokens_in, 0), coalesce(l.tokens_out, 0),
    coalesce(l.tokens_in, 0) + coalesce(l.tokens_out, 0),
    coalesce(l.cost_usd, 0), l.streamed, l.error_code,
    coalesce(u.wire_format = 'kie_responses', false)
  from public.request_logs l
  left join public.upstreams u on u.id = l.upstream_id
  where l.user_id = auth.uid()
    and not l.community_gate_denied
    and l.created_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  order by l.created_at desc
  limit least(greatest(coalesce(p_limit, 2000), 1), 5000)
$$;

grant execute on function public.my_usage_sheet(int, int) to authenticated;

-- Admin usage sheet: same exclusion (denials are on the Gate denials tab).
create or replace function public.admin_usage_sheet(
  p_days int default 30, p_limit int default 2000, p_kie_only boolean default false
)
returns table (
  created_at timestamptz, request_id text, account text, model text,
  provider text, dialect text, harness text, policy text, ok boolean,
  status_code int, latency_ms int, tokens_in int, tokens_out int,
  tokens_total int, cost_usd numeric, key_label text, error_code text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;

  return query
    select
      l.created_at, l.request_id, coalesce(pr.email, '-'), l.model_public_id,
      case when u.wire_format = 'kie_responses' then 'KIE ORIGINAL' else u.name end,
      coalesce(l.dialect, 'chat'), coalesce(l.harness, 'api'), l.policy, l.ok,
      l.status_code, l.latency_ms,
      coalesce(l.tokens_in, 0), coalesce(l.tokens_out, 0),
      coalesce(l.tokens_in, 0) + coalesce(l.tokens_out, 0),
      coalesce(l.cost_usd, 0), k.label, l.error_code
    from public.request_logs l
    left join public.upstreams u on u.id = l.upstream_id
    left join public.upstream_keys k on k.id = l.upstream_key_id
    left join public.profiles pr on pr.id = l.user_id
    where not l.community_gate_denied
      and l.created_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
      and (not coalesce(p_kie_only, false) or u.wire_format = 'kie_responses')
    order by l.created_at desc
    limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
end $$;

grant execute on function public.admin_usage_sheet(int, int, boolean) to authenticated;

-- Console overview numbers: `failed` excludes denials everywhere they feed.
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
    'failed',        (select count(*) from win where not ok and not community_gate_denied),
    'gate_denied',   (select count(*) from win where community_gate_denied),
    'tokens_in',     (select coalesce(sum(tokens_in), 0)  from win),
    'tokens_out',    (select coalesce(sum(tokens_out), 0) from win),
    'cost_usd',      (select coalesce(sum(cost_usd), 0)   from win),
    'avg_latency_ms',(select coalesce(round(avg(latency_ms)), 0) from win),
    'active_keys',   (select count(*) from public.api_keys
                       where user_id = auth.uid() and status = 'active'),
    'last_request_at', (select max(created_at) from win)
  );
$$;

create or replace function public.my_usage_series(p_days int default 14)
returns table (day date, requests bigint, failed bigint, tokens bigint, cost_usd numeric)
language sql stable security definer set search_path = public as $$
  select d::date as day,
         count(l.id)                                   as requests,
         count(l.id) filter (where not l.ok and not l.community_gate_denied) as failed,
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

commit;

-- ============================================================================
--  VERIFY
-- ============================================================================
--   -- a gate refusal is marked and is no longer a "failure":
--   select ok, community_gate_denied from public.request_logs
--    where error_code like 'community_%' order by created_at desc limit 3;
--   -- success rate for a model with only denials in 24h reads clean:
--   select model, requests_24h, ok_24h, success_rate from public.route_health;
--   -- the new surfaces:
--   select * from public.my_gate_denials limit 5;
--   select * from public.admin_gate_denials limit 5;
--   Re-run the whole file: every statement is idempotent.
-- ============================================================================

