-- ============================================================================
--  RageStar — upgrade to v12.16  "request logs attribution"
--  Paste this whole file into the Supabase SQL editor and press Run.
--  Idempotent: re-running changes nothing that is already correct.
--
--  WHAT THIS DOES
--    The admin panel's "Request logs" tab listed every routed call — when, the
--    request id, model, HTTP status, latency, tokens, cost, failover and error
--    code — but never said WHICH user made the request. request_logs carries
--    user_id (a uuid), so the identity was present in the row yet invisible in
--    the UI, and a uuid is not a person.
--
--    This adds public.admin_request_logs: the SAME request_logs columns, with
--    two read-only additions joined in from profiles —
--
--        user_email  text   the requester's email   (null when unknown)
--        user_name   text   their full_name         (null when unknown)
--
--    and user_id, which request_logs already had. Every existing column keeps
--    its name and meaning, so the tab and every other reader are unaffected.
--
--  HOW IT IS LOCKED DOWN
--    This is an ADMIN READ, so it copies the exact shape of the other admin
--    reads (admin_users, admin_credit_ledger): a security_invoker view gated by
--    `where (select public.is_admin())` and granted to authenticated only.
--    A non-admin authenticated user can issue the select but the predicate
--    yields ZERO rows — never somebody else's email; anon is revoked outright.
--    The base tables still enforce their own RLS underneath
--    (request_logs_admin / profiles_self_read), so this view only ever widens
--    what an admin already saw by hand.
--
--  SIGNATURES
--    No function is redefined, so no overload can be left behind. The only new
--    object is the view public.admin_request_logs. `drop view ... cascade` is
--    used before `create view` so a re-run — or a column change — is clean.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The view — request_logs * columns + the requester's identity
-- ----------------------------------------------------------------------------
drop view if exists public.admin_request_logs cascade;

create view public.admin_request_logs with (security_invoker = on) as
select l.*,
       pr.email     as user_email,
       pr.full_name as user_name
from public.request_logs l
left join public.profiles pr on pr.id = l.user_id
where (select public.is_admin())
order by l.created_at desc;

-- ----------------------------------------------------------------------------
-- 2. Grants — admins ask through `authenticated`; anon gets nothing
-- ----------------------------------------------------------------------------
revoke all on public.admin_request_logs from anon;
grant  select on public.admin_request_logs to authenticated;
grant  select on public.admin_request_logs to service_role;

-- PostgREST caches the view list; without this the new view is not callable
-- from the browser until the next schema reload.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFY — eyeball these before walking away
--   admin_request_logs_exists     true   the view is there
--   admin_request_logs_columns    2      user_email + user_name are exposed
--   anon_can_read                 false  the public cannot select it
--   authenticated_can_read        true   the admin panel can ask (rows gated by is_admin())
-- ----------------------------------------------------------------------------
select
  to_regclass('public.admin_request_logs') is not null as admin_request_logs_exists,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'admin_request_logs'
       and column_name in ('user_email', 'user_name'))   as admin_request_logs_columns,
  has_table_privilege('anon',          'public.admin_request_logs', 'select') as anon_can_read,
  has_table_privilege('authenticated', 'public.admin_request_logs', 'select') as authenticated_can_read;
