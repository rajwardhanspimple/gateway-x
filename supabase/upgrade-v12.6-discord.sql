-- ============================================================================
-- v12.6 — Discord identities: connect a Discord account, sign in with it,
--         and auto-join the community guild
-- ----------------------------------------------------------------------------
--   · public.discord_identities — one row per account: the Discord user id,
--     username, avatar, whether the guild join succeeded, and when it linked.
--   · RLS: the owner reads and deletes their own row. Inserts and updates are
--     service-role only (the discord-auth Edge Function), so the browser can
--     never mint a link or edit one — the browser is never the security
--     boundary.
--
-- Run after upgrade-v12.5-window-limits.sql. Idempotent — safe to re-run.
-- ============================================================================

begin;

-- 1. the link table ----------------------------------------------------------
--    One Discord account per RageStar account (user_id is the primary key),
--    and one RageStar account per Discord account (discord_id is unique).
create table if not exists public.discord_identities (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  discord_id   text        not null unique,
  username     text        not null default '',
  global_name  text        not null default '',
  avatar       text        not null default '',
  email        text        not null default '',
  guild_member boolean     not null default false,
  connected_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.discord_identities is
  'Discord account linked to each RageStar account. Written only by the discord-auth Edge Function (service role); the owner can read or delete their own row. guild_member records whether the auto-join to the community server succeeded.';

-- 2. row-level security ------------------------------------------------------
--    Read own, delete own. There is deliberately no insert or update policy:
--    every write goes through discord-auth with the service role.
alter table public.discord_identities enable row level security;

drop policy if exists discord_identities_select_own on public.discord_identities;
create policy discord_identities_select_own on public.discord_identities
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists discord_identities_delete_own on public.discord_identities;
create policy discord_identities_delete_own on public.discord_identities
  for delete to authenticated
  using (auth.uid() = user_id);

-- 3. grants ------------------------------------------------------------------
--    RLS alone is not the whole story: strip the broad default grants and hand
--    back exactly the two verbs the console needs.
revoke all on public.discord_identities from anon, authenticated;
grant select, delete on public.discord_identities to authenticated;

commit;

-- ============================================================================
--  VERIFY
-- ============================================================================
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'discord_identities'
--  order by ordinal_position;
--
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'discord_identities';
--
-- -- who is linked so far (service role / SQL editor only)
-- select p.email, d.username, d.guild_member, d.connected_at
--   from public.discord_identities d
--   join public.profiles p on p.id = d.user_id
--  order by d.connected_at desc;

-- ============================================================================
--  ROLLBACK
-- ----------------------------------------------------------------------------
--  Disconnecting stays available while the table exists. To remove the feature
--  entirely: undeploy the discord-auth function, then
--
--    drop table if exists public.discord_identities;
--
--  Accounts created via Discord sign-in keep working: their Firebase account
--  and Supabase profile are ordinary rows, only the Discord link disappears.
-- ============================================================================
