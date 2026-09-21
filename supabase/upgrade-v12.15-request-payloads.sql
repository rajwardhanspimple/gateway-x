-- ============================================================================
--  RageStar — upgrade to v12.15  "request payloads"
--  Paste this whole file into the Supabase SQL editor and press Run.
--  Idempotent: re-running changes nothing that is already correct.
--
--  WHAT THIS DOES
--    request_logs has always recorded METADATA for every gateway call: who,
--    which key, which model, tokens, cost, latency, ok/failed. It deliberately
--    never held the conversation itself, so nothing could answer "what did this
--    request actually ask, and what came back?".
--
--    1. public.request_payloads — one row per routed request, carrying the raw
--       request JSON the caller sent and the response content that came back
--       (the raw response JSON for a normal call; the concatenated assistant
--       text for a streamed one). `request_id` matches request_logs.request_id,
--       so a payload can always be tied back to its log line.
--
--    2. public.internal_log_request() learns to write it. Two arguments are
--       APPENDED to the existing parameter list — p_request_body and
--       p_response_text — and, once the request_logs row is in hand, the
--       function upserts one request_payloads row for that request whenever
--       either text is present. Its return value is unchanged (the new log id).
--       Calls that never reached a model (auth / gate / IP / budget refusals)
--       pass neither text, so they write no payload — a refusal has no
--       conversation to store.
--
--  SIZE, AND WHY IT IS CLAMPED IN THE ROUTER
--    The router clamps each side to MAX_STORED_PAYLOAD_BYTES (default 256 KB per
--    side, see supabase/functions/_shared/cors.ts) BEFORE calling the RPC, so a
--    multi-megabyte body is never shipped to Postgres only to be cut here. A
--    clamped row keeps the ORIGINAL byte count in request_bytes / response_bytes
--    and sets truncated = true, so the loss is visible rather than silent.
--
--  SIGNATURES
--    old: internal_log_request(p_payload jsonb)
--    new: internal_log_request(p_payload jsonb,
--                              p_request_body text default null,
--                              p_response_text text default null)
--    The old one-argument version is DROPPED first. `create or replace` would
--    otherwise leave it in place as a second overload, and PostgREST's
--    named-argument call (which the router makes) would then be ambiguous.
--
--  ACCESS
--    Writes come only from the router, which runs as service_role and bypasses
--    RLS. request_payloads gets RLS with a single SELECT policy: an account may
--    read its own rows (user_id = auth.uid()), and an admin may read any. There
--    is deliberately no INSERT/UPDATE/DELETE policy — nobody but the service
--    role can write, and nobody can rewrite history from the browser.
--
--  Run after upgrade-v12.14-privacy-acceptance.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. the payload table
-- ----------------------------------------------------------------------------
create table if not exists public.request_payloads (
  id               uuid primary key default gen_random_uuid(),
  /* The router's request id, the same value request_logs.request_id carries.
     Unique: one stored conversation per call. */
  request_id       text not null unique,
  /* The request_logs row this payload belongs to, when it could be resolved.
     Cascades so a pruned log takes its payload with it rather than orphaning
     prompt/completion text. */
  log_id           uuid references public.request_logs (id) on delete cascade,
  user_id          uuid references auth.users (id) on delete set null,
  api_key_id       uuid references public.api_keys (id) on delete set null,
  model_public_id  text,
  /* The raw request JSON exactly as the caller sent it. */
  request_body     text,
  /* Non-streaming: the raw response JSON. Streaming: the concatenated assistant
     text that was streamed back. */
  response_text    text,
  /* ORIGINAL sizes in bytes, recorded even when the stored text was clamped. */
  request_bytes    integer,
  response_bytes   integer,
  truncated        boolean not null default false,
  streamed         boolean not null default false,
  created_at       timestamptz not null default now()
);

comment on table public.request_payloads is
  'The stored request/response pair for one routed call (v12.15). request_id matches request_logs.request_id. Written only by internal_log_request() as service_role; read by the owning account (or an admin) through RLS.';

comment on column public.request_payloads.request_bytes is
  'Original request size in bytes, before any clamp. Larger than octet_length(request_body) only when truncated is true.';

comment on column public.request_payloads.response_bytes is
  'Original response size in bytes, before any clamp. Larger than octet_length(response_text) only when truncated is true.';

-- The unique constraint above already indexes request_id; this is the ordering
-- index the console needs (newest first, per account).
create index if not exists request_payloads_user_idx
  on public.request_payloads (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 2. RLS — owner or admin may read; only service_role may write
-- ----------------------------------------------------------------------------
alter table public.request_payloads enable row level security;

drop policy if exists request_payloads_select_own on public.request_payloads;
create policy request_payloads_select_own on public.request_payloads
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- service_role bypasses RLS; these cover PostgREST's role checks, not row
-- access. No INSERT/UPDATE/DELETE policy exists on purpose.
grant select on public.request_payloads to authenticated;
grant all    on public.request_payloads to service_role;

-- ----------------------------------------------------------------------------
-- 3. internal_log_request() — store the payload alongside the log row
-- ----------------------------------------------------------------------------
/* The old one-argument function must go before the new one is created, or the
   two overloads coexist and a named-argument call cannot tell them apart. */
drop function if exists public.internal_log_request(jsonb);

create or replace function public.internal_log_request(
  p_payload jsonb,
  p_request_body text default null,
  p_response_text text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_user  uuid := nullif(p_payload ->> 'user_id', '')::uuid;
  v_key   uuid := nullif(p_payload ->> 'api_key_id', '')::uuid;
  v_cost  numeric(12,6) := coalesce(nullif(p_payload ->> 'cost_usd', '')::numeric, 0);
  v_req   text := coalesce(p_payload ->> 'request_id',
                  'req_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
  v_ecode text := nullif(p_payload ->> 'error_code', '');
  v_gate  boolean := coalesce((p_payload ->> 'community_gate_denied')::boolean, false)
                     or v_ecode in ('community_checkin_required', 'community_participation_required');
begin
  insert into public.request_logs (
    request_id, user_id, api_key_id, model_public_id, policy,
    upstream_id, upstream_key_id, ok, status_code, latency_ms,
    tokens_in, tokens_out, cost_usd, failover_count, streamed,
    error_code, error_message, tokens_saved, compressors_applied,
    dialect, harness, client_ip, community_gate_denied
  ) values (
    v_req, v_user, v_key,
    p_payload ->> 'model_public_id',
    p_payload ->> 'policy',
    nullif(p_payload ->> 'upstream_id', '')::uuid,
    nullif(p_payload ->> 'upstream_key_id', '')::uuid,
    coalesce((p_payload ->> 'ok')::boolean, false),
    nullif(p_payload ->> 'status_code', '')::int,
    nullif(p_payload ->> 'latency_ms', '')::int,
    coalesce(nullif(p_payload ->> 'tokens_in', '')::int, 0),
    coalesce(nullif(p_payload ->> 'tokens_out', '')::int, 0),
    v_cost,
    coalesce(nullif(p_payload ->> 'failover_count', '')::int, 0),
    coalesce((p_payload ->> 'streamed')::boolean, false),
    v_ecode,
    left(coalesce(p_payload ->> 'error_message', ''), 1000),
    coalesce(nullif(p_payload ->> 'tokens_saved', '')::int, 0),
    coalesce(
      (select array_agg(value::text)
         from jsonb_array_elements_text(
           case jsonb_typeof(p_payload -> 'compressors_applied')
             when 'array' then p_payload -> 'compressors_applied'
             else '[]'::jsonb
           end
         ) as value),
      '{}'::text[]
    ),
    nullif(p_payload ->> 'dialect', ''),
    nullif(p_payload ->> 'harness', ''),
    public.safe_inet(p_payload ->> 'client_ip'),
    v_gate
  ) returning id into v_id;

  if v_key is not null then
    update public.api_keys k
       set request_count = k.request_count + 1,
           last_used_at  = now(),
           spend_usd     = k.spend_usd + v_cost
     where k.id = v_key;
  end if;

  if v_cost > 0 and v_user is not null then
    perform public.internal_credit_move(
      v_user, -v_cost, 'usage',
      coalesce(nullif(p_payload ->> 'model_public_id', ''), 'gateway request'),
      v_req, v_key, p_payload ->> 'model_public_id');
  end if;

  /* v12.15 — the conversation itself, when the router supplied it. A call that
     never reached a model (auth / gate / IP / budget refusal) carries neither
     text, so nothing is written here for it. Upsert on request_id keeps this
     idempotent if the same request is logged twice. */
  if p_request_body is not null or p_response_text is not null then
    insert into public.request_payloads (
      request_id, log_id, user_id, api_key_id, model_public_id,
      request_body, response_text, request_bytes, response_bytes,
      truncated, streamed
    ) values (
      v_req, v_id, v_user, v_key,
      p_payload ->> 'model_public_id',
      p_request_body, p_response_text,
      coalesce(nullif(p_payload ->> 'request_bytes', '')::int,
               coalesce(octet_length(p_request_body), 0)),
      coalesce(nullif(p_payload ->> 'response_bytes', '')::int,
               coalesce(octet_length(p_response_text), 0)),
      coalesce((p_payload ->> 'truncated')::boolean, false),
      coalesce((p_payload ->> 'streamed')::boolean, false)
    )
    on conflict (request_id) do update
      set log_id          = excluded.log_id,
          user_id         = excluded.user_id,
          api_key_id      = excluded.api_key_id,
          model_public_id = excluded.model_public_id,
          request_body    = excluded.request_body,
          response_text   = excluded.response_text,
          request_bytes   = excluded.request_bytes,
          response_bytes  = excluded.response_bytes,
          truncated       = excluded.truncated,
          streamed        = excluded.streamed;
  end if;

  return v_id;
end $$;

comment on function public.internal_log_request(jsonb, text, text) is
  'Writes the request_logs row for one routed call, debits its metered cost, and (v12.15) stores the request/response payload in request_payloads when the router supplied one. service_role only.';

revoke all on function public.internal_log_request(jsonb, text, text) from public;
revoke all on function public.internal_log_request(jsonb, text, text) from anon, authenticated;
grant execute on function public.internal_log_request(jsonb, text, text) to service_role;

commit;

-- PostgREST caches the function list; without this the new signature is not
-- callable until the next schema reload.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFY — eyeball these before walking away
--   request_payloads_exists           true  the table is there
--   internal_log_request_overloads    1     exactly ONE signature (no stale jsonb-only overload)
--   service_role_can_log              true  the router can call it
--   authenticated_can_log             false the browser cannot
-- ----------------------------------------------------------------------------
select
  to_regclass('public.request_payloads') is not null as request_payloads_exists,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'internal_log_request')
                                                    as internal_log_request_overloads,
  has_function_privilege(
    'service_role', 'public.internal_log_request(jsonb,text,text)', 'execute')
                                                    as service_role_can_log,
  has_function_privilege(
    'authenticated', 'public.internal_log_request(jsonb,text,text)', 'execute')
                                                    as authenticated_can_log;
