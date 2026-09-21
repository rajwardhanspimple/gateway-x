-- ============================================================================
--  upgrade-v11.6-kie-original.sql   (KIE ORIGINAL)
--
--  1. a key pasted in Admin -> KIE ORIGINAL is mirrored into a hidden routable
--     upstream called "KIE ORIGINAL" (https://api.kie.ai, /codex/v1/responses)
--  2. its models are published into Model mapping automatically; the default
--     model becomes the catch-all and carries the model ids Claude Code, Codex
--     and other harnesses hard-code -- no Anthropic provider, no second key
--  3. every request records the dialect it spoke and the harness it came from,
--     so usage can be shown as a spreadsheet
--
--  Safe to run more than once.
-- ============================================================================

begin;

-- 1. columns -----------------------------------------------------------------
alter table public.upstreams
  add column if not exists wire_format text not null default 'openai',
  add column if not exists kie_provider_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'upstreams_wire_format_check') then
    alter table public.upstreams add constraint upstreams_wire_format_check
      check (wire_format in ('openai', 'kie_responses'));
  end if;
end $$;

alter table public.upstream_keys add column if not exists kie_provider_key_id uuid;

alter table public.models
  add column if not exists aliases text[] not null default '{}',
  add column if not exists is_catch_all boolean not null default false;

alter table public.request_logs
  add column if not exists dialect text,
  add column if not exists harness text;

create unique index if not exists upstream_keys_kie_mirror_idx
  on public.upstream_keys (kie_provider_key_id) where kie_provider_key_id is not null;
create unique index if not exists models_one_catch_all_idx
  on public.models ((is_catch_all)) where is_catch_all;
create index if not exists models_aliases_idx on public.models using gin (aliases);
create index if not exists request_logs_dialect_idx
  on public.request_logs (dialect, created_at desc);

-- 2. naming ------------------------------------------------------------------
create or replace function public.internal_kie_slug(p_model text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p_model, '')), '[^a-z0-9]+', '-', 'g'), '-'), '')
$$;

create or replace function public.internal_kie_public_id(p_model text, p_is_default boolean)
returns text language sql immutable as $$
  select case when p_is_default then 'kie-original'
              else 'kie-' || coalesce(public.internal_kie_slug(p_model), 'model') end
$$;

--  The ids harnesses hard-code: Claude Code asks for a Claude model, Codex for
--  a GPT one. Both should land on KIE ORIGINAL.
create or replace function public.internal_kie_aliases(p_model text)
returns text[] language sql immutable as $$
  select array(
    select distinct a from unnest(array[
      'kie', 'kie-original', 'kie_original', 'kieoriginal',
      lower(coalesce(p_model, '')), public.internal_kie_slug(p_model),
      'claude', 'claude-3-5-sonnet', 'claude-3-5-sonnet-latest',
      'claude-3-5-haiku', 'claude-3-5-haiku-latest',
      'claude-3-7-sonnet', 'claude-3-7-sonnet-latest',
      'claude-sonnet-4', 'claude-sonnet-4-0', 'claude-sonnet-4-5',
      'claude-haiku-4-5', 'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-5',
      'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini',
      'gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'gpt-6', 'gpt-6-astra',
      'o3', 'o3-mini', 'o4-mini', 'codex-mini-latest'
    ]) a
    where a is not null and btrim(a) <> ''
  )
$$;

-- 3. the hidden upstream -----------------------------------------------------
create or replace function public.internal_kie_upstream_id()
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_prov uuid;
begin
  select id into v_prov from public.kie_providers where category = 'codex';

  select id into v_id from public.upstreams where slug = 'kie-original';
  if v_id is null then
    select id into v_id from public.upstreams
     where base_url ilike '%api.kie.ai%' order by created_at limit 1;
  end if;

  if v_id is null then
    insert into public.upstreams (
      name, slug, base_url, chat_path, models_path, health_path,
      auth_scheme, auth_header, extra_headers, is_active, priority, timeout_ms,
      notes, wire_format, kie_provider_id
    ) values (
      'KIE ORIGINAL', 'kie-original', 'https://api.kie.ai', '/codex/v1/responses',
      null, null, 'bearer', 'Authorization', '{}'::jsonb, true, 10, 180000,
      'Managed by Admin -> KIE ORIGINAL. One shape only: POST /codex/v1/responses.',
      'kie_responses', v_prov
    ) returning id into v_id;
  else
    update public.upstreams set
      name = 'KIE ORIGINAL', slug = 'kie-original',
      base_url = 'https://api.kie.ai', chat_path = '/codex/v1/responses',
      models_path = null,   -- KIE has no GET /models
      health_path = null,   -- and no health path
      auth_scheme = 'bearer', auth_header = 'Authorization',
      wire_format = 'kie_responses',
      kie_provider_id = coalesce(v_prov, kie_provider_id),
      timeout_ms = greatest(coalesce(timeout_ms, 0), 180000),
      is_active = true, updated_at = now()
    where id = v_id;
  end if;

  return v_id;
end $$;

-- 4. model mapping -----------------------------------------------------------
create or replace function public.internal_sync_kie_models()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_prov record; v_up uuid; v_default text; v_model text; v_pub text;
  v_is_def boolean; v_has_keys boolean; v_published text[] := '{}';
begin
  select * into v_prov from public.kie_providers where category = 'codex';
  if not found then return 0; end if;

  v_up := public.internal_kie_upstream_id();
  v_default := coalesce(nullif(btrim(coalesce(v_prov.default_model, '')), ''), 'gpt-6-astra');

  select exists (
    select 1 from public.upstream_keys
     where upstream_id = v_up and is_active and status in ('working','unknown','rate_limited')
  ) into v_has_keys;

  -- only one row may hold the flag, so clear it before handing it out again
  update public.models set is_catch_all = false where is_catch_all;

  for v_model in
    select distinct x
      from unnest(array_append(coalesce(v_prov.models, '{}'::text[]), v_default)) x
     where nullif(btrim(coalesce(x, '')), '') is not null
  loop
    v_is_def := lower(btrim(v_model)) = lower(v_default);
    v_pub := public.internal_kie_public_id(v_model, v_is_def);

    insert into public.models (
      public_id, display_name, upstream_id, upstream_model_id, description,
      context_window, max_output_tokens, price_in_per_m, price_out_per_m,
      status, is_active, sort_order, aliases, is_catch_all
    ) values (
      v_pub,
      case when v_is_def then 'KIE ORIGINAL' else 'KIE ORIGINAL - ' || btrim(v_model) end,
      v_up, btrim(v_model),
      'Served by KIE ORIGINAL over codex /responses. Answers the chat, messages, responses and completions dialects.',
      200000, 64000, 0, 0, 'active',
      (coalesce(v_prov.is_active, false) and v_has_keys), 10,
      case when v_is_def then public.internal_kie_aliases(v_model)
           else array[lower(btrim(v_model))]::text[] end,
      v_is_def
    )
    on conflict (public_id) do update set
      display_name      = excluded.display_name,
      upstream_id       = excluded.upstream_id,
      upstream_model_id = excluded.upstream_model_id,
      description       = excluded.description,
      aliases           = excluded.aliases,
      is_catch_all      = excluded.is_catch_all,
      is_active         = excluded.is_active,
      status            = case when models.status = 'disabled' then 'active' else models.status end,
      updated_at        = now();

    v_published := array_append(v_published, v_pub);
  end loop;

  update public.models
     set is_active = false, is_catch_all = false, updated_at = now()
   where upstream_id = v_up and not (public_id = any (v_published));

  return coalesce(array_length(v_published, 1), 0);
end $$;

-- 5. key mirroring: a pasted key becomes a routable key ----------------------
create or replace function public.internal_sync_kie_key(p_key_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare k record; v_up uuid; v_mirror uuid; v_status text;
begin
  select pk.id, pk.api_key, pk.is_active, pk.status, p.category into k
    from public.kie_provider_keys pk
    join public.kie_providers p on p.id = pk.kie_provider_id
   where pk.id = p_key_id;
  if not found or k.category <> 'codex' then return null; end if;

  v_up := public.internal_kie_upstream_id();
  v_status := case k.status when 'working' then 'working'
                            when 'failing' then 'failing'
                            when 'disabled' then 'disabled'
                            else 'unknown' end;

  select id into v_mirror from public.upstream_keys where kie_provider_key_id = k.id;
  if v_mirror is null then
    -- upstream_keys is unique (upstream_id, api_key): claim the existing row
    select id into v_mirror from public.upstream_keys
     where upstream_id = v_up and api_key = k.api_key;
  end if;

  if v_mirror is null then
    insert into public.upstream_keys (
      upstream_id, label, api_key, is_active, status, notes, kie_provider_key_id
    ) values (
      v_up, 'KIE ORIGINAL key', k.api_key, coalesce(k.is_active, true), v_status,
      'Mirrored from KIE ORIGINAL', k.id
    ) returning id into v_mirror;
  else
    update public.upstream_keys set
      upstream_id = v_up, label = 'KIE ORIGINAL key', api_key = k.api_key,
      is_active = coalesce(k.is_active, true), status = v_status,
      kie_provider_key_id = k.id,
      notes = coalesce(notes, 'Mirrored from KIE ORIGINAL'), updated_at = now()
    where id = v_mirror;
  end if;

  perform public.internal_sync_kie_models();
  return v_mirror;
end $$;

create or replace function public.internal_kie_key_mirror()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from public.upstream_keys where kie_provider_key_id = old.id;
    perform public.internal_sync_kie_models();
    return old;
  end if;
  perform public.internal_sync_kie_key(new.id);
  return new;
end $$;

drop trigger if exists trg_kie_key_mirror on public.kie_provider_keys;
create trigger trg_kie_key_mirror
  after insert or update of api_key, is_active, status or delete
  on public.kie_provider_keys
  for each row execute function public.internal_kie_key_mirror();

--  The router marks the mirrored key working/failing; reflect it back so the
--  panel tells the truth. pg_trigger_depth() stops the ping-pong.
create or replace function public.internal_kie_key_backsync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kie_provider_key_id is null or pg_trigger_depth() > 1 then return new; end if;
  update public.kie_provider_keys set
    status = case new.status when 'working' then 'working'
                             when 'disabled' then 'disabled'
                             when 'unknown' then 'unknown'
                             else 'failing' end,
    last_checked_at = coalesce(new.last_checked_at, now()),
    last_error = new.last_error, updated_at = now()
  where id = new.kie_provider_key_id;
  return new;
end $$;

drop trigger if exists trg_kie_key_backsync on public.upstream_keys;
create trigger trg_kie_key_backsync
  after update of status, last_error, last_checked_at on public.upstream_keys
  for each row execute function public.internal_kie_key_backsync();

create or replace function public.internal_kie_provider_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.category = 'codex' then perform public.internal_sync_kie_models(); end if;
  return new;
end $$;

drop trigger if exists trg_kie_provider_sync on public.kie_providers;
create trigger trg_kie_provider_sync
  after insert or update of default_model, models, is_active, endpoint
  on public.kie_providers
  for each row execute function public.internal_kie_provider_sync();

-- 6. alias + catch-all routing -----------------------------------------------
--    internal_resolve_route() is untouched: the requested id is translated
--    before it runs, so a model id a harness hard-codes still resolves.
create or replace function public.internal_kie_resolve_alias(p_model text)
returns text language sql stable security definer set search_path = public as $$
  with want as (select lower(coalesce(nullif(btrim(p_model), ''), 'auto')) as m)
  select coalesce(
    (select m from want where m in ('auto','auto:balanced','auto:cheapest','auto:fastest')),
    (select mo.public_id from public.models mo, want w
      where lower(mo.public_id) = w.m and mo.is_active limit 1),
    (select mo.public_id from public.models mo, want w
      where mo.is_active and w.m = any (select lower(a) from unnest(mo.aliases) a)
      order by mo.is_catch_all desc, mo.sort_order asc limit 1),
    (select mo.public_id from public.models mo where mo.is_catch_all and mo.is_active limit 1),
    (select m from want)
  )
$$;

create or replace function public.internal_route_candidates(p_model text)
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
  base as (
    select r.*, w.m
      from public.internal_resolve_route(public.internal_kie_resolve_alias(p_model)) r,
           want w
  )
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
    case when m in ('auto','auto:balanced','auto:fastest') then priority end asc nulls last,
    case when m = 'auto:fastest' then coalesce((
           select avg(l.latency_ms) from public.request_logs l
            where l.model_public_id = base.public_id
              and l.ok and l.created_at > now() - interval '1 day'), 99999) end asc nulls last,
    (price_in_per_m + price_out_per_m) asc,
    public_id asc;
$$;

-- 7. logging: remember the dialect and the harness ---------------------------
create or replace function public.internal_log_request(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.request_logs (
    request_id, user_id, api_key_id, model_public_id, policy,
    upstream_id, upstream_key_id, ok, status_code, latency_ms,
    tokens_in, tokens_out, cost_usd, failover_count, streamed,
    error_code, error_message, tokens_saved, compressors_applied,
    dialect, harness
  ) values (
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
    ),
    nullif(p_payload ->> 'dialect', ''),
    nullif(p_payload ->> 'harness', '')
  ) returning id into v_id;

  update public.api_keys
     set request_count = request_count + 1,
         last_used_at  = now(),
         spend_usd     = spend_usd + coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0)
   where id = nullif(p_payload ->> 'api_key_id', '')::uuid;

  return v_id;
end $$;

revoke execute on function public.internal_log_request(jsonb) from anon, authenticated;
grant execute on function public.internal_log_request(jsonb) to service_role;

-- 8. model mapping as a sheet (admin only) -----------------------------------
drop view if exists public.admin_kie_model_map cascade;
create view public.admin_kie_model_map as
select
  m.public_id,
  m.display_name,
  m.upstream_model_id,
  u.name as provider,
  m.is_catch_all,
  array_to_string(m.aliases, ', ') as aliases,
  coalesce(array_length(m.aliases, 1), 0) as alias_count,
  m.status,
  m.is_active,
  (select count(*)::int from public.upstream_keys k where k.upstream_id = u.id) as keys_total,
  (select count(*)::int from public.upstream_keys k
    where k.upstream_id = u.id and k.is_active
      and k.status in ('working','unknown','rate_limited')) as keys_usable,
  m.context_window,
  m.max_output_tokens,
  m.price_in_per_m,
  m.price_out_per_m,
  m.updated_at
from public.models m
join public.upstreams u on u.id = m.upstream_id
where u.wire_format = 'kie_responses'
  and public.is_admin();

grant select on public.admin_kie_model_map to authenticated;

-- 9. usage as a sheet --------------------------------------------------------
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
    and l.created_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  order by l.created_at desc
  limit least(greatest(coalesce(p_limit, 2000), 1), 5000)
$$;

grant execute on function public.my_usage_sheet(int, int) to authenticated;

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
    where l.created_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
      and (not coalesce(p_kie_only, false) or u.wire_format = 'kie_responses')
    order by l.created_at desc
    limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
end $$;

grant execute on function public.admin_usage_sheet(int, int, boolean) to authenticated;

-- 10. the "Sync models" button ----------------------------------------------
create or replace function public.admin_sync_kie_models()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_count int;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;

  for r in select id from public.kie_provider_keys loop
    perform public.internal_sync_kie_key(r.id);
  end loop;

  v_count := public.internal_sync_kie_models();

  begin
    insert into public.audit_logs (actor_id, actor_email, action, entity, detail)
    values (auth.uid(),
            (select email from public.profiles where id = auth.uid()),
            'sync_kie_models', 'models',
            jsonb_build_object('models', v_count));
  exception when others then
    null;   -- an audit row must never fail the sync
  end;

  return jsonb_build_object('models', v_count, 'provider', 'KIE ORIGINAL');
end $$;

grant execute on function public.admin_sync_kie_models() to authenticated;

revoke execute on function public.internal_sync_kie_key(uuid) from anon, authenticated;
revoke execute on function public.internal_sync_kie_models() from anon, authenticated;
revoke execute on function public.internal_kie_upstream_id() from anon, authenticated;
grant execute on function public.internal_sync_kie_key(uuid) to service_role;
grant execute on function public.internal_sync_kie_models() to service_role;
grant execute on function public.internal_kie_upstream_id() to service_role;

-- 11. backfill: keys pasted before this upgrade ------------------------------
do $$
declare r record; v int;
begin
  if exists (select 1 from public.kie_providers where category = 'codex') then
    for r in select id from public.kie_provider_keys loop
      perform public.internal_sync_kie_key(r.id);
    end loop;
    v := public.internal_sync_kie_models();
    raise notice 'KIE ORIGINAL: % model(s) published into model mapping', v;
  end if;
end $$;

insert into public.audit_logs (action, entity, detail)
values ('schema.upgrade', 'kie_original',
        jsonb_build_object('version', '11.6', 'provider', 'KIE ORIGINAL'));

commit;

-- ============================================================================
--  After this runs:
--    Admin -> KIE ORIGINAL   keys, the models they publish, and usage, as sheets
--    Model mapping           kie-original (catch-all) plus one row per model
--    /v1/chat/completions    SDKs, Cursor, Cline, Roo, Aider, Open WebUI
--    /v1/messages            Claude Code
--    /v1/responses           Codex CLI
--    Console -> Usage        a spreadsheet, with dialect and harness per row
-- ============================================================================
