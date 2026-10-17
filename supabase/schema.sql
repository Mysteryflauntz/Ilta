create table if not exists public.ilta_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.ilta_sessions (
  session_id uuid primary key,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.ilta_clicks (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  destination text not null check (destination in ('event', 'ticket', 'venue', 'data')),
  event_id varchar(160),
  event_name varchar(200),
  clicked_at timestamptz not null default now()
);

alter table public.ilta_admins enable row level security;
alter table public.ilta_sessions enable row level security;
alter table public.ilta_clicks enable row level security;

create or replace function public.ilta_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ilta_admins
    where user_id = (select auth.uid())
  );
$$;

create policy "Admins can view Ilta admins"
  on public.ilta_admins for select
  to authenticated
  using (public.ilta_is_admin());

create policy "Admins can read Ilta sessions"
  on public.ilta_sessions for select
  to authenticated
  using (public.ilta_is_admin());

create policy "Admins can read Ilta clicks"
  on public.ilta_clicks for select
  to authenticated
  using (public.ilta_is_admin());

create or replace function public.ilta_heartbeat(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null then
    raise exception 'A visitor session ID is required';
  end if;

  insert into public.ilta_sessions (session_id, created_at, last_seen)
  values (p_session_id, now(), now())
  on conflict (session_id) do update
    set last_seen = excluded.last_seen;
end;
$$;

create or replace function public.ilta_track_click(
  p_session_id uuid,
  p_destination text,
  p_event_id text default null,
  p_event_name text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null then
    raise exception 'A visitor session ID is required';
  end if;
  if p_destination not in ('event', 'ticket', 'venue', 'data') then
    raise exception 'Unsupported click destination';
  end if;

  insert into public.ilta_clicks (session_id, destination, event_id, event_name)
  values (
    p_session_id,
    p_destination,
    nullif(left(coalesce(p_event_id, ''), 160), ''),
    nullif(left(coalesce(p_event_name, ''), 200), '')
  );
end;
$$;

revoke all on function public.ilta_is_admin() from public;
grant execute on function public.ilta_is_admin() to authenticated;

revoke all on function public.ilta_heartbeat(uuid) from public;
grant execute on function public.ilta_heartbeat(uuid) to anon, authenticated;

revoke all on function public.ilta_track_click(uuid, text, text, text) from public;
grant execute on function public.ilta_track_click(uuid, text, text, text) to anon, authenticated;

grant select on public.ilta_admins, public.ilta_sessions, public.ilta_clicks to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.ilta_sessions;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.ilta_clicks;
exception
  when duplicate_object then null;
end
$$;
