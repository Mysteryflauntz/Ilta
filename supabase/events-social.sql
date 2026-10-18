create table if not exists public.ilta_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 2 and 200),
  description text not null default '' check (length(description) <= 12000),
  starts_at timestamptz not null,
  venue text not null check (length(trim(venue)) between 1 and 200),
  address text not null default '' check (length(address) <= 300),
  is_free boolean not null default false,
  price text not null default '' check (length(price) <= 100),
  event_url text not null check (length(event_url) <= 2048 and event_url ~* '^https://'),
  image_url text check (image_url is null or (length(image_url) <= 2048 and image_url ~* '^https://')),
  image_alt text not null default '' check (length(image_alt) <= 300),
  source_kind text not null check (source_kind in ('organizer', 'instagram', 'facebook', 'tiktok')),
  source_record_id uuid,
  source_name text not null check (length(trim(source_name)) between 1 and 160),
  source_url text not null check (source_url ~* '^https://'),
  created_at timestamptz not null default now()
);

create index if not exists ilta_events_starts_at_idx on public.ilta_events (starts_at);
create unique index if not exists ilta_events_source_record_idx
  on public.ilta_events (source_kind, source_record_id);
alter table public.ilta_events enable row level security;

create policy "Anyone can read upcoming published Ilta events"
  on public.ilta_events for select
  to anon, authenticated
  using (starts_at >= now() - interval '1 day');

create policy "Ilta admins manage published events"
  on public.ilta_events for all
  to authenticated
  using (public.ilta_is_admin())
  with check (public.ilta_is_admin());

revoke all on public.ilta_events from anon, authenticated;
grant select on public.ilta_events to anon, authenticated;
grant insert, update, delete on public.ilta_events to authenticated;

create table if not exists public.ilta_submissions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 2 and 200),
  description text not null default '' check (length(description) <= 12000),
  starts_at timestamptz not null,
  venue text not null check (length(trim(venue)) between 1 and 200),
  address text not null default '' check (length(address) <= 300),
  is_free boolean not null default false,
  price text not null default '' check (length(price) <= 100),
  event_url text not null check (length(event_url) <= 2048 and event_url ~* '^https://'),
  image_url text check (image_url is null or (length(image_url) <= 2048 and image_url ~* '^https://')),
  image_alt text not null default '' check (length(image_alt) <= 300),
  organizer_name text not null check (length(trim(organizer_name)) between 1 and 160),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected')),
  submitted_at timestamptz not null default now()
);

create index if not exists ilta_submissions_status_idx on public.ilta_submissions (status, submitted_at desc);
alter table public.ilta_submissions enable row level security;

create policy "Public can submit events for review"
  on public.ilta_submissions for insert
  to anon, authenticated
  with check (
    status = 'pending'
    and starts_at >= now() - interval '1 day'
    and (image_url is null or image_url ~* '^https://')
  );

create policy "Ilta admins review submissions"
  on public.ilta_submissions for select
  to authenticated
  using (public.ilta_is_admin());

create policy "Ilta admins update submissions"
  on public.ilta_submissions for update
  to authenticated
  using (public.ilta_is_admin())
  with check (public.ilta_is_admin());

create policy "Ilta admins remove submissions"
  on public.ilta_submissions for delete
  to authenticated
  using (public.ilta_is_admin());

revoke all on public.ilta_submissions from anon, authenticated;
grant insert (
  title, description, starts_at, venue, address, is_free, price,
  event_url, image_url, image_alt, organizer_name
) on public.ilta_submissions to anon, authenticated;
grant select, update, delete on public.ilta_submissions to authenticated;

create table if not exists public.ilta_social_candidates (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('instagram', 'facebook', 'tiktok')),
  provider_post_id text not null,
  source_name text not null,
  post_text text not null default '' check (length(post_text) <= 12000),
  post_url text not null check (length(post_url) <= 2048 and post_url ~* '^https://'),
  image_url text check (image_url is null or (length(image_url) <= 2048 and image_url ~* '^https://')),
  posted_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'rejected', 'used')),
  imported_at timestamptz not null default now(),
  unique (provider, provider_post_id)
);

create index if not exists ilta_social_candidates_status_idx
  on public.ilta_social_candidates (status, posted_at desc nulls last);
alter table public.ilta_social_candidates enable row level security;

create policy "Ilta admins review social candidates"
  on public.ilta_social_candidates for select
  to authenticated
  using (public.ilta_is_admin());

create policy "Ilta admins update social candidates"
  on public.ilta_social_candidates for update
  to authenticated
  using (public.ilta_is_admin())
  with check (public.ilta_is_admin());

revoke all on public.ilta_social_candidates from anon, authenticated;
grant select, update on public.ilta_social_candidates to authenticated;
grant select, insert, update on public.ilta_social_candidates to service_role;

do $$
begin
  alter publication supabase_realtime add table public.ilta_submissions;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.ilta_social_candidates;
exception
  when duplicate_object then null;
end
$$;
