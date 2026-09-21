-- ============================================================================
--  RageStar v12.7 — site announcements + Discord join credit
-- ----------------------------------------------------------------------------
--  Run this whole file in the Supabase SQL editor. Idempotent: safe to re-run.
--  Run after upgrade-v12.6-discord.sql.
--
--  Adds
--    1. public.announcements        — operator-posted banners shown across the
--       site. Active rows are world-readable on purpose: the landing page is
--       public, so anon has to be able to see them.
--    2. admin_create/update/delete_announcement() — the ONLY write path, so
--       every change lands in audit_logs. No table-level write policies.
--    3. app_settings.discord_join_credit_usd — the one-time credit an account
--       collects for joining the community Discord server through the bot.
--       Default 50; 0 disables the offer.
--    4. public.discord_join_grants  — who has already been paid. Deliberately
--       NOT a column on discord_identities: disconnecting deletes that row,
--       and the credit must not become claimable again after a re-connect.
--    5. internal_grant_discord_join_credit() — service_role only. The
--       discord-auth Edge Function calls it only after Discord confirmed the
--       membership (201/204); a failed join never pays.
--    6. admin_save_settings()      — gains discord_join_credit_usd in its
--       allow-list, so the offer can be tuned or disabled without raw SQL.
-- ============================================================================

begin;

-- ============================================================================
--  1. ANNOUNCEMENTS
-- ============================================================================
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text        not null,
  body       text        not null default '',
  tone       text        not null default 'info'
             check (tone in ('info', 'ok', 'warn')),
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.announcements is
  'Site-wide banners. Active rows are readable by everyone (the landing page is public); writes go through the admin_*_announcement RPCs so every change is audited.';

alter table public.announcements enable row level security;

drop policy if exists announcements_public_read on public.announcements;
create policy announcements_public_read on public.announcements for select
  to anon, authenticated
  using (is_active or public.is_admin());

-- No insert/update/delete policy on purpose: the RPCs below are the only
-- write path, the same shape as the credit ledger.
revoke all on public.announcements from anon, authenticated;
grant select on public.announcements to anon, authenticated;
grant all    on public.announcements to service_role;

-- ------------------------------------------------------------- admin writes --
create or replace function public.admin_create_announcement(
  p_title     text,
  p_body      text    default '',
  p_tone      text    default 'info',
  p_is_active boolean default true
)
returns public.announcements
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text;
  v_row   public.announcements;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  p_title := left(regexp_replace(coalesce(btrim(p_title), ''), '[<>]', '', 'g'), 140);
  p_body  := left(regexp_replace(coalesce(btrim(p_body),  ''), '[<>]', '', 'g'), 2000);
  p_tone  := lower(coalesce(btrim(p_tone), 'info'));

  if p_title = '' then
    raise exception 'Give the announcement a title' using errcode = '22023';
  end if;
  if p_tone not in ('info', 'ok', 'warn') then
    raise exception 'Tone must be info, ok or warn' using errcode = '22023';
  end if;

  select email into v_email from public.profiles where id = auth.uid();

  insert into public.announcements (title, body, tone, is_active)
  values (p_title, p_body, p_tone, coalesce(p_is_active, true))
  returning * into v_row;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'create_announcement', 'announcements', v_row.id::text,
          jsonb_build_object('title', v_row.title, 'tone', v_row.tone, 'is_active', v_row.is_active));

  return v_row;
end $$;

create or replace function public.admin_update_announcement(
  p_id    uuid,
  p_patch jsonb
)
returns public.announcements
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text;
  v_row   public.announcements;
  k       text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Patch must be a JSON object' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('title', 'body', 'tone', 'is_active') then
      raise exception 'Field % cannot be changed here', k using errcode = '22023';
    end if;
  end loop;

  select email into v_email from public.profiles where id = auth.uid();

  update public.announcements a set
    title = case when p_patch ? 'title'
      then left(regexp_replace(coalesce(btrim(p_patch ->> 'title'), ''), '[<>]', '', 'g'), 140)
      else a.title end,
    body = case when p_patch ? 'body'
      then left(regexp_replace(coalesce(btrim(p_patch ->> 'body'), ''), '[<>]', '', 'g'), 2000)
      else a.body end,
    tone = case when p_patch ? 'tone'
      then lower(coalesce(btrim(p_patch ->> 'tone'), 'info'))
      else a.tone end,
    is_active = case when p_patch ? 'is_active'
      then coalesce((p_patch ->> 'is_active')::boolean, true)
      else a.is_active end,
    updated_at = now()
  where a.id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Announcement not found' using errcode = '22023';
  end if;
  if v_row.title = '' then
    raise exception 'Give the announcement a title' using errcode = '22023';
  end if;
  if v_row.tone not in ('info', 'ok', 'warn') then
    raise exception 'Tone must be info, ok or warn' using errcode = '22023';
  end if;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'update_announcement', 'announcements', p_id::text, p_patch);

  return v_row;
end $$;

create or replace function public.admin_delete_announcement(p_id uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text;
  v_title text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select email into v_email from public.profiles where id = auth.uid();
  select title into v_title from public.announcements where id = p_id;

  delete from public.announcements where id = p_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'delete_announcement', 'announcements', p_id::text,
          jsonb_build_object('title', v_title));
end $$;

revoke execute on function public.admin_create_announcement(text, text, text, boolean) from anon;
revoke execute on function public.admin_update_announcement(uuid, jsonb)                from anon;
revoke execute on function public.admin_delete_announcement(uuid)                       from anon;
grant execute on function public.admin_create_announcement(text, text, text, boolean) to authenticated;
grant execute on function public.admin_update_announcement(uuid, jsonb)                to authenticated;
grant execute on function public.admin_delete_announcement(uuid)                       to authenticated;

-- ============================================================================
--  2. DISCORD JOIN CREDIT
-- ============================================================================
alter table public.app_settings
  add column if not exists discord_join_credit_usd numeric(12,4) not null default 50;

comment on column public.app_settings.discord_join_credit_usd is
  'One-time credit for joining the community Discord server through the bot (discord-auth). 0 disables the offer.';

create table if not exists public.discord_join_grants (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  amount_usd numeric(14,6) not null,
  discord_id text        not null default '',
  granted_at timestamptz not null default now()
);

comment on table public.discord_join_grants is
  'Once-per-account record of the Discord join credit. Separate from discord_identities on purpose: deleting the identity (disconnect) must not make the credit claimable again.';

alter table public.discord_join_grants enable row level security;

drop policy if exists discord_join_grants_select_own on public.discord_join_grants;
create policy discord_join_grants_select_own on public.discord_join_grants for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.discord_join_grants from anon, authenticated;
grant select on public.discord_join_grants to authenticated;
grant all    on public.discord_join_grants to service_role;

-- Pays the join credit. Returns the amount paid, or 0 when nothing was paid
-- (offer disabled, credits not installed, unknown account, already paid).
-- The insert IS the once-per-account guard: it runs first, and because the
-- whole call is one transaction a failed credit move rolls it back with it.
create or replace function public.internal_grant_discord_join_credit(
  p_user_id    uuid,
  p_discord_id text default ''
)
returns numeric
language plpgsql volatile security definer set search_path = public as $$
declare
  v_amount  numeric(12,4);
  v_claimed uuid;
begin
  if p_user_id is null then
    return 0;
  end if;

  select coalesce(s.discord_join_credit_usd, 0) into v_amount
    from public.app_settings s
   where s.id = 1;
  if coalesce(v_amount, 0) <= 0 then
    return 0;                                   -- offer disabled
  end if;

  -- credits are optional (v5.4): no mover installed, nothing to pay with
  if to_regprocedure('public.internal_credit_move(uuid,numeric,text,text,text,uuid,text,uuid,text)') is null then
    return 0;
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    return 0;
  end if;

  insert into public.discord_join_grants (user_id, amount_usd, discord_id)
  values (p_user_id, v_amount, left(coalesce(p_discord_id, ''), 64))
  on conflict (user_id) do nothing
  returning user_id into v_claimed;

  if v_claimed is null then
    return 0;                                   -- already paid, once ever
  end if;

  perform public.internal_credit_move(
    p_user_id, v_amount, 'admin_grant',
    'discord join credit — joined the community server',
    null, null, null, null, 'system:discord');

  return v_amount;
end $$;

revoke execute on function public.internal_grant_discord_join_credit(uuid, text) from anon, authenticated;
grant  execute on function public.internal_grant_discord_join_credit(uuid, text) to service_role;

-- ------------------------------------------------- settings writer gains it --
-- Same full-replacement pattern as v12.5: the allow-list and the update gain
-- discord_join_credit_usd; every other field is carried over unchanged.
create or replace function public.admin_save_settings(p_patch jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  k        text;
  v_allowed text[] := array[
    'brand_name','gateway_url','signup_enabled','default_policy','failover_enabled',
    'max_failover_hops','log_retention_days','credits_enabled','signup_credit_usd',
    'low_balance_usd','overdraft_usd','topup_note','admin_emails','allowed_email_domains',
    'five_hour_limit_usd','weekly_limit_usd','discord_join_credit_usd'
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
    updated_at = now()
  where s.id = 1;

  insert into public.audit_logs (actor_id, action, entity, detail)
  values (auth.uid(), 'save_settings', 'app_settings',
          jsonb_build_object('keys', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
end $$;

revoke execute on function public.admin_save_settings(jsonb) from anon;
grant  execute on function public.admin_save_settings(jsonb) to authenticated;

-- The amount is not secret — the profile card advertises the offer — so it
-- joins the public (non-admin) settings view. Same columns as v12.5 with the
-- new one appended, so create-or-replace is valid against the v12.5 view.
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
         s.discord_join_credit_usd
  from public.app_settings s
  where s.id = 1;

grant select on public.public_settings to anon, authenticated;

commit;

-- ============================================================================
--  VERIFY
-- ============================================================================
--   \d public.announcements
--   \d public.discord_join_grants
--   select discord_join_credit_usd from public.public_settings;     -- 50
--   -- grant path, once per account (run in the SQL editor):
--   select public.internal_grant_discord_join_credit('<user uuid>', '123456');
--   -- first call returns 50, every call after returns 0
--   select kind, delta_usd, description, actor_email from public.credit_ledger
--    where description like 'discord join credit%';
--   -- admin writes are audited:
--   select action, entity, detail from public.audit_logs
--    where entity = 'announcements' order by created_at desc limit 5;
--   Re-run the whole file: every statement is idempotent.
--
-- ============================================================================
--  ROLLBACK
-- ============================================================================
--   begin;
--   drop function if exists public.admin_create_announcement(text, text, text, boolean);
--   drop function if exists public.admin_update_announcement(uuid, jsonb);
--   drop function if exists public.admin_delete_announcement(uuid);
--   drop function if exists public.internal_grant_discord_join_credit(uuid, text);
--   drop table if exists public.discord_join_grants;
--   drop table if exists public.announcements;
--   alter table public.app_settings drop column if exists discord_join_credit_usd;
--   -- then recreate public_settings exactly as upgrade-v12.5-window-limits.sql
--   -- defines it (the same column list minus discord_join_credit_usd).
--   commit;
--   Credits already paid stay in credit_ledger (append-only history); take
--   them back one account at a time with admin_adjust_credits().
