-- ============================================================================
-- v12.5 — Window limits: rolling 5-hour and weekly spend caps per account
-- ----------------------------------------------------------------------------
--   · app_settings.five_hour_limit_usd / weekly_limit_usd — the caps; 0 = unlimited
--   · my_window_usage()     — a user's own usage inside both windows (console)
--   · internal_window_check()    — router-side enforcement, service_role only
--   · public_settings view       — gains the two cap columns so consoles can read them
--   · admin_save_settings()      — gains the two fields in its allow-list
--
-- Run after upgrade-v12.4-early-access.sql. Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------- settings --
alter table public.app_settings
  add column if not exists five_hour_limit_usd numeric(12,4) not null default 0,
  add column if not exists weekly_limit_usd    numeric(12,4) not null default 0;

comment on column public.app_settings.five_hour_limit_usd is
  'Rolling 5-hour spend cap per account, USD. 0 = unlimited.';
comment on column public.app_settings.weekly_limit_usd is
  'Rolling 7-day spend cap per account, USD. 0 = unlimited.';

-- The caps are not secret: every console shows them next to the usage bar,
-- so they join the public (non-admin) settings view.
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
         s.weekly_limit_usd
  from public.app_settings s
  where s.id = 1;

grant select on public.public_settings to anon, authenticated;

-- ------------------------------------------------------ console read (own) --
-- One call for the overview card: both caps plus this account's spend and
-- what is left before each cap, and when each window frees up
-- (the oldest billed request in it ages out of the window).
create or replace function public.my_window_usage()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'five_hour_limit_usd', s.five_hour_limit_usd,
    'weekly_limit_usd',    s.weekly_limit_usd,
    'five_hour_used_usd',  coalesce((
      select sum(l.cost_usd) from public.request_logs l
      where l.user_id = auth.uid()
        and l.created_at > now() - interval '5 hours'), 0),
    'weekly_used_usd',     coalesce((
      select sum(l.cost_usd) from public.request_logs l
      where l.user_id = auth.uid()
        and l.created_at > now() - interval '7 days'), 0),
    'five_hour_left_usd',  case when s.five_hour_limit_usd > 0 then greatest(s.five_hour_limit_usd - coalesce((
      select sum(l.cost_usd) from public.request_logs l
      where l.user_id = auth.uid()
        and l.created_at > now() - interval '5 hours'), 0), 0) end,
    'weekly_left_usd',     case when s.weekly_limit_usd > 0 then greatest(s.weekly_limit_usd - coalesce((
      select sum(l.cost_usd) from public.request_logs l
      where l.user_id = auth.uid()
        and l.created_at > now() - interval '7 days'), 0), 0) end,
    'five_hour_reset_at',  (
      select min(l.created_at) + interval '5 hours' from public.request_logs l
      where l.user_id = auth.uid()
        and l.created_at > now() - interval '5 hours'),
    'weekly_reset_at',       (
      select min(l.created_at) + interval '7 days' from public.request_logs l
      where l.user_id = auth.uid()
        and l.created_at > now() - interval '7 days')
  )
  from public.app_settings s
  where s.id = 1;
$$;

revoke execute on function public.my_window_usage() from anon;
grant  execute on function public.my_window_usage() to authenticated;

-- -------------------------------------------------------- router enforcement --
-- The router (service_role) calls this before dispatching a call. Both caps
-- are checked against the account's billed spend in each rolling window; the
-- 5-hour cap is reported first when both are hit. retry_after is how long
-- until the oldest request in the breached window leaves it, clamped to
-- 60 s .. the full window so a caller can always act on the header.
create or replace function public.internal_window_check(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s         public.app_settings%rowtype;
  used_5h   numeric;
  used_wk   numeric;
  oldest_5h timestamptz;
  oldest_wk timestamptz;
  retry     bigint;
begin
  select * into s from public.app_settings where id = 1;
  if s.five_hour_limit_usd <= 0 and s.weekly_limit_usd <= 0 then
    return jsonb_build_object('ok', true);
  end if;

  select coalesce(sum(l.cost_usd), 0), min(l.created_at)
    into used_5h, oldest_5h
    from public.request_logs l
    where l.user_id = p_user_id
      and l.created_at > now() - interval '5 hours';

  select coalesce(sum(l.cost_usd), 0), min(l.created_at)
    into used_wk, oldest_wk
    from public.request_logs l
    where l.user_id = p_user_id
      and l.created_at > now() - interval '7 days';

  if s.five_hour_limit_usd > 0 and used_5h >= s.five_hour_limit_usd then
    retry := greatest(60, least(18000, (extract(epoch from
      coalesce(oldest_5h, now()) + interval '5 hours' - now()))::bigint));
    return jsonb_build_object(      'ok',                 false,
      'code',               'five_hour_limit_exceeded',
      'window',             '5h',
      'used_usd',           used_5h,
      'limit_usd',          s.five_hour_limit_usd,
      'five_hour_used_usd', used_5h,
      'weekly_used_usd',    used_wk,
      'retry_after', retry,
      'reason',      format('Five-hour spend limit reached: %s of %s USD. Try again in about %s min.',
                            round(used_5h::numeric, 2), round(s.five_hour_limit_usd::numeric, 2),
                            greatest(1, (retry / 60)::bigint)))
    );
  end if;

  if s.weekly_limit_usd > 0 and used_wk >= s.weekly_limit_usd then
    retry := greatest(60, least(604800, (extract(epoch from
      coalesce(oldest_wk, now()) + interval '7 days' - now()))::bigint));
    return jsonb_build_object(      'ok',                 false,
      'code',               'weekly_limit_exceeded',
      'window',             'week',
      'used_usd',           used_wk,
      'limit_usd',          s.weekly_limit_usd,
      'five_hour_used_usd', used_5h,
      'weekly_used_usd',    used_wk,
      'retry_after', retry,
      'reason',      format('Weekly spend limit reached: %s of %s USD. Try again in about %s min.',
                            round(used_wk::numeric, 2), round(s.weekly_limit_usd::numeric, 2),
                            greatest(1, (retry / 60)::bigint)))
    );
  end if;

  return jsonb_build_object('ok', true);
end
$$;

revoke execute on function public.internal_window_check(uuid) from anon, authenticated;
grant  execute on function public.internal_window_check(uuid) to service_role;

create or replace function public.admin_save_settings(p_patch jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  k        text;
  v_allowed text[] := array[
    'brand_name','gateway_url','signup_enabled','default_policy','failover_enabled',
    'max_failover_hops','log_retention_days','credits_enabled','signup_credit_usd',
    'low_balance_usd','overdraft_usd','topup_note','admin_emails','allowed_email_domains',
    'five_hour_limit_usd','weekly_limit_usd'
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
    updated_at = now()
  where s.id = 1;

  insert into public.audit_logs (actor_id, action, entity, detail)
  values (auth.uid(), 'save_settings', 'app_settings',
          jsonb_build_object('keys', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
end $$;

revoke execute on function public.admin_save_settings(jsonb) from anon;
grant  execute on function public.admin_save_settings(jsonb) to authenticated;
