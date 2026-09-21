-- ===========================================================================
--  upgrade-v11.1-keywatch-repair.sql
--  Run AFTER upgrade-v11.0-keywatch-and-ponytail.sql. Safe to run twice.
-- ---------------------------------------------------------------------------
--  v11.0 shipped the key watch, but three small things stopped the scheduled
--  beat from ever being recorded. This file fixes the two that live in the
--  database. (The third is supabase/config.toml, which now carries a
--  [functions.keywatch] verify_jwt = false block — without it Supabase answers
--  the Cloudflare worker 401 before the function runs, which is why the admin
--  card said "the switch is on but the last pass was never".)
--
--    1. upstream_key_checks.source rejected the value 'cron'.
--       v11.0 widened the CHECK constraint, but the 8-argument
--       internal_record_key_result() from v6.0 still squashed anything that
--       was not manual/auto/traffic down to 'traffic' before inserting. So
--       even a working cron pass was filed under the wrong name and you could
--       not tell scheduled checks from ordinary traffic.
--
--    2. There was no way to ask the database itself what it thinks is wrong.
--       admin_keywatch_selftest() answers that in one call, in plain words,
--       and is what `npm run keywatch:doctor` reads.
--
--  Nothing here touches key material, routing, or request logging.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  0. Refuse to run on a database that has not had v11.0 applied
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'app_settings'
       and column_name  = 'keywatch_last_run_at'
  ) then
    raise exception
      'Run supabase/upgrade-v11.0-keywatch-and-ponytail.sql first: app_settings.keywatch_last_run_at is missing.';
  end if;

  if not exists (select 1 from pg_class where relname = 'keywatch_runs' and relkind = 'r') then
    raise exception
      'Run supabase/upgrade-v11.0-keywatch-and-ponytail.sql first: table keywatch_runs is missing.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  1. Let a check record say it came from cron
-- ---------------------------------------------------------------------------
--  Re-asserted here so this file also repairs a database where v11.0 was
--  applied by hand and the constraint was missed.
alter table public.upstream_key_checks
  drop constraint if exists upstream_key_checks_source_check;

alter table public.upstream_key_checks
  add constraint upstream_key_checks_source_check
  check (source in ('manual', 'auto', 'traffic', 'cron'));

--  Same body as v6.0 (timeouts, cooldowns and rotation all behave exactly as
--  before). The only change is the last line: 'cron' is now kept instead of
--  being rewritten to 'traffic'.
create or replace function public.internal_record_key_result(
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
          case when p_source in ('manual','auto','traffic','cron') then p_source else 'traffic' end);
end $$;

revoke execute on function public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text, boolean)
  from anon, authenticated;
grant execute on function public.internal_record_key_result(uuid, boolean, int, int, text, numeric, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
--  2. One call that says, in words, why the watch is idle
-- ---------------------------------------------------------------------------
--  Readable by an admin from the browser and by the service role from
--  scripts/keywatch-doctor.mjs. It reports only counts and timestamps — never
--  a key, never a secret.
create or replace function public.admin_keywatch_selftest()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s           record;
  v_role      text;
  v_every     int;
  v_since     numeric;
  v_last      record;
  v_runs_hour int;
  v_cron_hour int;
  v_keys      int;
  v_active    int;
  v_checked   int;
  v_verdict   text;
  v_next      text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );

  if not (public.is_admin() or v_role = 'service_role') then
    raise exception 'admins only' using errcode = '42501';
  end if;

  select * into s from public.app_settings where id = 1;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'enabled', false,
      'verdict', 'app_settings row 1 is missing, so there is nothing to schedule against.',
      'next_step', 'psql "$DATABASE_URL" -f supabase/schema.sql'
    );
  end if;

  v_every := greatest(coalesce(s.keywatch_interval_seconds, 15), 5);
  v_since := extract(epoch from (now() - s.keywatch_last_run_at));

  select count(*)::int,
         count(*) filter (where is_active)::int,
         count(*) filter (where last_checked_at is not null)::int
    into v_keys, v_active, v_checked
    from public.upstream_keys;

  select count(*)::int into v_runs_hour
    from public.keywatch_runs where started_at > now() - interval '1 hour';

  select count(*)::int into v_cron_hour
    from public.keywatch_runs
   where started_at > now() - interval '1 hour' and source = 'cron';

  select started_at, source, trigger, checked, working, failing, skipped, reason, error
    into v_last
    from public.keywatch_runs
   order by started_at desc
   limit 1;

  -- The ladder below is deliberately ordered the way things actually break.
  if not coalesce(s.keywatch_enabled, false) then
    v_verdict := 'The watch switch is off, so nothing is scheduled.';
    v_next    := 'Turn it on in Admin → Dashboard → Key watch.';

  elsif s.keywatch_last_run_at is null then
    v_verdict := 'The switch is on but no pass has ever been recorded. Either the keywatch function '
              || 'is not deployed, or Supabase is rejecting the cron worker before the function runs '
              || '(that happens when the function was deployed with JWT verification left on).';
    v_next    := 'supabase functions deploy keywatch --no-verify-jwt';

  elsif v_since > greatest(v_every * 6, 180) then
    v_verdict := format('The last pass was %s seconds ago, well past the %s second beat, so the '
                     || 'schedule has stopped.', round(v_since), v_every);
    v_next    := 'wrangler tail ragestar-keywatch';

  elsif v_cron_hour = 0 and v_runs_hour > 0 then
    v_verdict := 'Passes are landing, but none of them came from cron — the browser tab fallback is '
              || 'doing the work, so checks stop the moment the tab is closed.';
    v_next    := 'wrangler deploy -c cloudflare/wrangler.keywatch.toml';

  elsif s.keywatch_last_error is not null
        and s.keywatch_last_ok_at is not null
        and s.keywatch_last_ok_at < now() - make_interval(secs => v_every * 6) then
    v_verdict := 'Passes are arriving but failing: ' || left(s.keywatch_last_error, 200);
    v_next    := 'supabase functions logs keywatch';

  else
    v_verdict := format('Healthy: last pass %s seconds ago, %s runs in the last hour (%s from cron).',
                        round(coalesce(v_since, 0)), v_runs_hour, v_cron_hour);
    v_next    := null;
  end if;

  return jsonb_build_object(
    'ok',                coalesce(s.keywatch_enabled, false)
                           and s.keywatch_last_run_at is not null
                           and v_since <= greatest(v_every * 6, 180),
    'enabled',           coalesce(s.keywatch_enabled, false),
    'interval_seconds',  v_every,
    'batch_size',        coalesce(s.keywatch_batch_size, 25),
    'active_only',       coalesce(s.keywatch_active_only, true),
    'last_run_at',       s.keywatch_last_run_at,
    'last_ok_at',        s.keywatch_last_ok_at,
    'last_error',        s.keywatch_last_error,
    'seconds_since_run', case when v_since is null then null else round(v_since)::int end,
    'runs_last_hour',    v_runs_hour,
    'cron_runs_last_hour', v_cron_hour,
    'keys_total',        v_keys,
    'keys_active',       v_active,
    'keys_ever_checked', v_checked,
    'last_run',          case when v_last is null then null else to_jsonb(v_last) end,
    'verdict',           v_verdict,
    'next_step',         v_next,
    'checked_at',        now()
  );
end $$;

grant execute on function public.admin_keywatch_selftest() to authenticated, service_role;
revoke execute on function public.admin_keywatch_selftest() from anon;

notify pgrst, 'reload schema';

commit;

-- ---------------------------------------------------------------------------
--  What you should see
-- ---------------------------------------------------------------------------
select 'v11.1 keywatch repair installed'                     as result,
       (select keywatch_enabled from public.app_settings where id = 1) as watch_enabled,
       (select keywatch_last_run_at from public.app_settings where id = 1) as last_pass,
       (select count(*) from public.keywatch_runs where source = 'cron')   as cron_passes_recorded;
