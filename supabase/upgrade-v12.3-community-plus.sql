/* ==========================================================================
   RageStar - upgrade v12.3  "community plus"
   --------------------------------------------------------------------------
   Paste this whole file into the Supabase SQL editor and run it once.
   It is idempotent: running it again changes nothing.

   What it adds
     1. Replies and emoji reactions on room messages
     2. Member-to-member direct messages (the old admin line stays put)
     3. Per-room / per-thread unread counts, and presence
     4. A daily participation rule the API gateway enforces:
        open the portal today and post at least N messages (default 2),
        or the gateway answers 403 until you do.

   On "do not encrypt the sender and receiver and message"
     Nothing here hashes, masks or aliases chat content. chat_feed and dm_feed
     return the sender id AND the sender's display name, dm_feed also returns
     the recipient id and name, and the body is stored and returned exactly as
     typed. The only thing the member-facing views leave out is the email
     address, which is account data rather than chat data - admins keep their
     own full-identity view (admin_community_activity).
   ========================================================================== */

begin;

/* ==========================================================================
   1. Settings - the daily rule is configurable, not hard-coded
   ========================================================================== */

alter table public.app_settings
  add column if not exists community_gate_enabled       boolean not null default true,
  add column if not exists community_daily_messages     integer not null default 2,
  add column if not exists community_require_visit      boolean not null default true,
  add column if not exists community_timezone           text    not null default 'UTC',
  add column if not exists community_gate_exempt_admins boolean not null default true;

comment on column public.app_settings.community_daily_messages is
  'Messages a member must post per day before the gateway answers their API calls.';

/* The day the rule is scored against. A member in Kolkata and a member in
   Lisbon should roll over together, so the workspace picks one timezone. */
create or replace function public.community_day(p_at timestamptz default now())
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (p_at at time zone
           coalesce((select a.community_timezone from public.app_settings a where a.id = 1), 'UTC')
         )::date
$$;

/* ==========================================================================
   2. Replies, reactions, read marks
   ========================================================================== */

alter table public.chat_messages
  add column if not exists reply_to uuid references public.chat_messages(id) on delete set null;

create index if not exists chat_messages_reply_idx on public.chat_messages(reply_to);
create index if not exists chat_messages_group_time_idx on public.chat_messages(group_id, created_at desc);

create table if not exists public.chat_reactions (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id)      on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 12),
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);
create index if not exists chat_reactions_msg_idx on public.chat_reactions(message_id);

create table if not exists public.chat_reads (
  user_id      uuid not null references public.profiles(id)    on delete cascade,
  group_id     uuid not null references public.chat_groups(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, group_id)
);

/* ==========================================================================
   3. Direct messages between members
   One row per pair, ordered so the pair is unique in both directions.
   ========================================================================== */

create table if not exists public.dm_threads (
  id              uuid primary key default gen_random_uuid(),
  user_a          uuid not null references public.profiles(id) on delete cascade,
  user_b          uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  a_last_read_at  timestamptz,
  b_last_read_at  timestamptz,
  constraint dm_threads_ordered check (user_a < user_b),
  constraint dm_threads_pair    unique (user_a, user_b)
);

create table if not exists public.dm_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references public.dm_threads(id) on delete cascade,
  sender_id    uuid not null references public.profiles(id)   on delete cascade,
  recipient_id uuid not null references public.profiles(id)   on delete cascade,
  body         text not null check (char_length(body) between 1 and 4000),
  reply_to     uuid references public.dm_messages(id) on delete set null,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  deleted_at   timestamptz,
  deleted_by   uuid references public.profiles(id)
);
create index if not exists dm_messages_thread_idx on public.dm_messages(thread_id, created_at desc);

/* ==========================================================================
   4. Presence + the daily ledger
   ========================================================================== */

create table if not exists public.community_presence (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  room         text
);

create table if not exists public.community_activity (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  day      date not null,
  visited  boolean not null default false,
  messages integer not null default 0,
  dms      integer not null default 0,
  first_at timestamptz,
  last_at  timestamptz,
  primary key (user_id, day)
);
create index if not exists community_activity_day_idx on public.community_activity(day);

/* ==========================================================================
   5. Helpers
   ========================================================================== */

/* A chat display name. Never an email address: if a member has no full name
   we use the local part only, so member-facing views cannot leak a mailbox. */
create or replace function public.community_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'member')
  from public.profiles p
  where p.id = p_user
$$;

/* One writer for the ledger: every post, DM and visit lands here. */
create or replace function public.community_touch(
  p_user     uuid,
  p_messages integer default 0,
  p_dms      integer default 0,
  p_visited  boolean default false,
  p_room     text    default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := public.community_day();
begin
  if p_user is null then
    return;
  end if;

  insert into public.community_activity (user_id, day, visited, messages, dms, first_at, last_at)
  values (p_user, v_day, coalesce(p_visited, false),
          greatest(coalesce(p_messages, 0), 0), greatest(coalesce(p_dms, 0), 0), now(), now())
  on conflict (user_id, day) do update
    set visited  = community_activity.visited or excluded.visited,
        messages = community_activity.messages + excluded.messages,
        dms      = community_activity.dms + excluded.dms,
        last_at  = now();

  insert into public.community_presence (user_id, last_seen_at, room)
  values (p_user, now(), p_room)
  on conflict (user_id) do update
    set last_seen_at = now(),
        room         = coalesce(excluded.room, community_presence.room);
end
$$;

/* ==========================================================================
   6. Views
   ========================================================================== */

/* chat_feed gains replies, a reaction roll-up and a staff flag. */
drop view if exists public.chat_feed cascade;
create view public.chat_feed as
select m.id,
       g.slug                               as group_slug,
       m.group_id,
       m.user_id,
       public.community_name(m.user_id)     as author_name,
       coalesce(p.role, 'user')             as author_role,
       (coalesce(p.role, 'user') = 'admin') as is_staff,
       m.body,
       m.created_at,
       m.edited_at,
       m.reply_to,
       case when r.id is null or r.deleted_at is not null
            then null else left(r.body, 180) end                    as reply_body,
       case when r.id is null or r.deleted_at is not null
            then null else public.community_name(r.user_id) end     as reply_author,
       coalesce(x.reactions, '[]'::jsonb)   as reactions,
       (m.user_id = auth.uid())             as is_mine
from public.chat_messages m
join public.chat_groups g on g.id = m.group_id
left join public.profiles p on p.id = m.user_id
left join public.chat_messages r on r.id = m.reply_to
left join (
  select t.message_id,
         jsonb_agg(jsonb_build_object('emoji', t.emoji, 'count', t.n, 'mine', t.mine)
                   order by t.n desc, t.emoji) as reactions
  from (
    select cr.message_id,
           cr.emoji,
           count(*)::int                    as n,
           bool_or(cr.user_id = auth.uid()) as mine
    from public.chat_reactions cr
    group by cr.message_id, cr.emoji
  ) t
  group by t.message_id
) x on x.message_id = m.id
where m.deleted_at is null;

/* Unread per room: anything somebody else wrote since my read mark. */
create or replace view public.my_chat_unread as
select g.id             as group_id,
       g.slug,
       g.name,
       count(m.id)::int as unread,
       max(m.created_at) as last_message_at
from public.chat_groups g
left join public.chat_reads cr
       on cr.group_id = g.id and cr.user_id = auth.uid()
left join public.chat_messages m
       on m.group_id = g.id
      and m.deleted_at is null
      and m.user_id is distinct from auth.uid()
      and m.created_at > coalesce(cr.last_read_at, now() - interval '14 days')
where coalesce(g.is_active, true)
group by g.id, g.slug, g.name;

/* My DM threads, newest first, with the other side named in full. */
create or replace view public.my_dm_threads as
select t.id,
       case when t.user_a = auth.uid() then t.user_b else t.user_a end as other_id,
       public.community_name(case when t.user_a = auth.uid() then t.user_b else t.user_a end) as other_name,
       coalesce(op.role, 'user') as other_role,
       t.last_message_at,
       t.created_at,
       left(lm.body, 120)        as last_body,
       case when lm.sender_id is null then null
            else public.community_name(lm.sender_id) end as last_sender_name,
       (select count(*)::int
          from public.dm_messages u
         where u.thread_id = t.id
           and u.deleted_at is null
           and u.sender_id <> auth.uid()
           and u.created_at > coalesce(
                 case when t.user_a = auth.uid() then t.a_last_read_at else t.b_last_read_at end,
                 'epoch'::timestamptz)) as unread,
       pr.last_seen_at as other_last_seen
from public.dm_threads t
left join lateral (
  select d.body, d.sender_id
  from public.dm_messages d
  where d.thread_id = t.id and d.deleted_at is null
  order by d.created_at desc
  limit 1
) lm on true
left join public.profiles op
       on op.id = (case when t.user_a = auth.uid() then t.user_b else t.user_a end)
left join public.community_presence pr on pr.user_id = op.id
where auth.uid() in (t.user_a, t.user_b);

/* Both sides of every DM, in plain text, restricted to my own threads.
   A view bypasses RLS, so this WHERE clause is what keeps DMs private. */
create or replace view public.dm_feed as
select d.id,
       d.thread_id,
       d.sender_id,
       public.community_name(d.sender_id)    as sender_name,
       d.recipient_id,
       public.community_name(d.recipient_id) as recipient_name,
       d.body,
       d.reply_to,
       case when r.id is null or r.deleted_at is not null
            then null else left(r.body, 180) end                      as reply_body,
       case when r.id is null or r.deleted_at is not null
            then null else public.community_name(r.sender_id) end     as reply_author,
       d.created_at,
       d.edited_at,
       (d.sender_id = auth.uid())             as is_mine,
       (coalesce(sp.role, 'user') = 'admin')  as is_staff
from public.dm_messages d
join public.dm_threads t on t.id = d.thread_id
left join public.dm_messages r on r.id = d.reply_to
left join public.profiles sp on sp.id = d.sender_id
where d.deleted_at is null
  and auth.uid() in (t.user_a, t.user_b);

/* The directory you start a DM from. Names and presence only. */
create or replace view public.community_members as
select p.id,
       public.community_name(p.id) as name,
       coalesce(p.role, 'user')    as role,
       pr.last_seen_at,
       coalesce(pr.last_seen_at > now() - interval '3 minutes', false) as online,
       (p.id = auth.uid())         as is_me
from public.profiles p
left join public.community_presence pr on pr.user_id = p.id
where coalesce(p.status::text, 'active') not in ('suspended', 'blocked', 'disabled', 'banned');

/* Admin-only: who showed up, how much they posted, with the email attached. */
create or replace view public.admin_community_activity as
select a.day,
       a.user_id,
       p.email,
       public.community_name(a.user_id) as name,
       coalesce(p.role, 'user')         as role,
       a.visited,
       a.messages,
       a.dms,
       a.first_at,
       a.last_at
from public.community_activity a
join public.profiles p on p.id = a.user_id
where public.is_admin();

/* ==========================================================================
   7. Room RPCs
   ========================================================================== */

/* The two-argument version must go first, or post_chat_message(text, text)
   and post_chat_message(text, text, uuid default null) are ambiguous. */
drop function if exists public.post_chat_message(text, text);

create or replace function public.post_chat_message(
  p_group_slug text,
  p_body       text,
  p_reply_to   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := btrim(coalesce(p_body, ''));
  v_group  uuid;
  v_locked boolean;
  v_id     uuid;
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if v_body = '' then raise exception 'Message is empty.'; end if;
  if char_length(v_body) > 4000 then raise exception 'Message is too long (4000 characters max).'; end if;

  select g.id, coalesce(g.is_locked, false)
    into v_group, v_locked
  from public.chat_groups g
  where g.slug = p_group_slug and coalesce(g.is_active, true);

  if v_group is null then raise exception 'That room does not exist.'; end if;
  if v_locked and not public.is_admin() then raise exception 'That room is announcement only.'; end if;

  if p_reply_to is not null and not exists (
       select 1 from public.chat_messages m
       where m.id = p_reply_to and m.group_id = v_group and m.deleted_at is null) then
    raise exception 'The message you replied to is gone.';
  end if;

  insert into public.chat_messages (group_id, user_id, body, reply_to)
  values (v_group, v_uid, v_body, p_reply_to)
  returning id into v_id;

  perform public.community_touch(v_uid, 1, 0, true, p_group_slug);

  insert into public.chat_reads (user_id, group_id, last_read_at)
  values (v_uid, v_group, now())
  on conflict (user_id, group_id) do update set last_read_at = now();

  return v_id;
end
$$;

create or replace function public.edit_chat_message(p_id uuid, p_body text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if v_body = '' then raise exception 'Message is empty.'; end if;

  update public.chat_messages
     set body = v_body, edited_at = now()
   where id = p_id and user_id = v_uid and deleted_at is null;

  if not found then raise exception 'You can only edit your own messages.'; end if;
  return true;
end
$$;

/* Adds my reaction, or takes it back if it was already mine. */
create or replace function public.toggle_chat_reaction(p_id uuid, p_emoji text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_emoji text := btrim(coalesce(p_emoji, ''));
  v_hit   int;
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if v_emoji = '' then raise exception 'Pick an emoji.'; end if;
  if not exists (select 1 from public.chat_messages m where m.id = p_id and m.deleted_at is null) then
    raise exception 'That message is gone.';
  end if;

  delete from public.chat_reactions
   where message_id = p_id and user_id = v_uid and emoji = v_emoji;
  get diagnostics v_hit = row_count;

  if v_hit > 0 then
    return false;
  end if;

  insert into public.chat_reactions (message_id, user_id, emoji)
  values (p_id, v_uid, v_emoji)
  on conflict do nothing;

  perform public.community_touch(v_uid, 0, 0, true, null);
  return true;
end
$$;

create or replace function public.mark_room_read(p_group_slug text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_group uuid;
begin
  if v_uid is null then return false; end if;

  select g.id into v_group from public.chat_groups g where g.slug = p_group_slug;
  if v_group is null then return false; end if;

  insert into public.chat_reads (user_id, group_id, last_read_at)
  values (v_uid, v_group, now())
  on conflict (user_id, group_id) do update set last_read_at = now();

  perform public.community_touch(v_uid, 0, 0, true, p_group_slug);
  return true;
end
$$;

/* ==========================================================================
   8. Direct-message RPCs
   ========================================================================== */

create or replace function public.open_dm_thread(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a   uuid;
  v_b   uuid;
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if p_other is null or p_other = v_uid then raise exception 'Pick somebody else.'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_other) then
    raise exception 'That member does not exist.';
  end if;

  v_a := least(v_uid, p_other);
  v_b := greatest(v_uid, p_other);

  insert into public.dm_threads (user_a, user_b)
  values (v_a, v_b)
  on conflict (user_a, user_b) do nothing;

  select t.id into v_id from public.dm_threads t where t.user_a = v_a and t.user_b = v_b;

  perform public.community_touch(v_uid, 0, 0, true, 'dm');
  return v_id;
end
$$;

create or replace function public.send_dm(
  p_recipient uuid,
  p_body      text,
  p_reply_to  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := btrim(coalesce(p_body, ''));
  v_thread uuid;
  v_id     uuid;
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if v_body = '' then raise exception 'Message is empty.'; end if;
  if char_length(v_body) > 4000 then raise exception 'Message is too long (4000 characters max).'; end if;

  v_thread := public.open_dm_thread(p_recipient);
  if v_thread is null then raise exception 'Could not open that conversation.'; end if;

  if p_reply_to is not null and not exists (
       select 1 from public.dm_messages d
       where d.id = p_reply_to and d.thread_id = v_thread and d.deleted_at is null) then
    raise exception 'The message you replied to is gone.';
  end if;

  insert into public.dm_messages (thread_id, sender_id, recipient_id, body, reply_to)
  values (v_thread, v_uid, p_recipient, v_body, p_reply_to)
  returning id into v_id;

  update public.dm_threads
     set last_message_at = now(),
         a_last_read_at  = case when user_a = v_uid then now() else a_last_read_at end,
         b_last_read_at  = case when user_b = v_uid then now() else b_last_read_at end
   where id = v_thread;

  perform public.community_touch(v_uid, 0, 1, true, 'dm');
  return v_id;
end
$$;

create or replace function public.mark_dm_read(p_thread_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;

  update public.dm_threads
     set a_last_read_at = case when user_a = v_uid then now() else a_last_read_at end,
         b_last_read_at = case when user_b = v_uid then now() else b_last_read_at end
   where id = p_thread_id and v_uid in (user_a, user_b);

  return found;
end
$$;

create or replace function public.edit_dm_message(p_id uuid, p_body text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if v_body = '' then raise exception 'Message is empty.'; end if;

  update public.dm_messages
     set body = v_body, edited_at = now()
   where id = p_id and sender_id = v_uid and deleted_at is null;

  if not found then raise exception 'You can only edit your own messages.'; end if;
  return true;
end
$$;

create or replace function public.delete_dm_message(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;

  update public.dm_messages
     set deleted_at = now(), deleted_by = v_uid
   where id = p_id
     and deleted_at is null
     and (sender_id = v_uid or public.is_admin());

  if not found then raise exception 'You can only delete your own messages.'; end if;
  return true;
end
$$;

/* ==========================================================================
   9. The daily rule
   ========================================================================== */

create or replace function public.record_community_visit(p_room text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  perform public.community_touch(v_uid, 0, 0, true, p_room);
  return true;
end
$$;

/* Everything the portal needs in one round trip: today's progress, whether
   the gateway is unlocked, and every unread counter. */
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

  select coalesce(c.messages, 0) + coalesce(c.dms, 0), coalesce(c.visited, false)
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

/* The gateway's copy of the same rule. service_role only: the router calls it
   with the key owner's id, so it cannot depend on auth.uid(). */
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

  select coalesce(c.messages, 0) + coalesce(c.dms, 0), coalesce(c.visited, false)
    into v_sent, v_visited
  from public.community_activity c
  where c.user_id = p_user_id and c.day = v_day;

  v_sent    := coalesce(v_sent, 0);
  v_visited := coalesce(v_visited, false);

  if v_visit_req and not v_visited then
    return jsonb_build_object(
      'allowed', false,
      'code', 'community_checkin_required',
      'reason', format('Open the community portal today, then post %s message(s), to use the gateway.', v_required),
      'required', v_required, 'sent_today', v_sent, 'visited_today', v_visited);
  end if;

  if v_sent < v_required then
    return jsonb_build_object(
      'allowed', false,
      'code', 'community_participation_required',
      'reason', format('Post %s more message(s) in the community portal today to use the gateway (%s of %s done).',
                       v_required - v_sent, v_sent, v_required),
      'required', v_required, 'sent_today', v_sent, 'visited_today', v_visited);
  end if;

  return jsonb_build_object(
    'allowed', true, 'code', 'ok',
    'required', v_required, 'sent_today', v_sent, 'visited_today', v_visited);
end
$$;

/* Admin switch panel: { enabled, required, require_visit, timezone, exempt_admins } */
create or replace function public.admin_save_community_gate(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;

  update public.app_settings a
     set community_gate_enabled = coalesce((v_patch ->> 'enabled')::boolean, a.community_gate_enabled),
         community_daily_messages = greatest(coalesce((v_patch ->> 'required')::int, a.community_daily_messages), 0),
         community_require_visit = coalesce((v_patch ->> 'require_visit')::boolean, a.community_require_visit),
         community_timezone = coalesce(nullif(btrim(coalesce(v_patch ->> 'timezone', '')), ''), a.community_timezone),
         community_gate_exempt_admins = coalesce((v_patch ->> 'exempt_admins')::boolean, a.community_gate_exempt_admins)
   where a.id = 1;

  begin
    insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
    values (auth.uid(),
            (select p.email from public.profiles p where p.id = auth.uid()),
            'community.gate.save', 'app_settings', '1', v_patch);
  exception when others then
    null;
  end;

  return (select jsonb_build_object(
            'enabled',       a.community_gate_enabled,
            'required',      a.community_daily_messages,
            'require_visit', a.community_require_visit,
            'timezone',      a.community_timezone,
            'exempt_admins', a.community_gate_exempt_admins)
          from public.app_settings a where a.id = 1);
end
$$;

/* ==========================================================================
   10. Row level security
   ========================================================================== */

alter table public.chat_reactions     enable row level security;
alter table public.chat_reads         enable row level security;
alter table public.dm_threads         enable row level security;
alter table public.dm_messages        enable row level security;
alter table public.community_presence enable row level security;
alter table public.community_activity enable row level security;

drop policy if exists chat_reactions_read   on public.chat_reactions;
drop policy if exists chat_reactions_write  on public.chat_reactions;
drop policy if exists chat_reactions_delete on public.chat_reactions;
create policy chat_reactions_read on public.chat_reactions
  for select to authenticated using (true);
create policy chat_reactions_write on public.chat_reactions
  for insert to authenticated with check (user_id = auth.uid());
create policy chat_reactions_delete on public.chat_reactions
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists chat_reads_own on public.chat_reads;
create policy chat_reads_own on public.chat_reads
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists dm_threads_mine on public.dm_threads;
create policy dm_threads_mine on public.dm_threads
  for select to authenticated using (auth.uid() in (user_a, user_b) or public.is_admin());

drop policy if exists dm_messages_mine on public.dm_messages;
create policy dm_messages_mine on public.dm_messages
  for select to authenticated using (
    exists (select 1 from public.dm_threads t
            where t.id = dm_messages.thread_id and auth.uid() in (t.user_a, t.user_b))
    or public.is_admin());

drop policy if exists community_presence_read on public.community_presence;
drop policy if exists community_presence_own  on public.community_presence;
create policy community_presence_read on public.community_presence
  for select to authenticated using (true);
create policy community_presence_own on public.community_presence
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists community_activity_own on public.community_activity;
create policy community_activity_own on public.community_activity
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

/* ==========================================================================
   11. Grants
   ========================================================================== */

grant select on public.chat_feed                to anon, authenticated;
grant select on public.my_chat_unread           to authenticated;
grant select on public.my_dm_threads            to authenticated;
grant select on public.dm_feed                  to authenticated;
grant select on public.community_members        to authenticated;
grant select on public.admin_community_activity to authenticated;

grant select, insert, delete on public.chat_reactions to authenticated;
grant select, insert, update on public.chat_reads     to authenticated;
grant select on public.dm_threads         to authenticated;
grant select on public.dm_messages        to authenticated;
grant select on public.community_presence to authenticated;
grant select on public.community_activity to authenticated;

grant execute on function public.community_day(timestamptz)          to anon, authenticated;
grant execute on function public.community_name(uuid)                to anon, authenticated;
grant execute on function public.post_chat_message(text, text, uuid) to authenticated;
grant execute on function public.edit_chat_message(uuid, text)       to authenticated;
grant execute on function public.toggle_chat_reaction(uuid, text)    to authenticated;
grant execute on function public.mark_room_read(text)                to authenticated;
grant execute on function public.open_dm_thread(uuid)                to authenticated;
grant execute on function public.send_dm(uuid, text, uuid)           to authenticated;
grant execute on function public.mark_dm_read(uuid)                  to authenticated;
grant execute on function public.edit_dm_message(uuid, text)         to authenticated;
grant execute on function public.delete_dm_message(uuid)             to authenticated;
grant execute on function public.record_community_visit(text)        to authenticated;
grant execute on function public.my_community_standing()             to authenticated;
grant execute on function public.admin_save_community_gate(jsonb)    to authenticated;

/* The ledger writer and the gateway's gate are service-side only. */
revoke all on function public.community_touch(uuid, integer, integer, boolean, text) from public;
revoke all on function public.community_touch(uuid, integer, integer, boolean, text) from anon, authenticated;
grant execute on function public.community_touch(uuid, integer, integer, boolean, text) to service_role;

revoke all on function public.internal_community_gate(uuid) from public;
revoke all on function public.internal_community_gate(uuid) from anon, authenticated;
grant execute on function public.internal_community_gate(uuid) to service_role;

commit;

/* --------------------------------------------------------------------------
   Changing the rule later, without touching this file again:

     select public.admin_save_community_gate('{"required": 3}'::jsonb);
     select public.admin_save_community_gate('{"enabled": false}'::jsonb);
     select public.admin_save_community_gate('{"timezone": "Asia/Kolkata"}'::jsonb);

   Who showed up today:

     select * from public.admin_community_activity
      where day = public.community_day() order by messages desc;
   -------------------------------------------------------------------------- */
