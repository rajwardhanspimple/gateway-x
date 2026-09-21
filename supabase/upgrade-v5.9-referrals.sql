-- ============================================================================
--  RageStar v5.9 — referrals + admin account recovery
--  Run this whole file in the Supabase SQL editor. Idempotent: safe to re-run.
--
--  Adds
--    1. profiles.referral_code  — the short code in every invite link
--    2. public.referrals        — one row per accepted invite, with its payout
--    3. my_referral()           — the console's Referrals tab reads this
--    4. admin account recovery  — reset link / temp password / force sign-out
--
--  ON PASSWORDS -------------------------------------------------------------
--  There is deliberately NO "show me this user's password" function here, and
--  there cannot be one. Supabase Auth stores only a bcrypt hash in
--  auth.users.encrypted_password. A hash is one-way by design: the plaintext
--  is not kept anywhere, so no query can return it. The only way to make
--  passwords readable would be to start recording them in plaintext at signup,
--  which would turn this table into a credential dump — and because this
--  workspace is Gmail-only, those are very often the same passwords people use
--  on their Google account.
--
--  So instead an admin gets the three things a plaintext password would have
--  been used for, without the liability:
--    · admin_password_reset_link()  — mail/hand the user a one-time link
--    · admin_set_temp_password()    — set a known temporary password (via the
--                                     admin-account Edge Function)
--    · admin_force_signout()        — kill every active session immediately
--  Every one of them writes an audit_logs row naming the admin who did it.
-- ============================================================================

-- ----------------------------------------------------------------- settings --
alter table public.app_settings
  add column if not exists referrals_enabled         boolean       not null default true,
  add column if not exists referral_reward_usd       numeric(12,4) not null default 5,
  add column if not exists referral_bonus_usd        numeric(12,4) not null default 5,
  add column if not exists referral_reward_on        text          not null default 'signup',
  add column if not exists referral_max_per_user     int           not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_referral_reward_on_chk'
  ) then
    alter table public.app_settings
      add constraint app_settings_referral_reward_on_chk
      check (referral_reward_on in ('signup', 'manual'));
  end if;
end $$;

comment on column public.app_settings.referral_reward_on is
  'signup = credit both sides as soon as the invite is accepted; manual = hold every referral as pending until an admin settles it.';
comment on column public.app_settings.referral_max_per_user is
  '0 = unlimited. Otherwise the most rewarded invites a single account can ever be paid for.';

-- ----------------------------------------------------------------- profiles --
alter table public.profiles
  add column if not exists referral_code       text,
  add column if not exists referred_by         uuid references auth.users (id) on delete set null,
  add column if not exists referral_count      int           not null default 0,
  add column if not exists referral_earned_usd numeric(14,6) not null default 0;

create unique index if not exists profiles_referral_code_idx
  on public.profiles (upper(referral_code)) where referral_code is not null;
create index if not exists profiles_referred_by_idx on public.profiles (referred_by);

-- ---------------------------------------------------------------- referrals --
create table if not exists public.referrals (
  id          uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users (id) on delete cascade,
  referred_id uuid not null references auth.users (id) on delete cascade,
  code        text not null,
  status      text not null default 'pending'
                check (status in ('pending', 'rewarded', 'void')),
  reward_usd  numeric(14,6) not null default 0,
  bonus_usd   numeric(14,6) not null default 0,
  note        text,
  settled_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- one account can only ever be *referred* once
create unique index if not exists referrals_referred_idx on public.referrals (referred_id);
create index if not exists referrals_referrer_idx on public.referrals (referrer_id, created_at desc);
create index if not exists referrals_status_idx   on public.referrals (status);

-- ============================================================================
--  CODE GENERATION
-- ============================================================================

-- Crockford-ish alphabet: no I, L, O, U, so a code read aloud or typed from a
-- screenshot cannot land on the wrong account.
create or replace function public.internal_referral_code()
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code text;
  v_try  int := 0;
begin
  loop
    v_try := v_try + 1;
    v_code := '';
    for _ in 1..7 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (
      select 1 from public.profiles p where upper(p.referral_code) = v_code
    );

    if v_try > 40 then
      -- astronomically unlikely; fall back to something guaranteed unique
      v_code := 'R' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 9));
      exit;
    end if;
  end loop;

  return v_code;
end $$;

/** Hands back this account's code, minting one on first use. */
create or replace function public.internal_ensure_referral_code(p_user_id uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_code text;
begin
  select p.referral_code into v_code from public.profiles p where p.id = p_user_id;
  if v_code is not null and btrim(v_code) <> '' then
    return v_code;
  end if;

  v_code := public.internal_referral_code();
  update public.profiles set referral_code = v_code where id = p_user_id;
  return v_code;
end $$;

-- Backfill everyone who signed up before referrals existed.
do $$
declare
  r record;
begin
  for r in select id from public.profiles where referral_code is null loop
    perform public.internal_ensure_referral_code(r.id);
  end loop;
end $$;

-- ============================================================================
--  PAYOUT
-- ============================================================================

-- Credits live in upgrade-v5.4.sql. If that has not been applied, referrals
-- still track who invited whom — they just record a 0 payout instead of
-- failing, so this migration never hard-depends on the credit system.
create or replace function public.internal_credits_installed()
returns boolean
language sql stable set search_path = public as $$
  select to_regprocedure(
    'public.internal_credit_move(uuid,numeric,text,text,text,uuid,text,uuid,text)'
  ) is not null;
$$;

/** Pays a pending referral: reward to the inviter, bonus to the invitee. */
create or replace function public.internal_settle_referral(
  p_referral_id uuid,
  p_actor_id    uuid default null,
  p_actor_email text default null
)
returns public.referrals
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ref      public.referrals;
  v_reward   numeric(14,6);
  v_bonus    numeric(14,6);
  v_cap      int;
  v_paid     int;
  v_credits  boolean := public.internal_credits_installed();
begin
  select * into v_ref from public.referrals where id = p_referral_id for update;
  if v_ref.id is null then
    raise exception 'Referral not found';
  end if;
  if v_ref.status <> 'pending' then
    return v_ref;  -- already settled or voided; never pay twice
  end if;

  select coalesce(referral_reward_usd, 0), coalesce(referral_bonus_usd, 0),
         coalesce(referral_max_per_user, 0)
    into v_reward, v_bonus, v_cap
    from public.app_settings where id = 1;

  -- cap how many invites one account can be paid for
  if v_cap > 0 then
    select count(*) into v_paid
      from public.referrals
     where referrer_id = v_ref.referrer_id and status = 'rewarded';
    if v_paid >= v_cap then
      update public.referrals
         set status = 'void',
             note = coalesce(note, '') || ' (referral cap reached)',
             settled_at = now()
       where id = v_ref.id
      returning * into v_ref;
      return v_ref;
    end if;
  end if;

  if not v_credits then
    v_reward := 0;
    v_bonus  := 0;
  end if;

  if v_credits and v_reward > 0 then
    perform public.internal_credit_move(
      v_ref.referrer_id, v_reward, 'admin_grant',
      'referral reward — invited ' ||
        coalesce((select email from public.profiles where id = v_ref.referred_id), 'a new account'),
      null, null, null, p_actor_id, p_actor_email);
  end if;

  if v_credits and v_bonus > 0 then
    perform public.internal_credit_move(
      v_ref.referred_id, v_bonus, 'signup_grant',
      'welcome bonus — joined via ' || v_ref.code,
      null, null, null, p_actor_id, p_actor_email);
  end if;

  update public.referrals
     set status     = 'rewarded',
         reward_usd = v_reward,
         bonus_usd  = v_bonus,
         settled_at = now()
   where id = v_ref.id
  returning * into v_ref;

  update public.profiles
     set referral_count      = (select count(*) from public.referrals
                                 where referrer_id = v_ref.referrer_id and status = 'rewarded'),
         referral_earned_usd = (select coalesce(sum(reward_usd), 0) from public.referrals
                                 where referrer_id = v_ref.referrer_id and status = 'rewarded')
   where id = v_ref.referrer_id;

  return v_ref;
end $$;

-- ============================================================================
--  SIGNUP HOOK
--  A second trigger on auth.users rather than a rewrite of handle_new_user(),
--  so this migration cannot clobber the signup-credit logic from v5.4.
--  "on_auth_user_created" sorts before "on_auth_user_created_referral", so the
--  profile row already exists by the time this runs.
-- ============================================================================
create or replace function public.handle_new_user_referral()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_code     text;
  v_referrer uuid;
  v_enabled  boolean;
  v_mode     text;
  v_ref_id   uuid;
begin
  select coalesce(referrals_enabled, true), coalesce(referral_reward_on, 'signup')
    into v_enabled, v_mode
    from public.app_settings where id = 1;

  -- always mint the new account its own code, invited or not
  perform public.internal_ensure_referral_code(new.id);

  if not coalesce(v_enabled, true) then
    return new;
  end if;

  v_code := upper(btrim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));
  if v_code = '' then
    return new;
  end if;

  select p.id into v_referrer
    from public.profiles p
   where upper(p.referral_code) = v_code
     and p.id <> new.id
     and p.status = 'active'
   limit 1;

  if v_referrer is null then
    return new;  -- bad or stale code: never block a signup over it
  end if;

  update public.profiles set referred_by = v_referrer where id = new.id;

  insert into public.referrals (referrer_id, referred_id, code, status)
  values (v_referrer, new.id, v_code, 'pending')
  on conflict (referred_id) do nothing
  returning id into v_ref_id;

  if v_ref_id is not null and v_mode = 'signup' then
    perform public.internal_settle_referral(v_ref_id, null, 'system:signup');
  end if;

  return new;
exception when others then
  -- a referral must never be the reason an account cannot be created
  return new;
end $$;

drop trigger if exists on_auth_user_created_referral on auth.users;
create trigger on_auth_user_created_referral
  after insert on auth.users
  for each row execute function public.handle_new_user_referral();

-- ============================================================================
--  USER-FACING RPCs
-- ============================================================================

/** Everything the Referrals tab needs, in one round trip. */
create or replace function public.my_referral()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_code text;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  v_code := public.internal_ensure_referral_code(v_user);

  return jsonb_build_object(
    'code',      v_code,
    'enabled',   (select coalesce(referrals_enabled, true)   from public.app_settings where id = 1),
    'reward_usd',(select coalesce(referral_reward_usd, 0)    from public.app_settings where id = 1),
    'bonus_usd', (select coalesce(referral_bonus_usd, 0)     from public.app_settings where id = 1),
    'reward_on', (select coalesce(referral_reward_on, 'signup') from public.app_settings where id = 1),
    'invited',   (select count(*) from public.referrals where referrer_id = v_user),
    'rewarded',  (select count(*) from public.referrals where referrer_id = v_user and status = 'rewarded'),
    'pending',   (select count(*) from public.referrals where referrer_id = v_user and status = 'pending'),
    'earned_usd',(select coalesce(sum(reward_usd), 0) from public.referrals
                   where referrer_id = v_user and status = 'rewarded'),
    'referred_by', (select pr.email from public.profiles me
                      join public.profiles pr on pr.id = me.referred_by
                     where me.id = v_user)
  );
end $$;

-- The invitee list, with the email partly masked: an inviter gets to see that
-- someone joined without harvesting a clean address list.
drop view if exists public.my_referrals cascade;
create view public.my_referrals
with (security_invoker = true) as
select r.id,
       r.code,
       r.status,
       r.reward_usd,
       r.created_at,
       r.settled_at,
       regexp_replace(p.email, '^(.).*(.)@', '\1***\2@') as invitee,
       p.full_name is not null as named
from public.referrals r
join public.profiles p on p.id = r.referred_id
where r.referrer_id = auth.uid()
order by r.created_at desc;

-- ============================================================================
--  ADMIN: REFERRALS
-- ============================================================================
drop view if exists public.admin_referrals cascade;
create view public.admin_referrals
with (security_invoker = true) as
select r.id,
       r.code,
       r.status,
       r.reward_usd,
       r.bonus_usd,
       r.note,
       r.created_at,
       r.settled_at,
       r.referrer_id,
       rp.email as referrer_email,
       r.referred_id,
       ip.email as invitee_email,
       (select count(*) from public.request_logs l where l.user_id = r.referred_id) as invitee_requests
from public.referrals r
join public.profiles rp on rp.id = r.referrer_id
join public.profiles ip on ip.id = r.referred_id
where public.is_admin()
order by r.created_at desc;

/** Approve a held referral. Used when referral_reward_on = 'manual'. */
create or replace function public.admin_settle_referral(p_referral_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text;
  v_ref   public.referrals;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select email into v_email from public.profiles where id = auth.uid();
  v_ref := public.internal_settle_referral(p_referral_id, auth.uid(), v_email);

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'settle_referral', 'referrals', p_referral_id::text,
          jsonb_build_object('status', v_ref.status, 'reward_usd', v_ref.reward_usd));

  return to_jsonb(v_ref);
end $$;

/** Kill a referral — self-invites, throwaway accounts, obvious farming. */
create or replace function public.admin_void_referral(p_referral_id uuid, p_note text default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select email into v_email from public.profiles where id = auth.uid();

  update public.referrals
     set status = 'void', note = nullif(btrim(coalesce(p_note, '')), ''), settled_at = now()
   where id = p_referral_id and status <> 'rewarded';

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'void_referral', 'referrals', p_referral_id::text,
          jsonb_build_object('note', p_note));
end $$;

-- ============================================================================
--  ADMIN: ACCOUNT RECOVERY  (the honest replacement for "show me the password")
-- ============================================================================

/** Signs an account out everywhere. Instant — no password change needed.
 *  Use for a leaked laptop, a shared login, or a suspended account that is
 *  still holding a live session. */
create or replace function public.admin_force_signout(p_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email  text;
  v_target text;
  v_killed int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'Pick an account first';
  end if;

  select email into v_email  from public.profiles where id = auth.uid();
  select email into v_target from public.profiles where id = p_user_id;
  if v_target is null then
    raise exception 'Account not found';
  end if;

  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_killed = row_count;

  update auth.refresh_tokens set revoked = true
   where user_id::text = p_user_id::text and revoked = false;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'force_signout', 'auth.users', p_user_id::text,
          jsonb_build_object('email', v_target, 'sessions_ended', v_killed));

  return jsonb_build_object('email', v_target, 'sessions_ended', v_killed);
end $$;

/** What an admin may legitimately know about an account's credentials:
 *  whether a password is set, when it last changed, whether the email is
 *  confirmed, and how many live sessions there are. Never the password. */
create or replace function public.admin_account_security(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'email',              u.email,
           'has_password',       u.encrypted_password is not null and u.encrypted_password <> '',
           'email_confirmed_at', u.email_confirmed_at,
           'last_sign_in_at',    u.last_sign_in_at,
           'password_changed_at',
             greatest(u.updated_at, coalesce(u.recovery_sent_at, u.updated_at)),
           'providers',          coalesce(u.raw_app_meta_data -> 'providers', '[]'::jsonb),
           'live_sessions',      (select count(*) from auth.sessions s where s.user_id = u.id),
           'banned_until',       u.banned_until
         )
    into v_out
    from auth.users u
   where u.id = p_user_id;

  if v_out is null then
    raise exception 'Account not found';
  end if;
  return v_out;
end $$;

/** Records that an admin issued a recovery link or temp password. The Edge
 *  Function does the GoTrue call; this is the paper trail. */
create or replace function public.admin_log_recovery(
  p_user_id uuid,
  p_action  text,
  p_detail  jsonb default '{}'::jsonb
)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email  text;
  v_target text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_action not in ('password_reset_link', 'temp_password', 'force_signout') then
    raise exception 'Unknown recovery action %', p_action;
  end if;

  select email into v_email  from public.profiles where id = auth.uid();
  select email into v_target from public.profiles where id = p_user_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, p_action, 'auth.users', p_user_id::text,
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('email', v_target));
end $$;

-- ============================================================================
--  ADMIN USERS VIEW — add the referral + credential columns
-- ============================================================================
drop view if exists public.admin_users cascade;
create view public.admin_users
with (security_invoker = true) as
select p.id, p.email, p.full_name, p.org, p.plan, p.role, p.status,
       p.monthly_budget_usd, p.rate_limit_rpm, p.created_at,
       p.referral_code,
       p.referred_by,
       (select pr.email from public.profiles pr where pr.id = p.referred_by) as referred_by_email,
       (select count(*) from public.referrals r
         where r.referrer_id = p.id)                                as invites_total,
       (select count(*) from public.referrals r
         where r.referrer_id = p.id and r.status = 'rewarded')      as invites_rewarded,
       (select coalesce(sum(r.reward_usd), 0) from public.referrals r
         where r.referrer_id = p.id and r.status = 'rewarded')      as invites_earned_usd,
       (select count(*) from auth.sessions s where s.user_id = p.id) as live_sessions,
       (select u.last_sign_in_at from auth.users u where u.id = p.id) as last_sign_in_at,
       (select u.email_confirmed_at is not null from auth.users u where u.id = p.id) as email_confirmed,
       (select count(*) from public.api_keys k
         where k.user_id = p.id and k.status = 'active')            as active_keys,
       (select count(*) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days')           as requests_30d,
       (select coalesce(sum(l.cost_usd), 0) from public.request_logs l
         where l.user_id = p.id
           and l.created_at > now() - interval '30 days')           as cost_30d,
       (select max(l.created_at) from public.request_logs l
         where l.user_id = p.id)                                    as last_request_at
from public.profiles p
where public.is_admin()
order by p.created_at desc;

-- v5.6/v5.7 added IP columns to profiles; re-expose them if they are present
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles'
                and column_name = 'ip_limit_exempt') then
    execute $v$
      drop view if exists public.admin_users cascade;
      create view public.admin_users with (security_invoker = true) as
      select p.id, p.email, p.full_name, p.org, p.plan, p.role, p.status,
             p.monthly_budget_usd, p.rate_limit_rpm, p.created_at,
             p.ip_limit_exempt, p.ip_rate_limit_rpm,
             p.referral_code, p.referred_by,
             (select pr.email from public.profiles pr where pr.id = p.referred_by) as referred_by_email,
             (select count(*) from public.referrals r where r.referrer_id = p.id) as invites_total,
             (select count(*) from public.referrals r where r.referrer_id = p.id and r.status = 'rewarded') as invites_rewarded,
             (select coalesce(sum(r.reward_usd), 0) from public.referrals r where r.referrer_id = p.id and r.status = 'rewarded') as invites_earned_usd,
             (select count(*) from auth.sessions s where s.user_id = p.id) as live_sessions,
             (select u.last_sign_in_at from auth.users u where u.id = p.id) as last_sign_in_at,
             (select u.email_confirmed_at is not null from auth.users u where u.id = p.id) as email_confirmed,
             (select count(*) from public.api_keys k where k.user_id = p.id and k.status = 'active') as active_keys,
             (select count(*) from public.request_logs l where l.user_id = p.id and l.created_at > now() - interval '30 days') as requests_30d,
             (select coalesce(sum(l.cost_usd), 0) from public.request_logs l where l.user_id = p.id and l.created_at > now() - interval '30 days') as cost_30d,
             (select max(l.created_at) from public.request_logs l where l.user_id = p.id) as last_request_at
      from public.profiles p
      where public.is_admin()
      order by p.created_at desc;
    $v$;
  end if;
end $$;

-- ============================================================================
--  SETTINGS WRITER — let the admin panel save the referral knobs
-- ============================================================================
create or replace function public.admin_save_referral_settings(p_patch jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select email into v_email from public.profiles where id = auth.uid();

  update public.app_settings set
    referrals_enabled = coalesce((p_patch ->> 'referrals_enabled')::boolean, referrals_enabled),
    referral_reward_usd = coalesce(
      greatest(0, least(10000, (p_patch ->> 'referral_reward_usd')::numeric)), referral_reward_usd),
    referral_bonus_usd = coalesce(
      greatest(0, least(10000, (p_patch ->> 'referral_bonus_usd')::numeric)), referral_bonus_usd),
    referral_reward_on = coalesce(
      nullif(p_patch ->> 'referral_reward_on', ''), referral_reward_on),
    referral_max_per_user = coalesce(
      greatest(0, (p_patch ->> 'referral_max_per_user')::int), referral_max_per_user)
  where id = 1;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), v_email, 'save_referral_settings', 'app_settings', '1', p_patch);

  return (select to_jsonb(s) from (
    select referrals_enabled, referral_reward_usd, referral_bonus_usd,
           referral_reward_on, referral_max_per_user
    from public.app_settings where id = 1) s);
end $$;

-- public_settings is what the marketing pages read; surface the public bits
do $$
begin
  if exists (select 1 from information_schema.views
              where table_schema = 'public' and table_name = 'public_settings') then
    execute $v$
      drop view if exists public.public_settings cascade;
      create view public.public_settings as
      select id, brand_name, gateway_url, signup_enabled, default_policy,
             failover_enabled, max_failover_hops, log_retention_days,
             credits_enabled, signup_credit_usd, low_balance_usd, overdraft_usd,
             allowed_email_domains,
             referrals_enabled, referral_reward_usd, referral_bonus_usd
      from public.app_settings where id = 1;
      grant select on public.public_settings to anon, authenticated;
    $v$;
  end if;
end $$;

-- ============================================================================
--  RLS + GRANTS
-- ============================================================================
alter table public.referrals enable row level security;

drop policy if exists referrals_own   on public.referrals;
drop policy if exists referrals_admin on public.referrals;

-- an inviter reads their own invites; nobody writes this table from a browser
create policy referrals_own on public.referrals for select
  using (referrer_id = auth.uid() or referred_id = auth.uid() or public.is_admin());
create policy referrals_admin on public.referrals for all
  using (public.is_admin()) with check (public.is_admin());

grant select on public.referrals       to authenticated;
grant all    on public.referrals       to service_role;
grant select on public.my_referrals    to authenticated;
grant select on public.admin_referrals to authenticated;
grant select on public.admin_users     to authenticated;

grant execute on function public.my_referral()                              to authenticated;
grant execute on function public.admin_settle_referral(uuid)                to authenticated;
grant execute on function public.admin_void_referral(uuid, text)            to authenticated;
grant execute on function public.admin_force_signout(uuid)                  to authenticated;
grant execute on function public.admin_account_security(uuid)               to authenticated;
grant execute on function public.admin_log_recovery(uuid, text, jsonb)      to authenticated;
grant execute on function public.admin_save_referral_settings(jsonb)        to authenticated;

-- internals stay internal
revoke execute on function public.internal_referral_code()                   from anon, authenticated;
revoke execute on function public.internal_ensure_referral_code(uuid)        from anon, authenticated;
revoke execute on function public.internal_settle_referral(uuid, uuid, text) from anon, authenticated;
revoke execute on function public.internal_credits_installed()               from anon, authenticated;

-- ============================================================================
--  DONE
--  Next: deploy the recovery Edge Function (reset links + temp passwords):
--    supabase functions deploy admin-account --no-verify-jwt
-- ============================================================================
