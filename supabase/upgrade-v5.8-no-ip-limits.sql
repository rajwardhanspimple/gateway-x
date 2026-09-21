-- ============================================================================
--  RageStar — v5.8  ·  Turn IP limiting OFF (login + gateway)
-- ----------------------------------------------------------------------------
--  Run ONCE in Supabase Dashboard -> SQL Editor -> New query.
--  Idempotent: re-running it is harmless. Nothing is dropped, so v5.6 / v5.7
--  can be switched back on later with admin_save_ip_settings() or the
--  Admin -> IP limits screen.
--
--  READ THIS FIRST — WHERE IP LIMITS ACTUALLY APPLY
--    Sign-in / sign-up / magic links / password resets never touch any IP rule
--    in this repository. public.internal_ip_check(api_key_id, ip) is called by
--    supabase/functions/router only, AFTER an rs_live_ API key has been
--    authenticated, so it cannot run for a browser login (there is no API key
--    in that request). The browser login path is:
--        src/pages/Login.jsx -> src/lib/auth.js -> Supabase Auth (GoTrue)
--    The only IP-based throttling a login can hit is GoTrue's own built-in
--    rate limiting, which is a project setting, not SQL:
--        Dashboard -> Authentication -> Rate Limits
--          · "Sign in / sign up"  (per IP, per 5 min)
--          · "Token refresh"      (per IP, per 5 min)
--    See also [auth.rate_limit] in supabase/config.toml.
--
--  "email rate limit exceeded" ON /auth/v1/invite IS NOT AN IP LIMIT
--    That is GoTrue's email quota. A project on Supabase's built-in (shared)
--    SMTP can only send a couple of auth emails per hour, and every invite,
--    confirmation, magic link and password reset counts against it. Fixes:
--      1. Create the account directly, no email at all:
--           node scripts/create-user.mjs someone@gmail.com 'TempPass123!'
--      2. Or configure your own SMTP (Resend / SES / Postmark / Brevo) under
--         Dashboard -> Authentication -> Emails -> SMTP Settings, then raise
--         Dashboard -> Authentication -> Rate Limits -> "Emails sent per hour".
--      3. Or just wait out the hour window.
--    Remember the v5.5 trigger on auth.users: the address must be on
--    app_settings.allowed_email_domains (default @gmail.com) or the invite
--    fails regardless of quota.
--
--  WHAT THIS FILE DOES
--    · master switch off                 app_settings.ip_limits_enabled = false
--    · every ceiling to 0 (= unlimited)  rpm, rph, distinct/hour, accounts/IP
--    · allowlist-required off            keys no longer must declare IPs
--    · workspace denylist emptied
--    · auto-created bans deleted         blocked_ips where source = 'auto'
--    · rate counters cleared             ip_rate_buckets truncated
--    Addresses are still RECORDED in ip_registry / request_logs.client_ip so
--    Admin -> IP limits stays useful for forensics. Nothing is enforced.
--
--  Written to survive a database that skipped v5.6 or v5.7: every column and
--  table is probed before it is touched.
-- ============================================================================

begin;

-- ===========================================================================
-- 1. app_settings — master switch off, all ceilings unlimited
-- ===========================================================================

do $$
declare
  v_pairs text[][] := array[
    ['ip_limits_enabled',        'false'],
    ['ip_allowlist_required',    'false'],
    ['ip_rate_limit_rpm',        '0'],
    ['ip_rate_limit_rph',        '0'],
    ['ip_max_distinct_per_hour', '0'],
    ['ip_max_accounts_per_ip',   '0'],
    ['ip_autoblock_minutes',     '0'],
    ['ip_denylist',              '''{}''::text[]']
  ];
  i int;
  v_done int := 0;
begin
  if to_regclass('public.app_settings') is null then
    raise notice 'public.app_settings does not exist — run schema.sql first.';
    return;
  end if;

  for i in 1 .. array_length(v_pairs, 1) loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name   = 'app_settings'
         and column_name  = v_pairs[i][1]
    ) then
      execute format('update public.app_settings set %I = %s where id = 1',
                     v_pairs[i][1], v_pairs[i][2]);
      v_done := v_done + 1;
    end if;
  end loop;

  raise notice 'IP enforcement disabled: % setting(s) reset.', v_done;
end $$;


-- ===========================================================================
-- 2. Drop the bans this system created for itself, and the live counters
-- ---------------------------------------------------------------------------
--  Manual bans (source = 'manual') are left alone on purpose: those were a
--  deliberate decision by an admin. Uncomment the second statement to clear
--  those too.
-- ===========================================================================

do $$
begin
  if to_regclass('public.blocked_ips') is not null then
    delete from public.blocked_ips where source = 'auto';
    -- delete from public.blocked_ips;            -- also drop manual bans
    raise notice 'Auto-created IP bans cleared.';
  end if;

  if to_regclass('public.ip_rate_buckets') is not null then
    delete from public.ip_rate_buckets;
    raise notice 'Per-IP rate counters cleared.';
  end if;
end $$;


-- ===========================================================================
-- 3. Optional escape hatches — uncomment only if you want them
-- ===========================================================================

-- Every existing account permanently exempt, even if the master switch is
-- turned back on later:
-- update public.profiles set ip_limit_exempt = true;

-- Release per-key IP locks that key owners set themselves (Console -> Keys ->
-- IP rules). These are NOT governed by the master switch: a non-empty
-- api_keys.allowed_ips always applies.
-- update public.api_keys set allowed_ips = '{}' where cardinality(allowed_ips) > 0;

-- Your own offices / CI runners, allowed past every rule including bans:
-- update public.app_settings set ip_exempt_ips = array['203.0.113.7','198.51.100.0/24'] where id = 1;


-- ===========================================================================
-- 4. Verify — prints every ip_* setting that exists, whatever your version
-- ===========================================================================

select jsonb_pretty(jsonb_object_agg(e.key, e.value)) as ip_settings_now
from public.app_settings s,
     jsonb_each(to_jsonb(s)) as e
where s.id = 1
  and e.key like 'ip\_%';

commit;

-- ---------------------------------------------------------------------------
--  To re-enable later (from the panel: Admin -> IP limits -> Enforce = yes):
--    select public.admin_save_ip_settings('{
--      "ip_limits_enabled": true,
--      "ip_rate_limit_rpm": 120,
--      "ip_rate_limit_rph": 3000
--    }'::jsonb);
-- ---------------------------------------------------------------------------
