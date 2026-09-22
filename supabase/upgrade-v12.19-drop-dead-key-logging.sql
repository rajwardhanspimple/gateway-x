-- ===========================================================================
--  v12.19 — stop logging a refusal that can never become a success
-- ---------------------------------------------------------------------------
--  SYMPTOM. The admin dashboard read 948 requests / 932 errors in 24h, "1.7%
--  served", with every log row 401 invalid_api_key. Spend was $0.00, so
--  nothing had reached an upstream.
--
--  CAUSE, measured. 1,139 of 1,143 refusals in that window came from ONE key:
--
--      name        aaaa
--      prefix      rr_live_…3275
--      key status  disabled
--      owner       suspended, 0 active keys
--      client      curl, every ~75 seconds, for 24 hours straight
--      total       2,847 requests against a dead key
--
--  The gateway was refusing it correctly. The problem is that since v12.17
--  every refusal AFTER authentication is logged, so a client looping on a dead
--  key writes a row per attempt. That change was right — before it, a revoked
--  key vanished without a trace and the panel under-reported real traffic — but
--  it did not distinguish a refusal worth recording from one that can never
--  become anything else.
--
--  WHY NOT THE OBVIOUS FIXES.
--
--  Ban the IP: the address was 2a06:98c0:3600::103, which is Cloudflare's
--  shared proxy. Every user's traffic arrives from it (see
--  upgrade-v12.18 and the clientIpOf fix), so denying it would lock out the
--  whole gateway. An earlier manual ban on exactly that address was found on
--  blocked_ips and removed for this reason.
--
--  Change the key's status: `revoked` and `disabled` both fall into the same
--  `status <> 'active'` branch in the router, which is the branch that logs.
--  Relabelling changes the message and nothing else.
--
--  FIX. internal_auth_key stops returning a row when the key is not active AND
--  its owner is not active either. The router's `if (authErr || !authData)`
--  check then refuses with the same 401 invalid_api_key BEFORE reaching the
--  logging branch, so the loop gets an identical answer and writes nothing.
--
--  The condition is deliberately narrow:
--
--      not (p.status <> 'active' and k.status <> 'active')
--
--  Both halves must be true to drop the row. So:
--
--    active key,   active user      -> returned, normal path, unchanged
--    revoked key,  ACTIVE user      -> returned, still logged. This matters:
--                                      a live customer who revoked a key and
--                                      has a stale client deserves to see
--                                      those attempts in their own log.
--    active key,   suspended user   -> returned, still logged, and refused by
--                                      the router's separate user_status check
--                                      with account_suspended. A suspended
--                                      customer's real traffic stays visible.
--    dead key,     suspended user   -> DROPPED. Nobody is coming back from
--                                      this combination, and nobody is
--                                      watching the log for it.
--
--  Four keys in the database match the dropped case today, all belonging to
--  suspended accounts.
--
--  Run:  psql "$DATABASE_URL" -f supabase/upgrade-v12.19-drop-dead-key-logging.sql
-- ===========================================================================

create or replace function public.internal_auth_key(p_key_hash text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'api_key_id',        k.id,
    'user_id',           k.user_id,
    'name',              k.name,
    'environment',       k.environment,
    'status',            k.status,
    'allowed_models',    k.allowed_models,
    'rate_limit_rpm',    k.rate_limit_rpm,
    'monthly_budget_usd',k.monthly_budget_usd,
    'spend_usd',         k.spend_usd,
    'expires_at',        k.expires_at,
    'user_status',       p.status,
    'user_budget_usd',   p.monthly_budget_usd,
    'credits_enabled',   coalesce((select s.credits_enabled from public.app_settings s where s.id = 1), false),
    'credit_balance_usd',coalesce(p.credit_balance_usd, 0),
    'credit_overdraft_usd', coalesce((select s.overdraft_usd from public.app_settings s where s.id = 1), 0),
    'month_spend_usd',   coalesce((
        select sum(l.cost_usd) from public.request_logs l
        where l.api_key_id = k.id
          and l.created_at >= date_trunc('month', now())), 0)
  )
  from public.api_keys k
  join public.profiles p on p.id = k.user_id
  where k.key_hash = p_key_hash
    -- A dead key on a dead account is unrecoverable: refuse it before the
    -- router's logging branch rather than writing a row per retry forever.
    and not (p.status <> 'active' and k.status <> 'active');
$$;

-- ---------------------------------------------------------------------------
--  Verify. Every key whose owner is not active, and whether the router now
--  refuses it early. Expect true only where BOTH the key and the owner are
--  inactive:
--
--    select k.name, k.status as key_status, p.status as user_status,
--           (public.internal_auth_key(k.key_hash) is null) as rejected_early
--      from public.api_keys k
--      join public.profiles p on p.id = k.user_id
--     where p.status <> 'active';
--
--  And confirm a live key is untouched — expect false for every row:
--
--    select count(*) as live_keys_wrongly_dropped
--      from public.api_keys k
--      join public.profiles p on p.id = k.user_id
--     where k.status = 'active' and p.status = 'active'
--       and public.internal_auth_key(k.key_hash) is null;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
--  NOT DONE HERE, and still outstanding: the router's clientIpOf() prefers
--  cf-connecting-ip over x-rs-client-ip, so every request is still logged with
--  Cloudflare's shared address. cloudflare/worker.js was fixed in adea30c and
--  RS_EDGE_SECRET is set on both sides, but until the router prefers the header
--  the Worker sends, the per-IP rate limit remains one bucket shared by every
--  user and the key-sharing guard can never fire. See
--  supabase/functions/router/index.ts around line 66.
-- ---------------------------------------------------------------------------
