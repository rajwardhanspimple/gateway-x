-- ============================================================================
--  RageStar — upgrade to v12.11
--  Paste this whole file into the Supabase SQL editor and press Run.
--
--  WHAT THIS ADDS
--   1. create_api_key() now accepts p_expires_at, so the "Create API key"
--      dialog can mint a key that stops working on a chosen date.
--   2. set_api_key_expiry() changes or clears that date afterwards.
--
--  WHY IT WAS NEEDED
--     public.api_keys.expires_at and the my_api_keys view have carried the
--     column since v5.4, and the router has always refused an expired key
--     ("API key has expired." → 401). Nothing could ever *set* it, so the
--     column was dead weight and every key was effectively immortal.
--
--  WHY THE OLD FUNCTION IS DROPPED FIRST
--     PostgREST picks an RPC by name and named arguments. Leaving both
--     create_api_key(text, text, numeric) and
--     create_api_key(text, text, numeric, timestamptz) behind gives it two
--     candidates and the console starts failing with an ambiguity error —
--     the exact bug v5.4 fixed. Drop, then create.
--
--  NOTE ON COMPATIBILITY
--     The parameter is defaulted, and the dashboard only sends p_expires_at
--     when the user actually picks a date. An un-migrated database therefore
--     keeps minting keys as before; only the expiry feature needs this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. create_api_key — now with an optional expiry
-- ----------------------------------------------------------------------------
drop function if exists public.create_api_key(text, text, numeric, timestamptz);
drop function if exists public.create_api_key(text, text, numeric);
drop function if exists public.create_api_key(text, text);
drop function if exists public.create_api_key(text);
drop function if exists public.create_api_key();

create function public.create_api_key(
  p_name               text default 'default',
  p_environment        text default 'live',
  p_monthly_budget_usd numeric default null,
  p_expires_at         timestamptz default null
)
returns table (
  id uuid, name text, api_key text, key_prefix text,
  key_last4 text, environment text, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid := auth.uid();
  v_env     text := lower(coalesce(nullif(trim(p_environment), ''), 'live'));
  v_name    text := coalesce(nullif(trim(p_name), ''), 'default');
  v_status  text;
  v_active  int;
  v_prefix  text;
  v_full    text;
  v_id      uuid;
  v_created timestamptz;
begin
  if v_user is null then
    raise exception 'Not authenticated. Sign in again and retry.'
      using errcode = '42501';
  end if;

  if v_env not in ('live', 'test') then
    raise exception 'environment must be live or test';
  end if;

  -- Expiry is optional, but a date already in the past would mint a key that
  -- the router rejects on its very first call. Refuse it here instead.
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future.';
  end if;

  -- account state (alias-qualified: pr.id, never bare id)
  select pr.status into v_status
  from public.profiles pr
  where pr.id = v_user;

  if v_status is null then
    -- profile row missing (signup trigger never ran) — create it now so the
    -- console is not permanently blocked
    insert into public.profiles (id, email, full_name)
    select v_user,
           coalesce(u.email, ''),
           nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '')
    from auth.users u
    where u.id = v_user
    on conflict (id) do nothing;
    v_status := 'active';
  end if;

  if v_status = 'suspended' then
    raise exception 'This account is suspended, so new keys cannot be issued.'
      using errcode = '42501';
  end if;

  select count(*) into v_active
  from public.api_keys k
  where k.user_id = v_user
    and k.status = 'active';

  if v_active >= 25 then
    raise exception 'Key limit reached (25 active keys). Revoke one first.';
  end if;

  -- rs_live_ / rs_test_ + 40 hex chars (160 bits from two v4 UUIDs)
  v_prefix := 'rr_' || v_env || '_';
  v_full   := v_prefix || substr(replace(gen_random_uuid()::text, '-', '') ||
                                replace(gen_random_uuid()::text, '-', ''), 1, 40);

  insert into public.api_keys as k
    (user_id, name, environment, key_prefix, key_last4, key_hash,
     monthly_budget_usd, expires_at)
  values
    (v_user, v_name, v_env, v_prefix, right(v_full, 4),
     encode(sha256(v_full::bytea), 'hex'),
     p_monthly_budget_usd, p_expires_at)
  returning k.id, k.created_at into v_id, v_created;

  return query
    select v_id, v_name, v_full, v_prefix, right(v_full, 4), v_env, v_created;
end $$;

grant execute on function public.create_api_key(text, text, numeric, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. set_api_key_expiry — change (or clear) a key's expiry after it was minted
-- ----------------------------------------------------------------------------
create or replace function public.set_api_key_expiry(
  p_key_id     uuid,
  p_expires_at timestamptz
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future.';
  end if;

  update public.api_keys
     set expires_at = p_expires_at
   where id = p_key_id
     and (user_id = auth.uid() or public.is_admin());
  if not found then
    raise exception 'Key not found' using errcode = '42501';
  end if;
end $$;

grant execute on function public.set_api_key_expiry(uuid, timestamptz) to authenticated;

-- PostgREST caches the function list; without this the new signature is not
-- visible until the next schema reload.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- what you should see: create_api_key = 1 row (the 4-argument one), and
-- set_api_key_expiry present.
-- ---------------------------------------------------------------------------
select 'v12.11 applied' as result,
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'create_api_key')   as create_api_key_fns,
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'set_api_key_expiry') as set_expiry_fns,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'api_keys'
           and column_name = 'expires_at')                              as expires_at_cols;
