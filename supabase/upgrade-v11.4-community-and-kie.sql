-- ============================================================================
-- upgrade-v11.4-community-and-kie.sql
-- ----------------------------------------------------------------------------
-- Two features in one migration. Safe to run more than once (idempotent).
--
--   1. COMMUNITY CHAT
--      chat_groups + chat_messages, a read-only chat_feed view that hides
--      deleted rows and never exposes emails, and RPCs that own the posting /
--      deleting rules. Default rooms (general, developers, vibecoders, ...) are
--      seeded.
--
--   2. KIE API PROVIDER
--      kie_providers holds two categories (codex / anthropic) with their
--      streaming contract; kie_provider_keys stores the secret keys (revealed
--      only through an audited RPC and shown masked through a view).
--
-- After running this, deploy the edge function:
--      supabase functions deploy kie --no-verify-jwt
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------------
create table if not exists public.chat_groups (
  id          uuid        primary key default gen_random_uuid(),
  slug        text        not null unique,
  name        text        not null,
  description text,
  is_active   boolean     not null default true,
  is_locked   boolean     not null default false,   -- locked = admins post only
  sort_order  int         not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id         uuid        primary key default gen_random_uuid(),
  group_id   uuid        not null references public.chat_groups (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id)    on delete cascade,
  body       text        not null,
  edited_at  timestamptz,
  deleted_at timestamptz,
  deleted_by uuid        references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_group_created_idx
  on public.chat_messages (group_id, created_at);
create index if not exists chat_messages_live_idx
  on public.chat_messages (group_id, created_at) where deleted_at is null;

create table if not exists public.kie_providers (
  id               uuid        primary key default gen_random_uuid(),
  category         text        not null unique check (category in ('anthropic','codex')),
  label            text,
  endpoint         text        not null,
  stream           boolean     not null default true,
  content_type     text        not null default 'text/event-stream',
  delta_event_type text        not null default 'response.output_text.delta',
  default_model    text,
  models           text[]      not null default '{}',
  extra_headers    jsonb       not null default '{}'::jsonb,
  is_active        boolean     not null default false,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.kie_provider_keys (
  id              uuid        primary key default gen_random_uuid(),
  kie_provider_id uuid        not null references public.kie_providers (id) on delete cascade,
  label           text        not null default 'key',
  api_key         text        not null,                              -- SECRET
  key_last4       text        generated always as (right(api_key, 4)) stored,
  is_active       boolean     not null default true,
  status          text        not null default 'unknown'
                  check (status in ('unknown','working','failing','disabled')),
  last_checked_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (kie_provider_id, api_key)
);
create index if not exists kie_provider_keys_lookup_idx
  on public.kie_provider_keys (kie_provider_id, is_active, status);

-- ---------------------------------------------------------------------------
-- 2. SEEDS
-- ---------------------------------------------------------------------------
insert into public.chat_groups (slug, name, description, is_locked, sort_order) values
  ('announcements', 'Announcements', 'News from the RageStar team.',          true,  5),
  ('general',       'General',       'Say hi and talk about anything.',       false, 10),
  ('developers',    'Developers',    'APIs, SDKs and integration talk.',      false, 20),
  ('vibecoders',    'Vibecoders',    'Shipping with AI - prompts and flow.',  false, 30),
  ('design',        'Design',        'UI, UX and product design.',            false, 40),
  ('help',          'Help & Support','Stuck? Ask here.',                      false, 50),
  ('off-topic',     'Off-topic',     'Everything else.',                      false, 60)
on conflict (slug) do nothing;

insert into public.kie_providers
  (category, label, endpoint, delta_event_type, default_model, models, is_active) values
  ('codex', 'Kie - Codex (GPT)', 'https://api.kie.ai/codex/v1/responses',
     'response.output_text.delta', 'gpt-5-codex', '{gpt-5-codex}', false),
  ('anthropic', 'Kie - Anthropic (Claude)', 'https://api.kie.ai/anthropic/v1/messages',
     'content_block_delta', 'claude-sonnet-4', '{claude-sonnet-4}', false)
on conflict (category) do nothing;

-- ---------------------------------------------------------------------------
-- 3. updated_at triggers  (touch_updated_at() already exists in schema.sql;
--    re-created here so this upgrade is self-contained)
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists chat_groups_touch on public.chat_groups;
create trigger chat_groups_touch before update on public.chat_groups
  for each row execute function public.touch_updated_at();

drop trigger if exists kie_providers_touch on public.kie_providers;
create trigger kie_providers_touch before update on public.kie_providers
  for each row execute function public.touch_updated_at();

drop trigger if exists kie_provider_keys_touch on public.kie_provider_keys;
create trigger kie_provider_keys_touch before update on public.kie_provider_keys
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. VIEWS
-- ---------------------------------------------------------------------------
-- Read model for the chat. Hides deleted rows, resolves a display name from
-- the profile (never the email), and flags the caller's own messages.
drop view if exists public.chat_feed cascade;
create view public.chat_feed as
select m.id,
       m.group_id,
       g.slug                                                     as group_slug,
       m.user_id,
       coalesce(nullif(btrim(p.full_name), ''),
                split_part(p.email, '@', 1))                      as author_name,
       p.role                                                     as author_role,
       m.body,
       m.created_at,
       m.edited_at,
       (m.user_id = auth.uid())                                   as is_mine
from public.chat_messages m
join public.chat_groups   g on g.id = m.group_id
join public.profiles      p on p.id = m.user_id
where m.deleted_at is null
  and auth.uid() is not null
order by m.created_at;

-- Admin view of Kie keys: masked by default, full value only via
-- admin_reveal_kie_key(). Row filter = caller must be an admin.
drop view if exists public.admin_kie_provider_keys cascade;
create view public.admin_kie_provider_keys as
select k.id,
       k.kie_provider_id,
       pr.category,
       pr.label                       as provider_label,
       k.label,
       ('••••••••' || k.key_last4)    as masked_key,
       length(k.api_key)              as key_length,
       k.is_active,
       k.status,
       k.last_checked_at,
       k.last_error,
       k.created_at
from public.kie_provider_keys k
join public.kie_providers pr on pr.id = k.kie_provider_id
where public.is_admin()
order by pr.category, k.created_at desc;

-- ---------------------------------------------------------------------------
-- 5. RPCs  (all SECURITY DEFINER - the rules live here, not in the client)
-- ---------------------------------------------------------------------------
create or replace function public.post_chat_message(p_group_slug text, p_body text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_group public.chat_groups;
  v_body  text := btrim(coalesce(p_body, ''));
  v_id    uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to post' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles
                  where id = auth.uid() and status = 'active') then
    raise exception 'Your account cannot post right now' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'Message is empty';
  end if;
  if length(v_body) > 4000 then
    raise exception 'Message is too long (4000 character max)';
  end if;

  select * into v_group from public.chat_groups where slug = p_group_slug;
  if not found then
    raise exception 'Unknown group %', p_group_slug;
  end if;
  if not v_group.is_active then
    raise exception 'That group is closed';
  end if;
  if v_group.is_locked and not public.is_admin() then
    raise exception 'Only admins can post in %', v_group.name using errcode = '42501';
  end if;

  insert into public.chat_messages (group_id, user_id, body)
  values (v_group.id, auth.uid(), v_body)
  returning id into v_id;

  return v_id;
end $$;

create or replace function public.delete_chat_message(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select user_id into v_owner
    from public.chat_messages
   where id = p_id and deleted_at is null;
  if v_owner is null then
    return;                        -- already gone / not found: no-op
  end if;
  if v_owner <> auth.uid() and not public.is_admin() then
    raise exception 'You can only delete your own messages' using errcode = '42501';
  end if;

  update public.chat_messages
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_id;
end $$;

create or replace function public.admin_save_chat_group(p_patch jsonb)
returns public.chat_groups
language plpgsql security definer set search_path = public as $$
declare
  v_slug text := btrim(coalesce(p_patch->>'slug', ''));
  v_row  public.chat_groups;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if v_slug = '' then
    raise exception 'A group slug is required';
  end if;

  insert into public.chat_groups (slug, name, description, is_active, is_locked, sort_order)
  values (
    v_slug,
    coalesce(nullif(btrim(p_patch->>'name'), ''), initcap(v_slug)),
    p_patch->>'description',
    coalesce((p_patch->>'is_active')::boolean, true),
    coalesce((p_patch->>'is_locked')::boolean, false),
    coalesce((p_patch->>'sort_order')::int, 100)
  )
  on conflict (slug) do update set
    name        = coalesce(nullif(btrim(p_patch->>'name'), ''), chat_groups.name),
    description = case when p_patch ? 'description' then p_patch->>'description'
                      else chat_groups.description end,
    is_active   = coalesce((p_patch->>'is_active')::boolean, chat_groups.is_active),
    is_locked   = coalesce((p_patch->>'is_locked')::boolean, chat_groups.is_locked),
    sort_order  = coalesce((p_patch->>'sort_order')::int, chat_groups.sort_order),
    updated_at  = now()
  returning * into v_row;

  return v_row;
end $$;

create or replace function public.admin_save_kie_provider(p_category text, p_patch jsonb)
returns public.kie_providers
language plpgsql security definer set search_path = public as $$
declare v_row public.kie_providers;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_category not in ('anthropic','codex') then
    raise exception 'Unknown Kie category %', p_category;
  end if;

  update public.kie_providers set
    label            = coalesce(nullif(btrim(p_patch->>'label'), ''), label),
    endpoint         = coalesce(nullif(btrim(p_patch->>'endpoint'), ''), endpoint),
    stream           = coalesce((p_patch->>'stream')::boolean, stream),
    content_type     = coalesce(nullif(btrim(p_patch->>'content_type'), ''), content_type),
    delta_event_type = coalesce(nullif(btrim(p_patch->>'delta_event_type'), ''), delta_event_type),
    default_model    = coalesce(nullif(btrim(p_patch->>'default_model'), ''), default_model),
    models           = case when p_patch ? 'models'
                            then coalesce((
                              select array_agg(btrim(x))
                                from jsonb_array_elements_text(p_patch->'models') as t(x)
                               where btrim(x) <> ''
                            ), models)
                            else models end,
    extra_headers    = case when p_patch ? 'extra_headers'
                            then coalesce(p_patch->'extra_headers', extra_headers)
                            else extra_headers end,
    is_active        = coalesce((p_patch->>'is_active')::boolean, is_active),
    notes            = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    updated_at       = now()
  where category = p_category
  returning * into v_row;

  if not found then
    raise exception 'Kie category % is not seeded', p_category;
  end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'save_kie_provider', 'kie_providers', v_row.id::text,
          jsonb_build_object('category', p_category));

  return v_row;
end $$;

create or replace function public.admin_reveal_kie_key(p_key_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select api_key into v_key from public.kie_provider_keys where id = p_key_id;
  if v_key is null then
    raise exception 'Key not found';
  end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'reveal_kie_key', 'kie_provider_keys', p_key_id::text);

  return v_key;
end $$;

-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
alter table public.chat_groups       enable row level security;
alter table public.chat_messages     enable row level security;
alter table public.kie_providers     enable row level security;
alter table public.kie_provider_keys enable row level security;

-- chat_groups: signed-in members see active rooms; admins see/do everything
drop policy if exists chat_groups_read  on public.chat_groups;
create policy chat_groups_read on public.chat_groups
  for select to authenticated
  using (is_active or public.is_admin());

drop policy if exists chat_groups_admin on public.chat_groups;
create policy chat_groups_admin on public.chat_groups
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- chat_messages: read live messages; writes normally go through the RPCs, but
-- these policies keep any direct access honest too
drop policy if exists chat_messages_read on public.chat_messages;
create policy chat_messages_read on public.chat_messages
  for select to authenticated
  using (deleted_at is null or public.is_admin());

drop policy if exists chat_messages_insert on public.chat_messages;
create policy chat_messages_insert on public.chat_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.chat_groups g
       where g.id = group_id and g.is_active
         and (not g.is_locked or public.is_admin())
    )
  );

drop policy if exists chat_messages_update on public.chat_messages;
create policy chat_messages_update on public.chat_messages
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists chat_messages_admin on public.chat_messages;
create policy chat_messages_admin on public.chat_messages
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- kie_* : admin-only, always
drop policy if exists kie_providers_admin on public.kie_providers;
create policy kie_providers_admin on public.kie_providers
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists kie_provider_keys_admin on public.kie_provider_keys;
create policy kie_provider_keys_admin on public.kie_provider_keys
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. GRANTS
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.chat_groups       to authenticated;
grant select, insert, update, delete on public.chat_messages     to authenticated;
grant select, insert, update, delete on public.kie_providers     to authenticated;
grant select, insert, update, delete on public.kie_provider_keys to authenticated;
grant select on public.chat_feed                to authenticated;
grant select on public.admin_kie_provider_keys  to authenticated;

grant all on public.chat_groups       to service_role;
grant all on public.chat_messages     to service_role;
grant all on public.kie_providers     to service_role;
grant all on public.kie_provider_keys to service_role;

grant execute on function public.post_chat_message(text, text)        to authenticated;
grant execute on function public.delete_chat_message(uuid)            to authenticated;
grant execute on function public.admin_save_chat_group(jsonb)         to authenticated;
grant execute on function public.admin_save_kie_provider(text, jsonb) to authenticated;
grant execute on function public.admin_reveal_kie_key(uuid)           to authenticated;

-- done.
