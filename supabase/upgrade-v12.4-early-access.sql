-- ===========================================================================
--  RageStar gateway — upgrade v12.4: early access role + gated models
--  ---------------------------------------------------------------------
--  Adds a third account role between "user" and "admin":
--
--      user          the default. Sees and calls public models only.
--      early_access  sees and calls public models AND models marked
--                    access_tier = 'early_access'.
--      admin         everything, as before. Admins always have early access.
--
--  Models gain an access_tier column. A model marked 'early_access' is
--  hidden from (and refused to) anyone without the role — in the browser
--  catalogue, in GET /v1/models, and at routing time inside the router
--  Edge Function, so a hand-written curl cannot reach it either.
--
--  Safe to run more than once. Apply after upgrade-v12.3-community-plus.sql.
-- ===========================================================================

begin;

-- ============================================================ 1. the role ==
-- profiles.role was checked against ('user','admin'); widen it.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('user','early_access','admin'));

comment on column public.profiles.role is
  'user | early_access | admin. early_access unlocks models whose access_tier is early_access.';

-- ===================================================== 2. gated model flag ==
alter table public.models
  add column if not exists access_tier text not null default 'public',
  add column if not exists access_note text;

alter table public.models drop constraint if exists models_access_tier_check;
alter table public.models
  add constraint models_access_tier_check
  check (access_tier in ('public','early_access'));

comment on column public.models.access_tier is
  'public = everyone. early_access = only accounts with role early_access or admin.';
comment on column public.models.access_note is
  'Optional line shown next to a locked model, e.g. "joining the beta group".';

create index if not exists models_access_tier_idx
  on public.models (access_tier, is_active, sort_order);

-- Should locked models still be listed (greyed out, as a teaser) to accounts
-- that cannot call them? Default yes — people ask for what they can see.
alter table public.app_settings
  add column if not exists early_access_teaser boolean not null default true;

-- ================================================== 3. entitlement helpers ==
-- Mirrors public.is_admin(): a suspended account is entitled to nothing.
create or replace function public.is_early_access(p_uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_uid
       and p.status = 'active'
       and p.role in ('early_access','admin')
  );
$$;

-- Convenience for the browser: 'public' or 'early_access' for the caller.
create or replace function public.my_access_tier()
returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_early_access() then 'early_access' else 'public' end;
$$;

-- Can this account call this public model id?
create or replace function public.can_use_model(p_public_id text, p_uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select m.access_tier = 'public' or public.is_early_access(p_uid)
      from public.models m
     where m.public_id = p_public_id
  ), false);
$$;

-- ============================================== 4. public model catalogue ==
-- Replaces the v5.6 definer function behind the public_models view. Two new
-- columns: access_tier and locked. "locked" is what the UI greys out.
drop view if exists public.public_models cascade;
drop function if exists public.fn_public_models();

create function public.fn_public_models()
returns table (
  id                text,
  name              text,
  description       text,
  context_window    int,
  max_output_tokens int,
  price_in_per_m    numeric,
  price_out_per_m   numeric,
  capabilities      text[],
  status            text,
  is_default        boolean,
  sort_order        int,
  access_tier       text,
  locked            boolean,
  access_note       text
)
language sql stable security definer set search_path = public as $$
  with me as (
    select public.is_early_access() as entitled
  ), cfg as (
    select coalesce((select s.early_access_teaser from public.app_settings s limit 1), true) as teaser
  )
  select m.public_id, m.display_name, m.description, m.context_window,
         m.max_output_tokens, m.price_in_per_m, m.price_out_per_m,
         m.capabilities, m.status, m.is_default, m.sort_order,
         m.access_tier,
         (m.access_tier <> 'public' and not me.entitled) as locked,
         m.access_note
    from public.models m, me, cfg
   where m.is_active
     and m.status <> 'disabled'
     and exists (select 1 from public.upstreams u
                  where u.id = m.upstream_id and u.is_active)
     and (m.access_tier = 'public' or me.entitled or cfg.teaser);
$$;

create view public.public_models with (security_invoker = on) as
  select * from public.fn_public_models();

-- =========================================== 5. admin: grant / revoke role ==
-- Same guarantees as before (admin only, no self-demotion), one more role.
create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_role not in ('user','early_access','admin') then
    raise exception 'Invalid role %', p_role;
  end if;
  if p_role <> 'admin' and p_user_id = auth.uid() then
    raise exception 'You cannot remove your own admin access';
  end if;

  update public.profiles set role = p_role where id = p_user_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'set_user_role', 'profiles', p_user_id::text, jsonb_build_object('role', p_role));
end $$;

-- Toggle helper so the dashboard can flip one account without a role menu.
create or replace function public.admin_set_early_access(p_user_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select role into v_role from public.profiles where id = p_user_id;
  if v_role is null then
    raise exception 'No such account';
  end if;
  -- admins already have early access; never quietly demote one here
  if v_role = 'admin' then
    return;
  end if;

  perform public.admin_set_user_role(p_user_id, case when p_on then 'early_access' else 'user' end);
end $$;

-- ======================================== 6. admin: mark a model as gated ==
create or replace function public.admin_set_model_access(
  p_model_id uuid,
  p_tier     text,
  p_note     text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_tier not in ('public','early_access') then
    raise exception 'Invalid access tier %', p_tier;
  end if;

  update public.models
     set access_tier = p_tier,
         access_note = coalesce(p_note, access_note)
   where id = p_model_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          'set_model_access', 'models', p_model_id::text,
          jsonb_build_object('access_tier', p_tier));
end $$;

-- Read + write the teaser switch without touching the settings views.
create or replace function public.early_access_config()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'teaser', coalesce((select s.early_access_teaser from public.app_settings s limit 1), true),
    'tier',   public.my_access_tier(),
    'models', coalesce((select count(*) from public.models m
                         where m.access_tier = 'early_access' and m.is_active), 0)
  );
$$;

create or replace function public.admin_save_early_access(p_teaser boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  update public.app_settings set early_access_teaser = coalesce(p_teaser, true), updated_at = now();
  return public.early_access_config();
end $$;

-- ================================================ 7. router-side enforcement ==
-- The router runs as service_role, so auth.uid() is null there: entitlement
-- has to be looked up from the key's owner. Both functions are service-role
-- only, in the style of the other internal_* RPCs.
create or replace function public.internal_access_context(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', coalesce((select p.role from public.profiles p where p.id = p_user_id), 'user'),
    'early_access', public.is_early_access(p_user_id),
    'restricted', coalesce((
      select jsonb_agg(m.public_id order by m.public_id)
        from public.models m
       where m.access_tier <> 'public'
         and not public.is_early_access(p_user_id)
    ), '[]'::jsonb)
  );
$$;

-- GET /v1/models for one caller: the same shape the router used to read from
-- public_models, minus anything the account is not entitled to.
create or replace function public.internal_models_for_user(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.id), '[]'::jsonb)
    from (
      select m.public_id        as id,
             m.display_name     as name,
             m.description      as description,
             m.context_window   as context_window,
             m.max_output_tokens as max_output_tokens,
             m.price_in_per_m   as price_in_per_m,
             m.price_out_per_m  as price_out_per_m,
             m.capabilities     as capabilities,
             m.status           as status,
             m.access_tier      as access_tier,
             m.sort_order       as sort_order
        from public.models m
        join public.upstreams u on u.id = m.upstream_id and u.is_active
       where m.is_active
         and m.status <> 'disabled'
         and (m.access_tier = 'public' or public.is_early_access(p_user_id))
    ) x;
$$;

-- ===================================================== 8. grants / revokes ==
grant execute on function public.is_early_access(uuid)          to anon, authenticated, service_role;
grant execute on function public.my_access_tier()               to anon, authenticated, service_role;
grant execute on function public.can_use_model(text, uuid)      to anon, authenticated, service_role;
grant execute on function public.fn_public_models()             to anon, authenticated, service_role;
grant execute on function public.early_access_config()          to anon, authenticated, service_role;
grant execute on function public.admin_set_user_role(uuid, text)             to authenticated;
grant execute on function public.admin_set_early_access(uuid, boolean)       to authenticated;
grant execute on function public.admin_set_model_access(uuid, text, text)    to authenticated;
grant execute on function public.admin_save_early_access(boolean)            to authenticated;
grant select on public.public_models to anon, authenticated, service_role;

revoke execute on function public.internal_access_context(uuid)    from anon, authenticated;
revoke execute on function public.internal_models_for_user(uuid)   from anon, authenticated;
grant  execute on function public.internal_access_context(uuid)    to service_role;
grant  execute on function public.internal_models_for_user(uuid)   to service_role;

commit;

-- ===========================================================================
--  Cheat sheet
--  -----------
--  Give someone early access:
--    select public.admin_set_user_role('<user-uuid>', 'early_access');
--
--  Put a model behind it:
--    update public.models
--       set access_tier = 'early_access',
--           access_note = 'Beta group only'
--     where public_id = 'rs-preview';
--
--  Check what an account would see:
--    select public.internal_models_for_user('<user-uuid>');
-- ===========================================================================
