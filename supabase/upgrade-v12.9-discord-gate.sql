-- ============================================================================
-- v12.9 — Discord gate: API access requires a linked Discord account that is
--         a member of the community server
-- ----------------------------------------------------------------------------
--   · app_settings.discord_required — the switch. Ships OFF, exactly like
--     credits_enabled did: turning it on before users have linked Discord
--     would 403 every existing key, so it is flipped in Admin → Settings once
--     the connect flow has had time to roll out.
--   · internal_discord_gate(user_id) — service-role verdict for the router:
--     allowed, or which of the two requirements failed (not linked / not in
--     the guild). Reads discord_identities (v12.6), which only the
--     discord-auth function can write, so the browser cannot forge membership.
--
-- Run after upgrade-v12.7-announcements-discord-credit.sql. Idempotent.
-- ============================================================================

begin;

-- 1. the switch ---------------------------------------------------------------
alter table public.app_settings
  add column if not exists discord_required boolean not null default false;

-- 2. the gate -----------------------------------------------------------------
--    One round trip from the router, same verdict shape as the community gate:
--    { allowed: true } or { allowed: false, code, reason }.
create or replace function public.internal_discord_gate(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.discord_identities%rowtype;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', true);  -- no account: nothing to gate
  end if;

  /* The switch ships off (like credits_enabled did); while it is off every
     account passes and this one round trip is the router's only cost. */
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
      'reason', 'This workspace requires a linked Discord account. Connect one in the dashboard under Profile → Discord.');
  end if;

  if not v_row.guild_member then
    return jsonb_build_object(
      'allowed', false,
      'code', 'discord_not_in_server',
      'reason', 'Your Discord is linked but you are not in the community server. Join it from Profile → Discord, then retry.');
  end if;

  return jsonb_build_object('allowed', true);
end $$;

revoke execute on function public.internal_discord_gate(uuid) from anon, authenticated;
grant  execute on function public.internal_discord_gate(uuid) to service_role;

-- 3. admin_save_settings(): the switch joins the allow-list -------------------
-- Full replacement of the v12.7 function — every prior field carried over
-- unchanged, discord_required appended.
create or replace function public.admin_save_settings(p_patch jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  k        text;
  v_allowed text[] := array[
    'brand_name','gateway_url','signup_enabled','default_policy','failover_enabled',
    'max_failover_hops','log_retention_days','credits_enabled','signup_credit_usd',
    'low_balance_usd','overdraft_usd','topup_note','admin_emails','allowed_email_domains',
    'five_hour_limit_usd','weekly_limit_usd','discord_join_credit_usd','discord_required'
  ];
  v_domains text[];
  v_admins  text[];
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Settings patch must be a JSON object' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (v_allowed)) then
      raise exception 'Setting % cannot be changed here', k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'gateway_url' and coalesce(p_patch->>'gateway_url', '') <> ''
     and p_patch->>'gateway_url' !~ '^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$' then
    raise exception 'Gateway URL must be an https:// URL' using errcode = '22023';
  end if;

  if p_patch ? 'allowed_email_domains' then
    select array_agg(lower(btrim(d))) into v_domains
    from jsonb_array_elements_text(p_patch->'allowed_email_domains') d
    where btrim(d) <> '';
    if v_domains is null or cardinality(v_domains) = 0 then
      raise exception 'At least one email domain must stay allowed' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_domains) d where d !~ '^[a-z0-9.-]+\.[a-z]{2,}$') then
      raise exception 'Email domains must look like gmail.com' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'admin_emails' then
    select array_agg(lower(btrim(e))) into v_admins
    from jsonb_array_elements_text(p_patch->'admin_emails') e
    where btrim(e) <> '';
    v_admins := coalesce(v_admins, array[]::text[]);
    if exists (select 1 from unnest(v_admins) e
               where e !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$') then
      raise exception 'admin_emails must contain valid email addresses' using errcode = '22023';
    end if;
  end if;

  update public.app_settings s set
    brand_name = case when p_patch ? 'brand_name'
      then left(regexp_replace(coalesce(nullif(btrim(p_patch->>'brand_name'), ''), s.brand_name), '[<>]', '', 'g'), 60)
      else s.brand_name end,
    gateway_url = case when p_patch ? 'gateway_url'
      then nullif(btrim(p_patch->>'gateway_url'), '') else s.gateway_url end,
    signup_enabled = case when p_patch ? 'signup_enabled'
      then (p_patch->>'signup_enabled')::boolean else s.signup_enabled end,
    default_policy = case when p_patch ? 'default_policy'
      then left(regexp_replace(coalesce(nullif(btrim(p_patch->>'default_policy'), ''), s.default_policy), '[^a-zA-Z0-9:_.-]', '', 'g'), 40)
      else s.default_policy end,
    failover_enabled = case when p_patch ? 'failover_enabled'
      then (p_patch->>'failover_enabled')::boolean else s.failover_enabled end,
    max_failover_hops = case when p_patch ? 'max_failover_hops'
      then least(greatest((p_patch->>'max_failover_hops')::int, 1), 10) else s.max_failover_hops end,
    log_retention_days = case when p_patch ? 'log_retention_days'
      then least(greatest((p_patch->>'log_retention_days')::int, 1), 365) else s.log_retention_days end,
    credits_enabled = case when p_patch ? 'credits_enabled'
      then (p_patch->>'credits_enabled')::boolean else s.credits_enabled end,
    signup_credit_usd = case when p_patch ? 'signup_credit_usd'
      then least(greatest((p_patch->>'signup_credit_usd')::numeric, 0), 10000) else s.signup_credit_usd end,
    low_balance_usd = case when p_patch ? 'low_balance_usd'
      then least(greatest((p_patch->>'low_balance_usd')::numeric, 0), 10000) else s.low_balance_usd end,
    overdraft_usd = case when p_patch ? 'overdraft_usd'
      then least(greatest((p_patch->>'overdraft_usd')::numeric, 0), 10000) else s.overdraft_usd end,
    topup_note = case when p_patch ? 'topup_note'
      then left(regexp_replace(coalesce(p_patch->>'topup_note', ''), '[<>]', '', 'g'), 500) else s.topup_note end,
    admin_emails = case when p_patch ? 'admin_emails' then v_admins else s.admin_emails end,
    allowed_email_domains = case when p_patch ? 'allowed_email_domains' then v_domains else s.allowed_email_domains end,
    five_hour_limit_usd = case when p_patch ? 'five_hour_limit_usd'
      then least(greatest((p_patch->>'five_hour_limit_usd')::numeric, 0), 100000) else s.five_hour_limit_usd end,
    weekly_limit_usd = case when p_patch ? 'weekly_limit_usd'
      then least(greatest((p_patch->>'weekly_limit_usd')::numeric, 0), 100000) else s.weekly_limit_usd end,
    discord_join_credit_usd = case when p_patch ? 'discord_join_credit_usd'
      then least(greatest((p_patch->>'discord_join_credit_usd')::numeric, 0), 10000) else s.discord_join_credit_usd end,
    discord_required = case when p_patch ? 'discord_required'
      then (p_patch->>'discord_required')::boolean else s.discord_required end,
    updated_at = now()
  where s.id = 1;

  insert into public.audit_logs (actor_id, action, entity, detail)
  values (auth.uid(), 'save_settings', 'app_settings',
          jsonb_build_object('keys', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
end $$;

revoke execute on function public.admin_save_settings(jsonb) from anon;
grant  execute on function public.admin_save_settings(jsonb) to authenticated;
-- 4. public_settings: the app shell reads the switch -------------------------
-- The dashboard only shows the "API access is paused" banner when the gate is
-- actually on, so the flag joins the public view. Same columns as v12.7 with
-- discord_required appended — create-or-replace stays valid against it.
create or replace view public.public_settings as
  select s.id,
         s.brand_name,
         s.gateway_url,
         s.signup_enabled,
         s.default_policy,
         s.failover_enabled,
         s.max_failover_hops,
         s.log_retention_days,
         s.credits_enabled,
         s.signup_credit_usd,
         s.low_balance_usd,
         s.overdraft_usd,
         s.topup_note,
         s.allowed_email_domains,
         s.referrals_enabled,
         s.referral_reward_usd,
         s.referral_bonus_usd,
         s.five_hour_limit_usd,
         s.weekly_limit_usd,
         s.discord_join_credit_usd,
         s.discord_required
  from public.app_settings s
  where s.id = 1;

grant select on public.public_settings to anon, authenticated;

commit;

-- ============================================================================
--  VERIFY
-- ============================================================================
--   select discord_required from public.public_settings;       -- false
--   select public.internal_discord_gate(null);                 -- {"allowed": true}
--   -- flip the switch (Admin → Settings, or SQL):
--   --   update public.app_settings set discord_required = true where id = 1;
--   -- then, for an account with no Discord link:
--   --   select public.internal_discord_gate('<user uuid>');
--   --   -- {"allowed": false, "code": "discord_not_linked", ...}
--   Re-run the whole file: every statement is idempotent.
--
-- ============================================================================
--  ROLLBACK
-- ============================================================================
--   begin;
--   alter table public.app_settings drop column if exists discord_required;
--   drop function if exists public.internal_discord_gate(uuid);
--   -- then re-apply the v12.7 admin_save_settings + public_settings (their
--   -- allow-list and column list lose the key).
--   commit;
-- ============================================================================

