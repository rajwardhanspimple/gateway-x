-- ============================================================================
--  RageStar — upgrade to v12.12
--  Paste this whole file into the Supabase SQL editor and press Run.
--
--  WHAT THIS DOES
--   1. Switches the Discord gate ON: an account must have a linked Discord
--      that is in the community server before the router will serve its keys.
--   2. Makes ON the default for new installs.
--   3. Repoints the refusal text at a screen that exists.
--
--  WHY IT IS A SEPARATE FILE
--     upgrade-v12.9-discord-gate.sql built the gate but deliberately shipped
--     it OFF, because flipping it on before accounts have linked would 403
--     every existing key. Read the note below before running this.
--
--  ---------------------------------------------------------------------------
--  BEFORE YOU RUN THIS — READ
--  ---------------------------------------------------------------------------
--  Every account that has NOT linked a Discord that is in the community server
--  will stop being able to call the API immediately (the router answers 403
--  discord_not_linked / discord_not_in_server). Keys are not deleted and
--  nothing is billed while blocked, but the traffic does stop.
--
--  The compliant path is: dashboard → Settings → Discord → "Connect Discord",
--  then join the community server. That card is live on the settings screen
--  (src/ragestar/dashboard/DiscordPanel.jsx). The old Profile tab it used to
--  live on was retired with #/console in v12.8 and is no longer routed, which
--  is why (3) below changes the wording.
--
--  Prerequisites: upgrade-v12.6-discord.sql and
--                 upgrade-v12.7-announcements-discord-credit.sql have run, and
--                 the discord-auth function is deployed with its secrets.
--  Idempotent: re-running changes nothing.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. the switch, on
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.app_settings') is null then
    raise exception 'app_settings is missing — run the base schema first.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'app_settings'
       and column_name = 'discord_required'
  ) then
    raise exception 'app_settings.discord_required is missing — run supabase/upgrade-v12.9-discord-gate.sql first.';
  end if;
end $$;

update public.app_settings set discord_required = true where id = 1;

-- Fresh installs get the same policy without anyone having to remember.
alter table public.app_settings alter column discord_required set default true;

-- ---------------------------------------------------------------------------
-- 2. the refusal text points at the live screen
--    Same verdict shape as v12.9 ({allowed} or {allowed:false, code, reason});
--    only the destination in `reason` changed, so the router needs no redeploy.
-- ---------------------------------------------------------------------------
create or replace function public.internal_discord_gate(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.discord_identities%rowtype;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', true);  -- no account: nothing to gate
  end if;

  if not coalesce(
    (select s.discord_required from public.app_settings s where s.id = 1),
    false
  ) then
    return jsonb_build_object('allowed', true, 'required', false);
  end if;

  select * into v_row from public.discord_identities d
   where d.user_id = p_user_id;

  if not found then
    return jsonb_build_object(
      'allowed', false,
      'code', 'discord_not_linked',
      'reason', 'This workspace requires a linked Discord account. Connect one in the dashboard under Settings → Discord.');
  end if;

  if not v_row.guild_member then
    return jsonb_build_object(
      'allowed', false,
      'code', 'discord_not_in_server',
      'reason', 'Your Discord is linked but you are not in the community server. Join it from Settings → Discord, then retry.');
  end if;

  return jsonb_build_object('allowed', true);
end $$;

revoke execute on function public.internal_discord_gate(uuid) from anon, authenticated;
grant  execute on function public.internal_discord_gate(uuid) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
--   select discord_required from public.public_settings;        -- true
--   select public.internal_discord_gate(null);                  -- {"allowed": true}
--   -- an account with no link:
--   select public.internal_discord_gate('<user uuid>');
--   -- {"allowed": false, "code": "discord_not_linked", "reason": "…Settings → Discord."}
-- ---------------------------------------------------------------------------
-- TO RELAX IT AGAIN (gate off, keys served as before):
--   update public.app_settings set discord_required = false where id = 1;
--   alter table public.app_settings alter column discord_required set default false;
-- ---------------------------------------------------------------------------
-- NOTE: this file does not touch admin_save_settings(). The Admin → Settings
--   "Require Discord for API access" select still writes both values, so you
--   can flip the policy from the panel without SQL.
-- ============================================================================
