-- ===========================================================================
-- upgrade-v11.5-kie-codex-responses.sql
-- ---------------------------------------------------------------------------
--  Kie has exactly ONE working request shape:
--
--    POST https://api.kie.ai/codex/v1/responses
--    Authorization: Bearer <key>
--    Content-Type: application/json
--    { "model": "gpt-6-astra", "stream": true, "input": …,
--      "tools": [{"type":"web_search"}], "reasoning": {"effort":"high"} }
--
--  So this upgrade:
--    1. retires the 'anthropic' category (its /anthropic/v1/messages shape is
--       not used by the gateway any more) — keys are moved nowhere, the row is
--       simply deleted, which cascades to its keys
--    2. pins the 'codex' row to the canonical endpoint + gpt-6-astra
--    3. locks the category check + endpoint + streaming contract at the
--       database level, so a stale admin panel cannot re-introduce a shape Kie
--       refuses
--    4. re-creates admin_save_kie_provider() so it can no longer change the
--       endpoint, the stream flag, the content type or the delta event type
--
--  Run AFTER upgrade-v11.4-community-and-kie.sql. Safe to run twice.
-- ===========================================================================

begin;

-- 1. retire the second vendor shape -----------------------------------------
delete from public.kie_provider_keys
 where kie_provider_id in (select id from public.kie_providers where category <> 'codex');

delete from public.kie_providers where category <> 'codex';

-- 2. codex row: canonical endpoint, gpt-6-astra, streaming contract ---------
insert into public.kie_providers
  (category, label, endpoint, stream, content_type, delta_event_type,
   default_model, models, is_active, notes)
values
  ('codex', 'Kie - Codex Responses', 'https://api.kie.ai/codex/v1/responses',
   true, 'text/event-stream', 'response.output_text.delta',
   'gpt-6-astra', '{gpt-6-astra}', false,
   'Only shape Kie accepts: {model, stream:true, input, tools?, reasoning?}. '
   || 'Headers: Authorization + Content-Type only. Ends on [DONE].')
on conflict (category) do update set
  label            = 'Kie - Codex Responses',
  endpoint         = 'https://api.kie.ai/codex/v1/responses',
  stream           = true,
  content_type     = 'text/event-stream',
  delta_event_type = 'response.output_text.delta',
  default_model    = coalesce(nullif(btrim(public.kie_providers.default_model), ''), 'gpt-6-astra'),
  models           = case when coalesce(array_length(public.kie_providers.models, 1), 0) = 0
                          then '{gpt-6-astra}'::text[]
                          else public.kie_providers.models end,
  updated_at       = now();

-- make gpt-6-astra always selectable even if a custom list exists
update public.kie_providers
   set models = array(select distinct unnest(models || '{gpt-6-astra}'::text[]))
 where category = 'codex'
   and not ('gpt-6-astra' = any (models));

-- 3. lock the contract in the schema ----------------------------------------
alter table public.kie_providers
  drop constraint if exists kie_providers_category_check;
alter table public.kie_providers
  add constraint kie_providers_category_check check (category = 'codex');

alter table public.kie_providers
  drop constraint if exists kie_providers_endpoint_check;
alter table public.kie_providers
  add constraint kie_providers_endpoint_check
  check (endpoint = 'https://api.kie.ai/codex/v1/responses');

alter table public.kie_providers
  drop constraint if exists kie_providers_stream_check;
alter table public.kie_providers
  add constraint kie_providers_stream_check check (stream = true);

alter table public.kie_providers
  drop constraint if exists kie_providers_delta_check;
alter table public.kie_providers
  add constraint kie_providers_delta_check
  check (delta_event_type = 'response.output_text.delta');

alter table public.kie_providers alter column stream           set default true;
alter table public.kie_providers alter column default_model    set default 'gpt-6-astra';
alter table public.kie_providers alter column content_type     set default 'text/event-stream';
alter table public.kie_providers alter column delta_event_type set default 'response.output_text.delta';

-- extra headers are never forwarded any more: keep the column empty
update public.kie_providers set extra_headers = '{}'::jsonb where extra_headers <> '{}'::jsonb;

-- 4. admin_save_kie_provider(): label / model / models / active / notes only -
create or replace function public.admin_save_kie_provider(p_category text, p_patch jsonb)
returns public.kie_providers
language plpgsql security definer set search_path = public as $$
declare v_row public.kie_providers;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_category is distinct from 'codex' then
    raise exception 'Only the codex Responses category exists (got %)', p_category;
  end if;

  update public.kie_providers set
    label         = coalesce(nullif(btrim(p_patch->>'label'), ''), label),
    default_model = coalesce(nullif(btrim(p_patch->>'default_model'), ''), default_model),
    models        = case when p_patch ? 'models'
                         then coalesce((
                           select array_agg(btrim(x))
                             from jsonb_array_elements_text(p_patch->'models') as t(x)
                            where btrim(x) <> ''
                         ), models)
                         else models end,
    is_active     = coalesce((p_patch->>'is_active')::boolean, is_active),
    notes         = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    /* the contract is not editable */
    endpoint         = 'https://api.kie.ai/codex/v1/responses',
    stream           = true,
    content_type     = 'text/event-stream',
    delta_event_type = 'response.output_text.delta',
    extra_headers    = '{}'::jsonb,
    updated_at       = now()
  where category = 'codex'
  returning * into v_row;

  if not found then
    raise exception 'Kie codex is not seeded';
  end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'save_kie_provider', 'kie_providers', v_row.id::text,
          jsonb_build_object('category', 'codex'));

  return v_row;
end $$;

grant execute on function public.admin_save_kie_provider(text, jsonb) to authenticated;

commit;

-- Verify:
--   select category, endpoint, stream, default_model, models, is_active
--     from public.kie_providers;
