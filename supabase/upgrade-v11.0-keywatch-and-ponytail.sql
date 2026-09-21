-- ============================================================================
--  RageStar v11.0  —  server-side key watch + the ponytail compressor
-- ----------------------------------------------------------------------------
--  Two changes, one file.
--
--  1. KEY WATCH MOVES TO THE SERVER.
--     Until now "watch my keys" meant a setInterval in the admin's browser:
--     close the tab and the watching stopped. This adds the state a scheduler
--     needs — an on/off switch, an interval, a batch size, a claim stamp and a
--     run log — so a cron worker can hold the beat with the tab closed, while
--     two workers racing can never double-fire (internal_keywatch_due() takes
--     a row lock and stamps the claim inside the same transaction).
--
--  2. THE PONYTAIL COMPRESSOR.
--     v9 compressors rewrite one message at a time, so a long chat still grows
--     forever. A ponytail reads the conversation as one shape: system prompt
--     and newest turns verbatim, everything older squeezed and tied into a
--     single digest turn.
--
--  Safe to run twice. Nothing here drops data.
--
--      psql "$DATABASE_URL" -f supabase/upgrade-v11.0-keywatch-and-ponytail.sql
-- ============================================================================

begin;

-- ============================================================================
-- 1. SETTINGS — the knobs the scheduler reads
-- ============================================================================

alter table public.app_settings
  add column if not exists keywatch_enabled          boolean     not null default false,
  add column if not exists keywatch_interval_seconds int         not null default 15,
  add column if not exists keywatch_batch_size       int         not null default 25,
  add column if not exists keywatch_active_only      boolean     not null default true,
  add column if not exists keywatch_retention_days   int         not null default 7,
  add column if not exists keywatch_last_run_at      timestamptz,
  add column if not exists keywatch_last_ok_at       timestamptz,
  add column if not exists keywatch_last_error       text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_keywatch_interval_chk') then
    alter table public.app_settings
      add constraint app_settings_keywatch_interval_chk
      check (keywatch_interval_seconds between 5 and 3600);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_keywatch_batch_chk') then
    alter table public.app_settings
      add constraint app_settings_keywatch_batch_chk
      check (keywatch_batch_size between 1 and 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_keywatch_retention_chk') then
    alter table public.app_settings
      add constraint app_settings_keywatch_retention_chk
      check (keywatch_retention_days between 1 and 365);
  end if;
end $$;

-- A scheduled check is not a manual one, and pretending otherwise would make
-- the history unreadable. 'cron' joins the allowed sources.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.upstream_key_checks'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%source%'
  loop
    execute format('alter table public.upstream_key_checks drop constraint %I', c.conname);
  end loop;

  alter table public.upstream_key_checks
    add constraint upstream_key_checks_source_check
    check (source in ('manual', 'auto', 'traffic', 'cron'));
end $$;

-- ============================================================================
-- 2. RUN LOG — receipts for the beat itself, not just for the keys
-- ============================================================================

create table if not exists public.keywatch_runs (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  duration_ms int         not null default 0,
  source      text        not null default 'cron'
              check (source in ('cron', 'manual', 'worker', 'pg_cron', 'unknown')),
  trigger     text,
  checked     int         not null default 0,
  working     int         not null default 0,
  failing     int         not null default 0,
  skipped     boolean     not null default false,
  reason      text,
  error       text
);

create index if not exists keywatch_runs_recent_idx
  on public.keywatch_runs (started_at desc);

alter table public.keywatch_runs enable row level security;

drop policy if exists keywatch_runs_admin on public.keywatch_runs;
create policy keywatch_runs_admin on public.keywatch_runs
  for select to authenticated
  using (public.is_admin());

-- ============================================================================
-- 3. HOUSEKEEPING — a 15 second beat writes ~5,700 rows a day, so prune
-- ============================================================================

create or replace function public.prune_keywatch(p_days int default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days   int;
  v_checks int := 0;
  v_runs   int := 0;
begin
  select greatest(coalesce(p_days, s.keywatch_retention_days, 7), 1)
    into v_days
    from public.app_settings s
   where s.id = 1;

  v_days := coalesce(v_days, greatest(coalesce(p_days, 7), 1));

  delete from public.upstream_key_checks
   where source = 'cron'
     and created_at < now() - make_interval(days => v_days);
  get diagnostics v_checks = row_count;

  delete from public.keywatch_runs
   where started_at < now() - make_interval(days => v_days);
  get diagnostics v_runs = row_count;

  return jsonb_build_object('days', v_days, 'checks_deleted', v_checks, 'runs_deleted', v_runs);
end $$;

-- ============================================================================
-- 4. THE CLAIM — "is a pass due, and may I be the one to run it?"
-- ----------------------------------------------------------------------------
--  `for update` on the singleton settings row is what makes two schedulers
--  safe: the second one blocks, then reads the stamp the first one just wrote
--  and is told the pass is not due. The stamp is written *before* the work, so
--  a worker that dies mid-pass costs one interval, not a stuck lock.
-- ============================================================================

create or replace function public.internal_keywatch_due(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s        record;
  v_gap    numeric;
  v_every  int;
  v_forced boolean := coalesce(p_force, false);
begin
  select * into s from public.app_settings where id = 1 for update;

  if not found then
    return jsonb_build_object('due', false, 'reason', 'app_settings row 1 is missing');
  end if;

  v_every := greatest(coalesce(s.keywatch_interval_seconds, 15), 5);

  if not coalesce(s.keywatch_enabled, false) and not v_forced then
    return jsonb_build_object(
      'due', false,
      'enabled', false,
      'reason', 'key watch is switched off',
      'interval_seconds', v_every,
      'batch_size', coalesce(s.keywatch_batch_size, 25),
      'active_only', coalesce(s.keywatch_active_only, true)
    );
  end if;

  v_gap := extract(epoch from (now() - coalesce(s.keywatch_last_run_at, to_timestamp(0))));

  -- 10% early is still "on time": cron minutes drift, and a pass that is
  -- refused by half a second would halve the effective rate.
  if not v_forced and v_gap < (v_every * 0.9) then
    return jsonb_build_object(
      'due', false,
      'enabled', true,
      'reason', format('next pass in %s s', round(greatest(v_every - v_gap, 0))),
      'interval_seconds', v_every,
      'batch_size', coalesce(s.keywatch_batch_size, 25),
      'active_only', coalesce(s.keywatch_active_only, true)
    );
  end if;

  update public.app_settings set keywatch_last_run_at = now() where id = 1;

  return jsonb_build_object(
    'due', true,
    'enabled', coalesce(s.keywatch_enabled, false),
    'forced', v_forced,
    'interval_seconds', v_every,
    'batch_size', greatest(least(coalesce(s.keywatch_batch_size, 25), 500), 1),
    'active_only', coalesce(s.keywatch_active_only, true),
    'retention_days', greatest(coalesce(s.keywatch_retention_days, 7), 1)
  );
end $$;

-- ============================================================================
-- 5. THE RECEIPT — one row per pass, plus the occasional prune
-- ============================================================================

create or replace function public.internal_keywatch_record_run(
  p_source      text    default 'cron',
  p_trigger     text    default null,
  p_checked     int     default 0,
  p_working     int     default 0,
  p_failing     int     default 0,
  p_duration_ms int     default 0,
  p_skipped     boolean default false,
  p_reason      text    default null,
  p_error       text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid;
  v_days int;
begin
  insert into public.keywatch_runs
    (source, trigger, checked, working, failing, duration_ms, skipped, reason, error, finished_at)
  values (
    case when p_source in ('cron', 'manual', 'worker', 'pg_cron') then p_source else 'unknown' end,
    left(nullif(coalesce(p_trigger, ''), ''), 120),
    greatest(coalesce(p_checked, 0), 0),
    greatest(coalesce(p_working, 0), 0),
    greatest(coalesce(p_failing, 0), 0),
    greatest(coalesce(p_duration_ms, 0), 0),
    coalesce(p_skipped, false),
    left(nullif(coalesce(p_reason, ''), ''), 200),
    left(nullif(coalesce(p_error, ''), ''), 400),
    now()
  )
  returning id into v_id;

  update public.app_settings
     set keywatch_last_run_at = now(),
         keywatch_last_ok_at  = case
                                  when p_error is null and not coalesce(p_skipped, false)
                                  then now() else keywatch_last_ok_at
                                end,
         keywatch_last_error  = left(nullif(coalesce(p_error, ''), ''), 400)
   where id = 1;

  -- Pruning on a timer would need another scheduler. Doing it on roughly one
  -- pass in fifty costs nothing and keeps the history bounded on its own.
  if random() < 0.02 then
    select greatest(coalesce(keywatch_retention_days, 7), 1) into v_days
      from public.app_settings where id = 1;
    perform public.prune_keywatch(v_days);
  end if;

  return v_id;
end $$;

-- ============================================================================
-- 6. ADMIN READ / WRITE — one call for the whole panel
-- ============================================================================

create or replace function public.admin_keywatch_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s       record;
  v_last  jsonb;
  v_by    jsonb;
  v_runs  jsonb;
  v_total int;
  v_live  int;
  v_stale int;
  v_every int;
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;

  select * into s from public.app_settings where id = 1;
  v_every := greatest(coalesce(s.keywatch_interval_seconds, 15), 5);

  select count(*)::int,
         count(*) filter (where is_active)::int,
         count(*) filter (
           where is_active
             and (last_checked_at is null
                  or last_checked_at < now() - make_interval(secs => v_every * 5))
         )::int
    into v_total, v_live, v_stale
    from public.upstream_keys;

  select coalesce(jsonb_object_agg(t.status, t.n), '{}'::jsonb)
    into v_by
    from (
      select status, count(*)::int as n
        from public.upstream_keys
       where is_active
       group by status
    ) t;

  select to_jsonb(r) into v_last
    from (
      select id, started_at, finished_at, duration_ms, source, trigger,
             checked, working, failing, skipped, reason, error
        from public.keywatch_runs
       order by started_at desc
       limit 1
    ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc), '[]'::jsonb)
    into v_runs
    from (
      select id, started_at, duration_ms, source, trigger,
             checked, working, failing, skipped, reason, error
        from public.keywatch_runs
       order by started_at desc
       limit 20
    ) r;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'enabled',          coalesce(s.keywatch_enabled, false),
      'interval_seconds', v_every,
      'batch_size',       coalesce(s.keywatch_batch_size, 25),
      'active_only',      coalesce(s.keywatch_active_only, true),
      'retention_days',   coalesce(s.keywatch_retention_days, 7)
    ),
    'last_run_at', s.keywatch_last_run_at,
    'last_ok_at',  s.keywatch_last_ok_at,
    'last_error',  s.keywatch_last_error,
    'seconds_since_run',
      case when s.keywatch_last_run_at is null then null
           else round(extract(epoch from (now() - s.keywatch_last_run_at)))
      end,
    'stale', (s.keywatch_last_run_at is null
              or s.keywatch_last_run_at < now() - make_interval(secs => v_every * 3)),
    'keys', jsonb_build_object(
      'total', v_total, 'active', v_live, 'stale', v_stale, 'by_status', v_by
    ),
    'last_run', v_last,
    'runs', v_runs,
    'now', now()
  );
end $$;

create or replace function public.admin_save_keywatch_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;

  -- Allow-list, then clamp. A panel typo should never be able to ask for a
  -- one-second beat across 5,000 keys.
  update public.app_settings
     set keywatch_enabled          = coalesce((p->>'enabled')::boolean, keywatch_enabled),
         keywatch_interval_seconds = least(greatest(
                                       coalesce((p->>'interval_seconds')::int,
                                                keywatch_interval_seconds), 5), 3600),
         keywatch_batch_size       = least(greatest(
                                       coalesce((p->>'batch_size')::int,
                                                keywatch_batch_size), 1), 500),
         keywatch_active_only      = coalesce((p->>'active_only')::boolean, keywatch_active_only),
         keywatch_retention_days   = least(greatest(
                                       coalesce((p->>'retention_days')::int,
                                                keywatch_retention_days), 1), 365),
         keywatch_last_error       = case when coalesce((p->>'clear_error')::boolean, false)
                                          then null else keywatch_last_error end,
         updated_at                = now()
   where id = 1;

  return public.admin_keywatch_status();
end $$;

-- ============================================================================
-- 7. THE PONYTAIL COMPRESSOR — new columns on token_compressors
-- ============================================================================

alter table public.token_compressors
  add column if not exists mode          text    not null default 'stages',
  add column if not exists head_messages int     not null default 4,
  add column if not exists keep_system   boolean not null default true,
  add column if not exists tail_chars    int     not null default 700,
  add column if not exists tail_digest   boolean not null default true,
  add column if not exists keep_entities boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'token_compressors_mode_chk') then
    alter table public.token_compressors
      add constraint token_compressors_mode_chk check (mode in ('stages', 'ponytail'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_compressors_ponytail_chk') then
    alter table public.token_compressors
      add constraint token_compressors_ponytail_chk
      check (head_messages between 0 and 50 and tail_chars between 120 and 20000);
  end if;
end $$;

comment on column public.token_compressors.mode is
  'stages = rewrite each message (v9 behaviour); ponytail = keep the head, thin and tie the tail';

-- Seeded switched off: a lossy compressor turns itself on only when an admin
-- has looked at the preview and agreed with what it throws away.
insert into public.token_compressors
  (slug, name, description, mode, stages, scope, min_tokens, max_chars,
   preserve_code, head_messages, keep_system, tail_chars, tail_digest,
   keep_entities, priority, is_active)
values (
  'ponytail',
  'Ponytail',
  'Keeps the system prompt and the last few turns word for word, ties everything older into one compressed digest. Long chats stop growing.',
  'ponytail',
  '{whitespace,markdown,filler,dedupe}',
  'history',
  600,
  8000,
  true,
  4,
  true,
  700,
  true,
  true,
  50,
  false
)
on conflict (slug) do nothing;

-- ============================================================================
-- 8. GRANTS — internals stay internal
-- ============================================================================

revoke execute on function public.internal_keywatch_due(boolean) from anon, authenticated;
revoke execute on function public.internal_keywatch_record_run(text, text, int, int, int, int, boolean, text, text)
  from anon, authenticated;
revoke execute on function public.prune_keywatch(int) from anon, authenticated;

grant execute on function public.internal_keywatch_due(boolean) to service_role;
grant execute on function public.internal_keywatch_record_run(text, text, int, int, int, int, boolean, text, text)
  to service_role;
grant execute on function public.prune_keywatch(int) to service_role;

grant execute on function public.admin_keywatch_status() to authenticated, service_role;
grant execute on function public.admin_save_keywatch_settings(jsonb) to authenticated, service_role;

grant select on public.keywatch_runs to authenticated;

commit;

-- ============================================================================
-- 9. OPTIONAL — run the beat from inside Postgres instead of Cloudflare
-- ----------------------------------------------------------------------------
--  The Cloudflare worker in cloudflare/keywatch-worker.js is the default,
--  because it needs no database extensions. If you would rather keep the
--  schedule in the database, enable pg_cron + pg_net in the Supabase dashboard
--  and run the block below with your own function URL and cron secret.
--
--  create extension if not exists pg_cron;
--  create extension if not exists pg_net;
--
--  create or replace function public.keywatch_schedule(p_url text, p_secret text)
--  returns void language plpgsql security definer set search_path = public as $fn$
--  begin
--    perform cron.unschedule('ragestar-keywatch')
--      where exists (select 1 from cron.job where jobname = 'ragestar-keywatch');
--    perform cron.schedule(
--      'ragestar-keywatch',
--      '* * * * *',
--      format(
--        $q$select net.http_post(
--             url := %L,
--             headers := jsonb_build_object(
--               'content-type', 'application/json',
--               'x-keywatch-secret', %L),
--             body := jsonb_build_object('source','pg_cron','passes',4,'spacing_ms',15000)
--           )$q$, p_url, p_secret));
--  end $fn$;
--
--  select public.keywatch_schedule(
--    'https://<project>.supabase.co/functions/v1/keywatch', '<KEYWATCH_CRON_SECRET>');
-- ============================================================================
