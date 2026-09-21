-- ============================================================================
--  RageStar v9.0 — token compressors
--  Run this whole file in the Supabase SQL editor. Idempotent: safe to re-run.
--
--  Adds
--    1. public.token_compressors  — many named compressors, priority ordered
--    2. RLS: admins manage them, the service role (router) reads them
--    3. app_settings.compression_enabled — one master switch
--    4. request_logs.tokens_saved       — what the compressors removed
--    5. internal_active_compressors()   — what the router calls per request
--
--  A compressor is a *stack of deterministic text stages*, not a model call.
--  Stage ids must match src/lib/compress.js:
--    whitespace, markdown, html, json, dedupe, filler, shorthand, stopwords,
--    vowels, middleout
-- ============================================================================

-- ------------------------------------------------------------------- table --
create table if not exists public.token_compressors (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  slug          text        not null unique,
  description   text,
  stages        text[]      not null default '{whitespace}',
  scope         text        not null default 'all',
  min_tokens    int         not null default 0,
  max_chars     int         not null default 6000,
  preserve_code boolean     not null default true,
  priority      int         not null default 100,
  is_active     boolean     not null default true,
  model_ids     text[]      not null default '{}',   -- empty = every model
  created_by    uuid        references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'token_compressors_scope_chk') then
    alter table public.token_compressors
      add constraint token_compressors_scope_chk
      check (scope in ('all', 'user', 'system', 'history'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_compressors_floor_chk') then
    alter table public.token_compressors
      add constraint token_compressors_floor_chk
      check (min_tokens >= 0 and max_chars between 120 and 200000);
  end if;
end $$;

create index if not exists token_compressors_order_idx
  on public.token_compressors (is_active, priority, created_at);

comment on table public.token_compressors is
  'Named prompt compressors. Every enabled row runs in priority order before a request is forwarded upstream.';
comment on column public.token_compressors.stages is
  'Ordered stage ids from src/lib/compress.js. Unknown ids are ignored by the router.';
comment on column public.token_compressors.scope is
  'all | user | system | history (history = every message except the last).';
comment on column public.token_compressors.min_tokens is
  'Prompts smaller than this are left alone — rewriting them is not worth the risk.';
comment on column public.token_compressors.model_ids is
  'Public model ids this compressor applies to. Empty array means every model.';

-- --------------------------------------------------------- updated_at hook --
create or replace function public.touch_token_compressor()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists token_compressors_touch on public.token_compressors;
create trigger token_compressors_touch
  before update on public.token_compressors
  for each row execute function public.touch_token_compressor();

-- --------------------------------------------------------------------- RLS --
alter table public.token_compressors enable row level security;

drop policy if exists token_compressors_admin_all on public.token_compressors;
create policy token_compressors_admin_all
  on public.token_compressors
  for all
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- ---------------------------------------------------------------- settings --
alter table public.app_settings
  add column if not exists compression_enabled boolean not null default true;

comment on column public.app_settings.compression_enabled is
  'Master switch. When false the router forwards every prompt untouched, whatever the compressor rows say.';

-- ------------------------------------------------------------------ logging --
alter table public.request_logs
  add column if not exists tokens_saved       int  not null default 0,
  add column if not exists compressors_applied text[] not null default '{}';

comment on column public.request_logs.tokens_saved is
  'Estimated prompt tokens removed by the compressor stack for this request.';

-- --------------------------------------------------- router-side read path --
create or replace function public.internal_active_compressors(p_model text default null)
returns setof public.token_compressors
language sql
security definer
set search_path = public
as $$
  select *
  from public.token_compressors c
  where c.is_active
    and (
      coalesce(array_length(c.model_ids, 1), 0) = 0
      or p_model is null
      or p_model = any (c.model_ids)
    )
    and (select coalesce(compression_enabled, true) from public.app_settings where id = 1)
  order by c.priority asc, c.created_at asc;
$$;

revoke all on function public.internal_active_compressors(text) from public, anon, authenticated;
grant execute on function public.internal_active_compressors(text) to service_role;

-- ----------------------------------------------------------------- seeding --
--  Four compressors, two of them on: a lossless tidy pass for everything and
--  a tighter diet for user messages. The aggressive pair ships disabled.
insert into public.token_compressors
  (name, slug, description, stages, scope, min_tokens, max_chars, preserve_code, priority, is_active)
values
  ('Tidy (lossless)', 'tidy',
   'Whitespace, markdown decoration and duplicate lines. Safe for every prompt.',
   '{whitespace,markdown,dedupe}', 'all', 0, 8000, true, 10, true),
  ('Prompt diet', 'prompt-diet',
   'Adds filler removal and the abbreviation dictionary. Good default for chat.',
   '{whitespace,markdown,filler,shorthand,dedupe}', 'user', 120, 8000, true, 20, true),
  ('History squeeze', 'history-squeeze',
   'Only rewrites older turns, and truncates them middle-out past the budget.',
   '{whitespace,filler,stopwords,middleout}', 'history', 400, 3000, true, 30, false),
  ('JSON slim', 'json-slim',
   'For tool output and pasted payloads: minifies JSON, strips HTML.',
   '{json,html,whitespace}', 'all', 200, 12000, false, 40, false)
on conflict (slug) do nothing;

-- ------------------------------------------------------------------ audit --
insert into public.audit_logs (actor_email, action, target, detail)
values (null, 'schema.upgrade', 'token_compressors', 'v9.0 token compressors installed')
on conflict do nothing;

-- ------------------------------------------------- log what was compressed --
--  internal_log_request() is replaced rather than patched: the original body
--  is unchanged apart from the two new columns, so re-running this file simply
--  re-installs the same function.
create or replace function public.internal_log_request(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.request_logs (
    request_id, user_id, api_key_id, model_public_id, policy,
    upstream_id, upstream_key_id, ok, status_code, latency_ms,
    tokens_in, tokens_out, cost_usd, failover_count, streamed,
    error_code, error_message, tokens_saved, compressors_applied
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
    )
  )
  returning id into v_id;

  update public.api_keys
     set request_count = request_count + 1,
         last_used_at  = now(),
         spend_usd     = spend_usd + coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0)
   where id = nullif(p_payload ->> 'api_key_id', '')::uuid;

  return v_id;
end $$;

revoke execute on function public.internal_log_request(jsonb) from anon, authenticated;
grant  execute on function public.internal_log_request(jsonb) to service_role;

-- ------------------------------------------------------------------ done ----
--  After this file runs:
--    · Admin → Token compressors lists the four seeded compressors
--    · the router calls internal_active_compressors() on every chat request
--    · responses carry x-rs-tokens-saved and x-rs-compressors
--    · request_logs.tokens_saved records the saving per request
