-- ===========================================================================
--  upgrade-v11.3b-selftest-pg-cron.sql
--  Teach the app's own diagnostics that the scheduler is now pg_cron.
--  Run AFTER upgrade-v11.3-keywatch-in-postgres.sql. Safe to run twice.
-- ---------------------------------------------------------------------------
--  WHY THIS EXISTS
--
--  v11.3 moved the schedule into Postgres, but admin_keywatch_selftest() was
--  written in v11.1 and still answers every stall with Cloudflare advice:
--
--      "wrangler tail ragestar-keywatch"
--      "wrangler deploy -c cloudflare/wrangler.keywatch.toml"
--
--  Those commands now point at a worker that no longer exists, so the one
--  function whose entire job is to name the fault would send you to the wrong
--  place. Worse, it could not see the new failure mode at all: pg_cron holding
--  no job. A database with the migration applied but keywatch_schedule() never
--  called looks identical to a dead Cloudflare worker from the old function's
--  point of view.
--
--  This file replaces the verdict ladder with one that checks cron.job first
--  and reads the real HTTP reply out of the pg_cron log, so the card and
--  `npm run keywatch:doctor` both name the actual cause.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'keywatch_schedule'
  ) then
    raise exception
      'Run supabase/upgrade-v11.3-keywatch-in-postgres.sql first.';
  end if;
end $$;

begin;

create or replace function public.admin_keywatch_selftest()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s            record;
  v_role       text;
  v_every      int;
  v_since      numeric;
  v_last       record;
  v_runs_hour  int;
  v_cron_hour  int;
  v_keys       int;
  v_active     int;
  v_checked    int;
  v_verdict    text;
  v_next       text;
  v_job        record;
  v_job_seen   boolean := false;
  v_job_active boolean := null;
  v_job_sched  text    := null;
  v_http       int     := null;
  v_fire_at    timestamptz := null;
  v_fire_stat  text    := null;
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
      'scheduler', 'pg_cron',
      'verdict', 'app_settings row 1 is missing, so there is nothing to schedule against.',
      'next_step', 'psql "$DATABASE_URL" -f supabase/schema.sql'
    );
  end if;

  v_every := greatest(coalesce(s.keywatch_interval_seconds, 60), 5);
  v_since := extract(epoch from (now() - s.keywatch_last_run_at));

  select count(*)::int,
         count(*) filter (where is_active)::int,
         count(*) filter (where last_checked_at is not null)::int
    into v_keys, v_active, v_checked
    from public.upstream_keys;

  select count(*)::int into v_runs_hour
    from public.keywatch_runs where started_at > now() - interval '1 hour';

  --  v11.3: pg_cron sends source = 'pg_cron'. 'cron' is still accepted so a
  --  database mid-migration (old worker still firing) reads correctly.
  select count(*)::int into v_cron_hour
    from public.keywatch_runs
   where started_at > now() - interval '1 hour'
     and source in ('cron', 'pg_cron');

  select started_at, source, trigger, checked, working, failing, skipped, reason, error
    into v_last
    from public.keywatch_runs
   order by started_at desc
   limit 1;

  -- ---------------------------------------------------------------------
  --  Does Postgres actually hold the schedule? This is the failure mode the
  --  v11.1 function could not see: migration applied, keywatch_schedule()
  --  never called, everything else green.
  -- ---------------------------------------------------------------------
  begin
    select j.jobid, j.schedule, j.active
      into v_job
      from cron.job j
     where j.jobname = 'ragestar-keywatch'
     limit 1;

    v_job_seen := found;
    if found then
      v_job_sched  := v_job.schedule;
      v_job_active := v_job.active;
    end if;
  exception when others then
    --  No privilege on the cron schema, or pg_cron is not installed. Report
    --  "unknown" rather than claiming the job is missing.
    v_job_seen := null;
  end;

  -- The HTTP reply the function actually sent back on the last firing. This
  -- is the thing Cloudflare could never show without opening a dashboard.
  begin
    select d.start_time, d.status, r.status_code
      into v_fire_at, v_fire_stat, v_http
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
      left join net._http_response r
             on r.created >= d.start_time
            and r.created <= d.end_time + interval '60 seconds'
     where j.jobname = 'ragestar-keywatch'
     order by d.start_time desc
     limit 1;
  exception when others then
    v_http := null;
  end;

  -- ---------------------------------------------------------------------
  --  Verdict ladder, ordered the way things actually break under pg_cron.
  -- ---------------------------------------------------------------------
  if not coalesce(s.keywatch_enabled, false) then
    v_verdict := 'The watch switch is off, so nothing is scheduled.';
    v_next    := 'Turn it on in Admin → Dashboard → Key watch.';

  elsif v_job_seen is false then
    v_verdict := 'The switch is on, but Postgres holds no schedule: there is no pg_cron job '
              || 'named ragestar-keywatch. The v11.3 migration creates the helper functions '
              || 'but does not start the beat — keywatch_schedule() has to be called once.';
    v_next    := 'select public.keywatch_schedule('
              || '''https://<project>.supabase.co/functions/v1/keywatch'', ''<KEYWATCH_CRON_SECRET>'');';

  elsif v_job_active is false then
    v_verdict := 'The pg_cron job exists but is inactive, so it never fires.';
    v_next    := 'update cron.job set active = true where jobname = ''ragestar-keywatch'';';

  elsif v_http = 403 then
    v_verdict := 'pg_cron is firing and reaching the function, but the function refuses the '
              || 'secret (403). The value passed to keywatch_schedule() does not match '
              || 'KEYWATCH_CRON_SECRET on the function.';
    v_next    := 'Re-run keywatch_schedule() with the same value as: supabase secrets list';

  elsif v_http = 401 then
    v_verdict := 'Supabase is rejecting the scheduled call before the function runs (401). '
              || 'The function is deployed with JWT verification on.';
    v_next    := 'supabase functions deploy keywatch --no-verify-jwt';

  elsif v_http = 404 then
    v_verdict := 'pg_cron is firing at a URL where no keywatch function answers (404).';
    v_next    := 'supabase functions deploy keywatch --no-verify-jwt, then re-run keywatch_schedule() with the correct URL.';

  elsif s.keywatch_last_run_at is null then
    v_verdict := 'The switch is on and the pg_cron job exists, but no pass has ever been '
              || 'recorded. Read the log: it holds every firing and the HTTP reply.';
    v_next    := 'select public.keywatch_cron_log(10);';

  elsif v_since > greatest(v_every * 6, 180) then
    v_verdict := format('The last pass was %s seconds ago, well past the %s second beat, so the '
                     || 'schedule has stopped.', round(v_since), v_every);
    v_next    := 'select public.keywatch_cron_log(10);';

  elsif v_cron_hour = 0 and v_runs_hour > 0 then
    v_verdict := 'Passes are landing, but none came from the scheduler — the browser tab '
              || 'fallback is doing the work, so checks stop the moment the tab is closed.';
    v_next    := 'select public.keywatch_cron_log(10);';

  elsif s.keywatch_last_error is not null
        and s.keywatch_last_ok_at is not null
        and s.keywatch_last_ok_at < now() - make_interval(secs => v_every * 6) then
    v_verdict := 'Passes are arriving but failing: ' || left(s.keywatch_last_error, 200);
    v_next    := 'supabase functions logs keywatch';

  else
    v_verdict := format('Healthy: last pass %s seconds ago, %s runs in the last hour (%s scheduled).',
                        round(coalesce(v_since, 0)), v_runs_hour, v_cron_hour);
    v_next    := null;
  end if;

  return jsonb_build_object(
    'ok',                  coalesce(s.keywatch_enabled, false)
                             and s.keywatch_last_run_at is not null
                             and v_since <= greatest(v_every * 6, 180)
                             and coalesce(v_job_seen, true),
    'enabled',             coalesce(s.keywatch_enabled, false),
    'scheduler',           'pg_cron',
    'cron_job_present',    v_job_seen,
    'cron_job_active',     v_job_active,
    'cron_schedule',       v_job_sched,
    'cron_last_fire_at',   v_fire_at,
    'cron_last_fire_status', v_fire_stat,
    'cron_last_http',      v_http,
    'interval_seconds',    v_every,
    'batch_size',          coalesce(s.keywatch_batch_size, 25),
    'active_only',         coalesce(s.keywatch_active_only, true),
    'last_run_at',         s.keywatch_last_run_at,
    'last_ok_at',          s.keywatch_last_ok_at,
    'last_error',          s.keywatch_last_error,
    'seconds_since_run',   case when v_since is null then null else round(v_since)::int end,
    'runs_last_hour',      v_runs_hour,
    'cron_runs_last_hour', v_cron_hour,
    'keys_total',          v_keys,
    'keys_active',         v_active,
    'keys_ever_checked',   v_checked,
    'last_run',            case when v_last is null then null else to_jsonb(v_last) end,
    'verdict',             v_verdict,
    'next_step',           v_next,
    'checked_at',          now()
  );
end $$;

grant execute on function public.admin_keywatch_selftest() to authenticated, service_role;
revoke execute on function public.admin_keywatch_selftest() from anon;

-- ---------------------------------------------------------------------------
--  keywatch_cron_log(): let a service-role script read it too
-- ---------------------------------------------------------------------------
--  v11.3 gated this on public.is_admin() alone. is_admin() reads the JWT of a
--  logged-in user, so it is false for the service role -- which means
--  `npm run keywatch:doctor`, and every other server-side script, gets
--  "admins only" from the one function written to explain outages. The gate
--  below matches admin_keywatch_selftest(): an admin user OR the service role.
create or replace function public.keywatch_cron_log(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_out  jsonb;
  v_role text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );

  if not (public.is_admin() or v_role = 'service_role') then
    raise exception 'admins only' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(t order by t.start_time desc), '[]'::jsonb)
    into v_out
    from (
      select d.start_time,
             d.end_time,
             d.status,
             left(coalesce(d.return_message, ''), 200) as message,
             r.status_code                             as http_status,
             left(coalesce(r.content, ''), 300)        as http_body
        from cron.job_run_details d
        join cron.job j on j.jobid = d.jobid
        left join net._http_response r
               on r.created >= d.start_time
              and r.created <= d.end_time + interval '60 seconds'
       where j.jobname = 'ragestar-keywatch'
       order by d.start_time desc
       limit greatest(least(coalesce(p_limit, 20), 200), 1)
    ) t;

  return v_out;
end $fn$;

grant execute on function public.keywatch_cron_log(int) to authenticated, service_role;
revoke execute on function public.keywatch_cron_log(int) from anon;

-- A pass recorded by pg_cron arrives with source = 'pg_cron'. v11.0 constrained
-- upstream_key_checks.source to a fixed list; add the new value or every
-- recorded result fails the check constraint.
alter table public.upstream_key_checks
  drop constraint if exists upstream_key_checks_source_check;

alter table public.upstream_key_checks
  add constraint upstream_key_checks_source_check
  check (source in ('manual', 'auto', 'traffic', 'cron', 'pg_cron'));

notify pgrst, 'reload schema';

commit;

-- ---------------------------------------------------------------------------
--  What you should see
-- ---------------------------------------------------------------------------
select 'v11.3b selftest is pg_cron-aware' as result,
       (select count(*) from cron.job where jobname = 'ragestar-keywatch') as job_rows;


-- ---------------------------------------------------------------------------
--  Undo the 60-second interval floor
-- ---------------------------------------------------------------------------
--  upgrade-v11.3 ends with:
--
--      update public.app_settings
--         set keywatch_interval_seconds = greatest(keywatch_interval_seconds, 60)
--       where id = 1;
--
--  That looks harmless -- pg_cron cannot fire more often than once a minute,
--  so why allow a 15-second interval? -- but it quietly destroys the feature.
--  The 15-second beat never came from the scheduler. It comes from the edge
--  function, which runs several spaced passes inside one invocation, and each
--  of those passes has to be granted by internal_keywatch_due():
--
--      v_every := greatest(coalesce(s.keywatch_interval_seconds, 15), 5);
--      if not v_forced and v_gap < (v_every * 0.9) then  -->  refused
--
--  With the floor at 60, pass 1 of a minute is granted and passes 2, 3 and 4
--  are refused as "next pass in 45 s". The function still reports success, the
--  card still shows a fresh pass, the doctor still prints green -- and the
--  keys are being checked once a minute instead of four times. Exactly the
--  class of silent-green failure the v11.0 401 bug already taught us about.
--
--  So: put the floor back where the function can use it. 15 is restored only
--  where the clamp actually moved the value (60); a deliberate 300 stays 300.
update public.app_settings
   set keywatch_interval_seconds = 15
 where id = 1
   and keywatch_interval_seconds = 60;

--  And schedule 4 passes, not 3. Spaced 15 s apart the fourth starts at t=45s,
--  inside both the function's 50 s wall clock and pg_net's 55 s timeout.
--      select public.keywatch_schedule(<url>, <secret>, '* * * * *', 4, 15000);

select keywatch_enabled,
       keywatch_interval_seconds,
       keywatch_batch_size
  from public.app_settings
 where id = 1;
