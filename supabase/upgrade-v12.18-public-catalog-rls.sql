-- ===========================================================================
--  v12.18 — the public model catalog was invisible to the public
-- ---------------------------------------------------------------------------
--  SYMPTOM. The #/models page showed "7 MODELS AVAILABLE" in its stat tiles
--  directly above "0 OF 0 MODELS" and a "Loading the model catalog..." panel
--  that never resolved. Both numbers were correct: the tiles were counting the
--  seven built-in fixtures in src/ragestar/dashboard/data.js, and the list was
--  correctly reporting that it could see zero rows. The database genuinely has
--  seven published models, which made the coincidence convincing.
--
--  CAUSE. public.public_models carried `security_invoker = on`, set by
--  upgrade-v5.6-lints-and-ip.sql to satisfy a Supabase linter. A
--  security_invoker view runs with the CALLER's permissions, so row-level
--  security on the underlying tables applies to whoever is querying. The only
--  policies on public.models and public.upstreams are:
--
--      models_admin      to authenticated   using is_admin()
--      upstreams_admin   to authenticated   using is_admin()
--
--  There is no policy for `anon` at all, and RLS denies by default. So the
--  view returned zero rows to every signed-out visitor and every non-admin
--  user. The GRANT SELECT to anon was present and irrelevant: a grant gets you
--  to the relation, RLS then decides the rows.
--
--  Crucially the query SUCCEEDED and returned an empty array, so nothing threw
--  and there was no console error or failed request to find.
--
--  WHY NOT JUST ADD A READ POLICY. The obvious fix is a policy letting anon
--  read active models. But the view's own WHERE clause reaches into
--  public.upstreams (`exists (... u.is_active)`), so anon would need SELECT on
--  that table too — and public.upstreams holds `name`, `base_url`,
--  `auth_header` and `extra_headers`. The router's contract, stated at the top
--  of supabase/functions/router/index.ts, is:
--
--      "The caller never receives the upstream host, name, model id, or key."
--
--  Granting anon read on upstreams would expose precisely what this product
--  exists to hide. A policy on that table is the wrong tool.
--
--  FIX. Turn the view back into a definer view. It then reads models and
--  upstreams with the owner's rights, applies its own WHERE clause, and
--  returns only its own seven columns — id, name, description, context window,
--  max output tokens, the two prices, capabilities, status, is_default,
--  sort_order. No upstream identity crosses the boundary, which is the same
--  guarantee the view was written to provide.
--
--  This is the correct shape for a curated public projection over private
--  tables, and it is why the view existed in the first place. The linter that
--  prompted the v5.6 change flags security_invoker=off as something to review,
--  not something that is always wrong; a deliberate definer view with a
--  narrow column list is the documented exception.
--
--  Run:  psql "$DATABASE_URL" -f supabase/upgrade-v12.18-public-catalog-rls.sql
-- ===========================================================================

alter view public.public_models set (security_invoker = off);

-- The grant is what lets an anonymous browser reach the view at all; the
-- definer semantics above are what let it see rows. Re-asserted so a fresh
-- database reaches the same state regardless of migration order.
grant select on public.public_models to anon, authenticated;

-- ---------------------------------------------------------------------------
--  The two sibling views have the same shape and the same exposure question.
--
--  route_health aggregates request_logs per model and deliberately leaks no
--  upstream identity ("No upstream identity leaks" — schema.sql). It is read by
--  the public status page and by the landing page's live figures, both of which
--  a signed-out visitor sees, and request_logs carries per-user rows under its
--  own RLS. Same reasoning, same fix.
--
--  gateway_daily_health is a pure per-day aggregate over the same table.
-- ---------------------------------------------------------------------------

alter view public.route_health set (security_invoker = off);
alter view public.gateway_daily_health set (security_invoker = off);

grant select on public.route_health to anon, authenticated;
grant select on public.gateway_daily_health to anon, authenticated;

-- ---------------------------------------------------------------------------
--  Verify. As any role, including anon from the browser:
--
--    select count(*) from public.public_models;      -- expect the live count
--    select count(*) from public.route_health;       -- expect one row per model
--
--  And confirm the private tables stayed private — both must still show only
--  the admin policy, and no policy naming anon:
--
--    select tablename, policyname, roles::text
--      from pg_policies
--     where schemaname = 'public'
--       and tablename in ('models', 'upstreams');
-- ---------------------------------------------------------------------------
