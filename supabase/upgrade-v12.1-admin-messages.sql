/* ============================================================================
   upgrade-v12.1-admin-messages.sql
   ----------------------------------------------------------------------------
   Members can now message the team privately from the community portal, and
   the admin panel gets a Messages inbox to answer from.

   HOW TO APPLY
     Supabase dashboard -> SQL editor -> paste this whole file -> Run.
     Safe to run more than once.

   WHAT IT ADDS
     admin_threads     one thread per member (unique on user_id)
     admin_messages    the messages in those threads (soft deleted)
     my_admin_thread      the member's own thread + their unread count
     admin_message_feed   messages either side may read
     admin_thread_inbox   the admin list: member, plan, counts, last line
     send_admin_message / admin_reply_message / admin_set_thread_status /
     mark_admin_thread_read / delete_admin_message

   Writes go through security-definer RPCs so a member can never set
   from_admin, touch another thread, or read someone else's messages. The
   views carry their own access test because views run as their owner.
   ========================================================================== */

begin;

/* ------------------------------------------------------------------ tables */

create table if not exists public.admin_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  subject text,
  status text not null default 'open',
  last_sender text not null default 'member',
  last_message_at timestamptz not null default now(),
  user_read_at timestamptz,
  admin_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  alter table public.admin_threads
    add constraint admin_threads_status_chk
    check (status in ('open', 'answered', 'closed'));
exception
  when duplicate_object then null;
end $$;

create table if not exists public.admin_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.admin_threads (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  from_admin boolean not null default false,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete set null
);

create index if not exists admin_messages_thread_created_idx
  on public.admin_messages (thread_id, created_at);

create index if not exists admin_messages_live_idx
  on public.admin_messages (thread_id, created_at)
  where deleted_at is null;

create index if not exists admin_threads_status_idx
  on public.admin_threads (status, last_message_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists admin_threads_touch on public.admin_threads;
create trigger admin_threads_touch
  before update on public.admin_threads
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------------- views */

/* the member's own thread, with how many staff replies they have not read */
create or replace view public.my_admin_thread as
select
  t.id,
  t.subject,
  t.status,
  t.last_sender,
  t.last_message_at,
  t.created_at,
  (
    select count(*)
    from public.admin_messages m
    where m.thread_id = t.id
      and m.deleted_at is null
      and m.from_admin
      and (t.user_read_at is null or m.created_at > t.user_read_at)
  )::int as unread
from public.admin_threads t
where t.user_id = auth.uid();

/* the messages themselves: the owner of the thread, or any admin */
create or replace view public.admin_message_feed as
select
  m.id,
  m.thread_id,
  m.author_id,
  m.from_admin,
  m.body,
  m.created_at,
  case
    when m.from_admin then 'RageStar team'
    else coalesce(
      nullif(btrim(coalesce(p.full_name, '')), ''),
      nullif(split_part(coalesce(p.email, ''), '@', 1), ''),
      'member'
    )
  end as author_name,
  (m.author_id = auth.uid()) as is_mine
from public.admin_messages m
join public.admin_threads t on t.id = m.thread_id
left join public.profiles p on p.id = m.author_id
where m.deleted_at is null
  and (t.user_id = auth.uid() or public.is_admin());

/* the admin list: who, which plan, how many, what was said last */
create or replace view public.admin_thread_inbox as
select
  t.id,
  t.user_id,
  t.subject,
  t.status,
  t.last_sender,
  t.last_message_at,
  t.created_at,
  coalesce(
    nullif(btrim(coalesce(p.full_name, '')), ''),
    nullif(split_part(coalesce(p.email, ''), '@', 1), ''),
    'member'
  ) as member_name,
  p.email as member_email,
  p.plan as member_plan,
  (
    select count(*)
    from public.admin_messages m
    where m.thread_id = t.id and m.deleted_at is null
  )::int as messages,
  (
    select count(*)
    from public.admin_messages m
    where m.thread_id = t.id
      and m.deleted_at is null
      and not m.from_admin
      and (t.admin_read_at is null or m.created_at > t.admin_read_at)
  )::int as unread,
  (
    select m.body
    from public.admin_messages m
    where m.thread_id = t.id and m.deleted_at is null
    order by m.created_at desc
    limit 1
  ) as last_body
from public.admin_threads t
join public.profiles p on p.id = t.user_id
where public.is_admin();

/* -------------------------------------------------------------------- RPCs */

/* member -> team. Creates the thread on first message, reopens it if the
   team had closed it, and never lets the caller pick the thread. */
create or replace function public.send_admin_message(
  p_body text,
  p_subject text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_thread uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to message the team.' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'Write a message first.' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'Messages are limited to 4000 characters.' using errcode = '22023';
  end if;

  insert into public.admin_threads (user_id, subject, last_sender, last_message_at, user_read_at)
  values (v_uid, nullif(btrim(coalesce(p_subject, '')), ''), 'member', now(), now())
  on conflict (user_id) do update
    set last_sender = 'member',
        last_message_at = now(),
        user_read_at = now(),
        status = case when admin_threads.status = 'closed' then 'open' else admin_threads.status end,
        subject = coalesce(admin_threads.subject, excluded.subject)
  returning id into v_thread;

  insert into public.admin_messages (thread_id, author_id, from_admin, body)
  values (v_thread, v_uid, false, v_body);

  return v_thread;
end $$;

/* team -> member */
create or replace function public.admin_reply_message(
  p_thread_id uuid,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not public.is_admin(v_uid) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'Write a reply first.' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'Replies are limited to 4000 characters.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.admin_threads where id = p_thread_id) then
    raise exception 'That thread no longer exists.' using errcode = '22023';
  end if;

  insert into public.admin_messages (thread_id, author_id, from_admin, body)
  values (p_thread_id, v_uid, true, v_body)
  returning id into v_id;

  update public.admin_threads
     set last_sender = 'admin',
         last_message_at = now(),
         admin_read_at = now(),
         status = case when status = 'closed' then 'closed' else 'answered' end
   where id = p_thread_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  select v_uid, coalesce(p.email, ''), 'admin_reply_message', 'admin_threads', p_thread_id::text,
         jsonb_build_object('chars', length(v_body))
    from public.profiles p where p.id = v_uid;

  return v_id;
end $$;

create or replace function public.admin_set_thread_status(
  p_thread_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not public.is_admin(v_uid) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_status not in ('open', 'answered', 'closed') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;

  update public.admin_threads set status = p_status where id = p_thread_id;

  insert into public.audit_logs (actor_id, actor_email, action, entity, entity_id, detail)
  select v_uid, coalesce(p.email, ''), 'admin_set_thread_status', 'admin_threads', p_thread_id::text,
         jsonb_build_object('status', p_status)
    from public.profiles p where p.id = v_uid;
end $$;

/* reading. A member marks their own thread; an admin marks the one they
   opened. Passing no id means "my own thread". */
create or replace function public.mark_admin_thread_read(
  p_thread_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  if p_thread_id is not null and public.is_admin(v_uid) then
    update public.admin_threads set admin_read_at = now() where id = p_thread_id;
  else
    update public.admin_threads set user_read_at = now() where user_id = v_uid;
  end if;
end $$;

/* soft delete: the author can take back their own line, an admin any line */
create or replace function public.delete_admin_message(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_author uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;

  select author_id into v_author
    from public.admin_messages
   where id = p_id and deleted_at is null;

  if v_author is null and not public.is_admin(v_uid) then
    raise exception 'That message is gone.' using errcode = '22023';
  end if;

  if v_author <> v_uid and not public.is_admin(v_uid) then
    raise exception 'You can only delete your own messages.' using errcode = '42501';
  end if;

  update public.admin_messages
     set deleted_at = now(), deleted_by = v_uid
   where id = p_id;
end $$;

/* --------------------------------------------------------------------- RLS */

alter table public.admin_threads enable row level security;
alter table public.admin_messages enable row level security;

drop policy if exists admin_threads_read on public.admin_threads;
create policy admin_threads_read on public.admin_threads
  for select using (user_id = auth.uid());

drop policy if exists admin_threads_admin on public.admin_threads;
create policy admin_threads_admin on public.admin_threads
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists admin_messages_read on public.admin_messages;
create policy admin_messages_read on public.admin_messages
  for select using (
    exists (
      select 1 from public.admin_threads t
      where t.id = admin_messages.thread_id and t.user_id = auth.uid()
    )
  );

drop policy if exists admin_messages_admin on public.admin_messages;
create policy admin_messages_admin on public.admin_messages
  for all using (public.is_admin()) with check (public.is_admin());

/* ------------------------------------------------------------------ grants */

grant select on public.my_admin_thread to authenticated, service_role;
grant select on public.admin_message_feed to authenticated, service_role;
grant select on public.admin_thread_inbox to authenticated, service_role;

grant execute on function public.send_admin_message(text, text) to authenticated, service_role;
grant execute on function public.admin_reply_message(uuid, text) to authenticated, service_role;
grant execute on function public.admin_set_thread_status(uuid, text) to authenticated, service_role;
grant execute on function public.mark_admin_thread_read(uuid) to authenticated, service_role;
grant execute on function public.delete_admin_message(uuid) to authenticated, service_role;

commit;
