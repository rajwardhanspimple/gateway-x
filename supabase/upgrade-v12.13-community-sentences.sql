-- ============================================================================
--  RageStar — upgrade to v12.13  "the community rule speaks sentences"
--  Paste this whole file into the Supabase SQL editor and press Run.
--  Idempotent: re-running changes nothing and recounts nothing.
--
--  WHAT THIS DOES
--    The daily participation rule used to count messages: post N messages
--    (app_settings.community_daily_messages, default 2) or the gateway answers
--    403. That made "hi" and a two-sentence thought worth exactly the same.
--    The unit is now the SENTENCE, so one message that genuinely says two
--    things satisfies the gate on its own. The required number is unchanged and
--    is still an integer defaulting to 2 — only its meaning moved from messages
--    to sentences.
--
--    1. public.sentence_count(text) — the scoring helper. Splits on . ! ? and
--       newlines, trims each fragment and counts the non-empty ones.
--    2. public.community_activity gains a `sentences` column. `messages` and
--       `dms` stay exactly where they are; other reporting still reads them and
--       this file does not touch them.
--    3. Two AFTER INSERT triggers (one on chat_messages, one on dm_messages)
--       feed that column. Triggers were chosen over editing post_chat_message
--       and send_dm so the large, well-tested post functions stay untouched and
--       rooms and DMs are covered by one code path.
--    4. public.my_community_standing() and public.internal_community_gate(uuid)
--       now score `sentences` instead of messages plus DMs. Their signatures,
--       verdict shape and grants are unchanged; only the refusals' wording and
--       the number they report move to sentences, so the front end needs no
--       code change beyond copy.
--
--  A NOTE ON EDIT AND DELETE
--    The counter is raised when a body is first inserted. Editing or
--    soft-deleting a message afterwards does NOT lower its sentence count. That
--    is deliberate: the day's work has already been done, and clawing it back on
--    an edit would let a member lose access mid-session. Reporting that wants
--    the live text reads the message tables themselves.
--
--  BACKFILL
--    Nothing is backfilled. `sentences` starts at 0 for everyone and today's
--    tally begins with the first post after this file runs; the `messages`/`dms`
--    columns keep the history they already had. Re-running the file does not
--    rescan old rows, so no existing activity is counted twice.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The unit — how many sentences does a body contain?
-- ----------------------------------------------------------------------------
--    Rule: split the text on sentence terminators (. ! ?) and newlines, trim
--    every fragment, and count the fragments that are not empty. So
--    'Hi. Bye!' is 2, a single run-on line with no terminator is 1, and a
--    blank or null body is 0. Character-based only: there is no attempt to
--    be a linguist, just to stop one-liners satisfying a two-sentence gate.
create or replace function public.sentence_count(p_body text)
returns integer
language sql
immutable
as $$
  select count(*)::int
  from regexp_split_to_table(
         coalesce(p_body, ''),
         '[.!?' || chr(10) || chr(13) || ']+'
       ) as fragment
  where btrim(fragment) <> ''
$$;

comment on function public.sentence_count(text) is
  'Sentences in a body: split on . ! ? and newlines, trim, count the non-empty fragments. Null or blank is 0. This is the unit the daily community gate scores.';

-- ----------------------------------------------------------------------------
-- 2. The ledger — a new column, the two old ones untouched
-- ----------------------------------------------------------------------------
alter table public.community_activity
  add column if not exists sentences integer not null default 0;

comment on column public.community_activity.sentences is
  'Sentences this member wrote today. This is what the gateway gate reads; messages and dms remain for reporting only.';

-- The required number keeps its integer type and its default of 2 — only the
-- unit it is measured in changed, so the stored value stays valid as-is.
comment on column public.app_settings.community_daily_messages is
  'Sentences a member must write per day before the gateway answers their API calls. Unit changed from messages to sentences in v12.13; still an integer defaulting to 2.';

-- ----------------------------------------------------------------------------
-- 3. The increment sites — one trigger per table, one shared function
-- ----------------------------------------------------------------------------
--    Both post_chat_message (rooms) and send_dm (direct messages) simply insert
--    a row; this AFTER INSERT trigger is what adds the sentence count, so the
--    big post functions are not rewritten.
--
--    The author column is read off the row as JSON rather than as new.<field>.
--    PL/pgSQL resolves new.sender_id against the real row type the moment the
--    trigger fires, so a CASE cannot hide a name the other table does not have:
--    chat_messages names its author user_id, dm_messages names it sender_id,
--    and the first version of this function raised
--      record "new" has no field "sender_id"  [42703]
--    on every room message. Reading the row as a document keeps one shared
--    function correct for both tables, and for body too.
create or replace function public.community_sentence_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  jsonb := to_jsonb(new);
  v_user uuid;
  v_n    integer;
  v_day  date := public.community_day();
begin
  v_user := coalesce(
    (v_row ->> 'sender_id')::uuid,
    (v_row ->> 'user_id')::uuid
  );
  if v_user is null then
    return null;
  end if;

  v_n := public.sentence_count(v_row ->> 'body');
  if coalesce(v_n, 0) <= 0 then
    return null;
  end if;

  insert into public.community_activity (user_id, day, sentences, first_at, last_at)
  values (v_user, v_day, v_n, now(), now())
  on conflict (user_id, day) do update
    set sentences = community_activity.sentences + excluded.sentences,
        last_at   = now();

  return null;
end
$$;

-- Drop-then-create keeps re-running safe: no trigger is stacked, and because
-- the counter only ever moves on INSERT, an existing day is never recounted.
drop trigger if exists community_sentences_chat on public.chat_messages;
create trigger community_sentences_chat
  after insert on public.chat_messages
  for each row execute function public.community_sentence_touch();

drop trigger if exists community_sentences_dm on public.dm_messages;
create trigger community_sentences_dm
  after insert on public.dm_messages
  for each row execute function public.community_sentence_touch();

-- The trigger function is machinery, not an API: nothing but the triggers runs it.
revoke all on function public.community_sentence_touch() from public;
revoke all on function public.community_sentence_touch() from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. The two gate readers — same shape, sentences instead of messages
-- ----------------------------------------------------------------------------
-- Everything the portal needs in one round trip: today's progress, whether
-- the gateway is unlocked, and every unread counter. (v12.3 body, `sent_today`
-- now comes from community_activity.sentences.)
create or replace function public.my_community_standing()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_enabled      boolean;
  v_required     integer;
  v_visit_req    boolean;
  v_tz           text;
  v_exempt_admin boolean;
  v_day          date;
  v_sent         integer := 0;
  v_visited      boolean := false;
  v_exempt       boolean := false;
  v_rooms        integer := 0;
  v_dms          integer := 0;
  v_team         integer := 0;
  v_unlocked     boolean;
begin
  select coalesce(a.community_gate_enabled, true),
         coalesce(a.community_daily_messages, 2),
         coalesce(a.community_require_visit, true),
         coalesce(a.community_timezone, 'UTC'),
         coalesce(a.community_gate_exempt_admins, true)
    into v_enabled, v_required, v_visit_req, v_tz, v_exempt_admin
  from public.app_settings a
  where a.id = 1;

  v_enabled      := coalesce(v_enabled, true);
  v_required     := greatest(coalesce(v_required, 2), 0);
  v_visit_req    := coalesce(v_visit_req, true);
  v_tz           := coalesce(v_tz, 'UTC');
  v_exempt_admin := coalesce(v_exempt_admin, true);
  v_day          := (now() at time zone v_tz)::date;

  if v_uid is null then
    return jsonb_build_object(
      'signed_in', false, 'day', v_day, 'timezone', v_tz,
      'enabled', v_enabled, 'require_visit', v_visit_req,
      'required', v_required, 'sent_today', 0, 'remaining', v_required,
      'visited_today', false, 'exempt', false, 'unlocked', false,
      'unread_rooms', 0, 'unread_dms', 0, 'unread_team', 0, 'unread_total', 0);
  end if;

  select coalesce(c.sentences, 0), coalesce(c.visited, false)
    into v_sent, v_visited
  from public.community_activity c
  where c.user_id = v_uid and c.day = v_day;

  v_sent    := coalesce(v_sent, 0);
  v_visited := coalesce(v_visited, false);
  v_exempt  := v_exempt_admin and public.is_admin();

  select coalesce(sum(u.unread), 0)::int into v_rooms from public.my_chat_unread u;
  select coalesce(sum(t.unread), 0)::int into v_dms   from public.my_dm_threads t;

  /* the admin line predates this upgrade and may not exist everywhere */
  begin
    select coalesce(sum(t.unread), 0)::int into v_team from public.my_admin_thread t;
  exception when others then
    v_team := 0;
  end;

  v_unlocked := (not v_enabled)
                or v_exempt
                or ((not v_visit_req or v_visited) and v_sent >= v_required);

  return jsonb_build_object(
    'signed_in',     true,
    'day',           v_day,
    'timezone',      v_tz,
    'enabled',       v_enabled,
    'require_visit', v_visit_req,
    'required',      v_required,
    'sent_today',    v_sent,
    'remaining',     greatest(v_required - v_sent, 0),
    'visited_today', v_visited,
    'exempt',        v_exempt,
    'unlocked',      v_unlocked,
    'unread_rooms',  coalesce(v_rooms, 0),
    'unread_dms',    coalesce(v_dms, 0),
    'unread_team',   coalesce(v_team, 0),
    'unread_total',  coalesce(v_rooms, 0) + coalesce(v_dms, 0) + coalesce(v_team, 0));
end
$$;

-- The gateway's copy of the same rule. service_role only: the router calls it
-- with the key owner's id, so it cannot depend on auth.uid(). (v12.3 body,
-- `sent_today` now comes from community_activity.sentences.)
create or replace function public.internal_community_gate(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled      boolean;
  v_required     integer;
  v_visit_req    boolean;
  v_tz           text;
  v_exempt_admin boolean;
  v_day          date;
  v_sent         integer := 0;
  v_visited      boolean := false;
  v_role         text;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', true, 'code', 'no_user');
  end if;

  select coalesce(a.community_gate_enabled, true),
         coalesce(a.community_daily_messages, 2),
         coalesce(a.community_require_visit, true),
         coalesce(a.community_timezone, 'UTC'),
         coalesce(a.community_gate_exempt_admins, true)
    into v_enabled, v_required, v_visit_req, v_tz, v_exempt_admin
  from public.app_settings a
  where a.id = 1;

  v_enabled      := coalesce(v_enabled, true);
  v_required     := greatest(coalesce(v_required, 2), 0);
  v_visit_req    := coalesce(v_visit_req, true);
  v_tz           := coalesce(v_tz, 'UTC');
  v_exempt_admin := coalesce(v_exempt_admin, true);

  if not v_enabled then
    return jsonb_build_object('allowed', true, 'code', 'gate_off');
  end if;

  select p.role into v_role from public.profiles p where p.id = p_user_id;
  if v_exempt_admin and coalesce(v_role, 'user') = 'admin' then
    return jsonb_build_object('allowed', true, 'code', 'admin_exempt');
  end if;

  v_day := (now() at time zone v_tz)::date;

  select coalesce(c.sentences, 0), coalesce(c.visited, false)
    into v_sent, v_visited
  from public.community_activity c
  where c.user_id = p_user_id and c.day = v_day;

  v_sent    := coalesce(v_sent, 0);
  v_visited := coalesce(v_visited, false);

  if v_visit_req and not v_visited then
    return jsonb_build_object(
      'allowed', false,
      'code', 'community_checkin_required',
      'reason', format('Open the community portal today, then write %s sentence(s), to use the gateway.', v_required),
      'required', v_required, 'sent_today', v_sent, 'visited_today', v_visited);
  end if;

  if v_sent < v_required then
    return jsonb_build_object(
      'allowed', false,
      'code', 'community_participation_required',
      'reason', format('Write %s more sentence(s) in the community portal today to use the gateway (%s of %s done).',
                       v_required - v_sent, v_sent, v_required),
      'required', v_required, 'sent_today', v_sent, 'visited_today', v_visited);
  end if;

  return jsonb_build_object(
    'allowed', true, 'code', 'ok',
    'required', v_required, 'sent_today', v_sent, 'visited_today', v_visited);
end
$$;

-- ----------------------------------------------------------------------------
-- 5. Grants — identical to v12.3, re-issued so a re-run restores them
-- ----------------------------------------------------------------------------
grant execute on function public.my_community_standing() to authenticated;

revoke all on function public.internal_community_gate(uuid) from public;
revoke all on function public.internal_community_gate(uuid) from anon, authenticated;
grant execute on function public.internal_community_gate(uuid) to service_role;

commit;

-- PostgREST caches the function list; without this the new helper and the
-- rewritten functions are not visible until the next schema reload.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFY — eyeball these before walking away
--   required_sentences  the number stored in app_settings (2 on a fresh install)
--   sample_count        2 — one message carrying two sentences
--   one_sentence        1 — a single run-on line still counts as one
--   blank_count         0 — null / blank bodies are worth nothing
-- ----------------------------------------------------------------------------
select
  (select coalesce(s.community_daily_messages, 2)
     from public.app_settings s where s.id = 1)                     as required_sentences,
  public.sentence_count('Hello there. This one message has two sentences!') as sample_count,
  public.sentence_count('no terminator here at all')                as one_sentence,
  public.sentence_count(null)                                       as blank_count;
