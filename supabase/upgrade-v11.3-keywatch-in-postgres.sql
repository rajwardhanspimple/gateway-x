-- ===========================================================================
--  upgrade-v11.3-keywatch-in-postgres.sql
--  Replace the Cloudflare cron worker with pg_cron inside Supabase.
--  Run AFTER v11.0 and v11.1. Safe to run twice.
-- ---------------------------------------------------------------------------
--  WHY THIS EXISTS
--
--  The v11 beat has four independent links, and three of them live outside
--  this repository:
--
--      Cloudflare cron  ->  worker secrets  ->  Supabase gateway  ->  function
--
--  Any one of them can fail while every dashboard stays green, which is why
--  "redeploy the worker" is the only advice the repo can give: the repo cannot
--  see the worker. This file deletes two of those links. The schedule moves
--  into the same database that holds the state, so the thing that decides a
--  pass is due and the thing that records it are one transaction apart, and
--  `select * from cron.job_run_details` is a real, readable log.
--
--  What is removed: Cloudflare entirely. No worker, no KEYWATCH_URL, no
--  KEYWATCH_SECRET on the worker, no shared-secret mismatch, no 401 at the
--  gateway. Stop the old worker with:
--      npx wrangler delete ragestar-keywatch
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  0. Prerequisites
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
      'Run supabase/upgrade-v11.0-keywatch-and-ponytail.sql first.';
  end if;
end $$;

create extension if not exists pg_cron;
create extension if not exists pg_net;

begin;

-- ---------------------------------------------------------------------------
--  1. Stop the card from lying about a beat nothing can deliver
-- ---------------------------------------------------------------------------
--  admin_keywatch_status() calls the beat `stale` when the last pass is older
--  than interval_seconds * 3. At the shipped default of 15 that is a 45
--  second freshness promise -- but *no* minute-resolution scheduler (Cloudflare
--  cron, pg_cron, GitHub Actions, any of them) can promise 45 seconds. A
--  perfectly healthy setup therefore flickers amber on drift alone.
--
--  60 seconds matches what a scheduler can actually guarantee, so amber now
--  means "something is broken" instead of "it is Tuesday".
update public.app_settings
   set keywatch_interval_seconds = greatest(keywatch_interval_seconds, 60)
 where id = 1;

-- ---------------------------------------------------------------------------
--  2. Schedule / unschedule / inspect, from SQL
-- ---------------------------------------------------------------------------
--  p_passes defaults to 3, not 4. The function's loop only sleeps when the
--  remaining wall-clock budget exceeds the spacing, so with WALL_CLOCK_MS =
--  50000 and spacing 15000 the 4th pass always fires early, is refused by
--  internal_keywatch_due() as "not due", and is logged as a skip. Three passes
--  is what 50 seconds actually fits.
create or replace function public.keywatch_schedule(
  p_url     text,
  p_secret  text,
  p_cron    text default '* * * * *',
  p_passes  int  default 3,
  p_spacing int  default 15000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_job_id bigint;
begin
  if p_url is null or p_url !~ '^https://' then
    raise exception 'p_url must be the https URL of the keywatch function';
  end if;
  if coalesce(p_secret, '') = '' then
    raise exception 'p_secret must be the same value as KEYWATCH_CRON_SECRET on the function';
  end if;

  perform cron.unschedule('ragestar-keywatch')
    where exists (select 1 from cron.job where jobname = 'ragestar-keywatch');

  select cron.schedule(
    'ragestar-keywatch',
    p_cron,
    format(
      $q$select net.http_post(
           url     := %L,
           headers := jsonb_build_object(
                        'content-type',      'application/json',
                        'x-keywatch-secret', %L),
           body    := jsonb_build_object(
                        'source',     'pg_cron',
                        'trigger',    'pg_cron:%s',
                        'passes',     %s,
                        'spacing_ms', %s),
           timeout_milliseconds := 55000
         )$q$,
      p_url, p_secret, p_cron,
      greatest(least(coalesce(p_passes, 3), 12), 1),
      greatest(least(coalesce(p_spacing, 15000), 60000), 0)
    )
  ) into v_job_id;

  return jsonb_build_object(
    'scheduled', true,
    'job_id',    v_job_id,
    'jobname',   'ragestar-keywatch',
    'schedule',  p_cron,
    'target',    regexp_replace(p_url, '^(https://[^/]+).*$', '\1/functions/v1/keywatch')
  );
end $fn$;

create or replace function public.keywatch_unschedule()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform cron.unschedule('ragestar-keywatch')
    where exists (select 1 from cron.job where jobname = 'ragestar-keywatch');
  return jsonb_build_object('scheduled', false);
end $fn$;

-- The log the Cloudflare worker could never give you: every firing, its exit
-- status, and the HTTP reply the function sent back.
create or replace function public.keywatch_cron_log(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_out jsonb;
begin
  if not public.is_admin() then
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
revoke execute on function public.keywatch_schedule(text, text, text, int, int) from anon, authenticated;
revoke execute on function public.keywatch_unschedule() from anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- ===========================================================================
--  TURN IT ON  --  two statements, run as the postgres/owner role
-- ---------------------------------------------------------------------------
--  The function stays exactly as it is. Only the caller changes.
--
--    1. make sure the function is deployed and holds its secret:
--         supabase functions deploy keywatch --no-verify-jwt
--         supabase secrets set KEYWATCH_CRON_SECRET="$(openssl rand -hex 32)"
--
--    2. point Postgres at it, with that same secret:
--
--  select public.keywatch_schedule(
--    'https://<project>.supabase.co/functions/v1/keywatch',
--    '<the same KEYWATCH_CRON_SECRET value>'
--  );
--
--  Prove it, 60-90 seconds later:
--
--    select public.admin_keywatch_selftest();   -- the app's verdict
--    select public.keywatch_cron_log(10);       -- every firing + HTTP reply
--    select * from cron.job where jobname = 'ragestar-keywatch';
--
--  Reading keywatch_cron_log():
--    status 'succeeded' + http_status 200  -> working
--    status 'succeeded' + http_status 403  -> the two secrets differ
--    status 'succeeded' + http_status 401  -> redeploy with --no-verify-jwt
--    status 'succeeded' + http_status 404  -> wrong URL / not deployed
--    status 'succeeded' + http_status null -> pg_net has not answered yet, or
--                                             pg_net is not enabled
--    status 'failed'                       -> read `message`
--
--  Turn it off again:  select public.keywatch_unschedule();
-- ===========================================================================
