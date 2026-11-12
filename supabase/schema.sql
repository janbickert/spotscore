-- SpotScore cloud schema (Supabase / Postgres)
-- Author: Jan Bickert
--
-- Model
-- - Catalog (shared): Spotify metadata for tracks, albums and artists. Any
--   signed-in user can add to it, so genres are fetched from Spotify once.
-- - Per user: liked songs and "records" (ratings, Elo, suggestions, brackets,
--   edition overrides). Each user writes only their own rows; both users can
--   read each other's rows (needed for the social features).
-- - Shared brackets: one bracket, both users vote on every match.
--
-- Who can sign in: only Spotify login is enabled, and the Spotify app is in
-- Development Mode, so only accounts on its allowlist (max 5) get in. That is
-- why "authenticated" is a sufficient audience for reading.
--
-- Sync: the app works offline from IndexedDB and syncs records with a client
-- timestamp (updated_at, ms). A trigger keeps the newer version (last write
-- wins) and stamps synced_at with server time, which clients use as their
-- pull cursor.

-- ---------- Helpers ----------
create or replace function public.keep_newer()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null; -- incoming change is older: keep the stored row
  end if;
  new.synced_at := now();
  return new;
end $$;

-- ---------- Profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  spotify_id text,
  display_name text,
  image text,
  updated_at bigint not null default 0,
  synced_at timestamptz not null default now()
);

-- ---------- Shared catalog ----------
create table if not exists public.catalog_tracks (
  id text primary key,
  data jsonb not null,
  updated_at bigint not null,
  synced_at timestamptz not null default now()
);
create table if not exists public.catalog_albums (like public.catalog_tracks including all);
create table if not exists public.catalog_artists (like public.catalog_tracks including all);

-- ---------- Per user ----------
create table if not exists public.likes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  track_id text not null,
  added_at text not null,          -- Spotify's added_at (ISO string)
  deleted boolean not null default false, -- unliked (kept so other devices learn it)
  updated_at bigint not null,
  synced_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create table if not exists public.user_records (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('rating', 'elo', 'suggestion', 'bracket', 'override')),
  id text not null,
  data jsonb not null,
  updated_at bigint not null,
  synced_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

-- ---------- Shared brackets ----------
create table if not exists public.shared_brackets (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  data jsonb not null,             -- type, size, pool label, seeded entries (snapshots)
  updated_at bigint not null,
  synced_at timestamptz not null default now()
);

create table if not exists public.shared_votes (
  bracket_id uuid not null references public.shared_brackets on delete cascade,
  match_key text not null,         -- e.g. r0m3 = round 0, match 3
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  winner text not null,            -- entry key
  updated_at bigint not null,
  synced_at timestamptz not null default now(),
  primary key (bracket_id, match_key, user_id)
);

-- Final result of a match once both have voted. First writer wins
-- (insert ... on conflict do nothing), so both clients agree.
create table if not exists public.shared_results (
  bracket_id uuid not null references public.shared_brackets on delete cascade,
  match_key text not null,
  winner text not null,
  decided_by text not null check (decided_by in ('agreed', 'tiebreak')),
  synced_at timestamptz not null default now(),
  primary key (bracket_id, match_key)
);

-- ---------- Triggers ----------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'catalog_tracks', 'catalog_albums', 'catalog_artists', 'likes', 'user_records', 'shared_brackets', 'shared_votes'] loop
    execute format('drop trigger if exists keep_newer on public.%I', t);
    execute format('create trigger keep_newer before insert or update on public.%I for each row execute function public.keep_newer()', t);
  end loop;
end $$;

-- ---------- Indexes for pulling changes ----------
create index if not exists likes_synced on public.likes (synced_at);
create index if not exists user_records_synced on public.user_records (synced_at);
create index if not exists catalog_tracks_synced on public.catalog_tracks (synced_at);
create index if not exists catalog_albums_synced on public.catalog_albums (synced_at);
create index if not exists catalog_artists_synced on public.catalog_artists (synced_at);
create index if not exists shared_votes_synced on public.shared_votes (synced_at);

-- ---------- Row level security ----------
alter table public.profiles enable row level security;
alter table public.catalog_tracks enable row level security;
alter table public.catalog_albums enable row level security;
alter table public.catalog_artists enable row level security;
alter table public.likes enable row level security;
alter table public.user_records enable row level security;
alter table public.shared_brackets enable row level security;
alter table public.shared_votes enable row level security;
alter table public.shared_results enable row level security;

-- Everyone signed in can read everything (only allowlisted Spotify accounts can sign in).
do $$
declare t text;
begin
  foreach t in array array['profiles', 'catalog_tracks', 'catalog_albums', 'catalog_artists', 'likes', 'user_records', 'shared_brackets', 'shared_votes', 'shared_results'] loop
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('create policy read_all on public.%I for select to authenticated using (true)', t);
  end loop;
  -- Shared catalog: everyone signed in can add and update.
  foreach t in array array['catalog_tracks', 'catalog_albums', 'catalog_artists'] loop
    execute format('drop policy if exists write_catalog on public.%I', t);
    execute format('create policy write_catalog on public.%I for insert to authenticated with check (true)', t);
    execute format('drop policy if exists update_catalog on public.%I', t);
    execute format('create policy update_catalog on public.%I for update to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Own rows only.
drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists own_likes on public.likes;
create policy own_likes on public.likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists own_records on public.user_records;
create policy own_records on public.user_records for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists own_votes on public.shared_votes;
create policy own_votes on public.shared_votes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists create_bracket on public.shared_brackets;
create policy create_bracket on public.shared_brackets for insert to authenticated with check (created_by = auth.uid());
drop policy if exists delete_own_bracket on public.shared_brackets;
create policy delete_own_bracket on public.shared_brackets for delete to authenticated using (created_by = auth.uid());
drop policy if exists record_result on public.shared_results;
create policy record_result on public.shared_results for insert to authenticated with check (true);

-- ---------- Delete my account ----------
-- Removes the caller's auth user; everything they own goes with it (on delete cascade).
-- The shared catalog stays, it holds only public Spotify metadata.
create or replace function public.delete_my_account()
returns void language sql security definer set search_path = public as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
