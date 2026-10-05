-- Vidu Kadhu — Row Level Security
-- Run this in the Supabase dashboard → SQL Editor (service role, bypasses RLS).
--
-- Goal: turn RLS ON everywhere (removes the "RLS disabled" security warning and
-- stops the public anon key from editing your content), while keeping every
-- query the game actually makes working.
--
-- Honest scope note: the app has NO user authentication — every player uses the
-- public anon key — so these policies CANNOT stop one player from tampering with
-- another room's rows (that needs auth or server-side RPCs, a larger change).
-- What they DO give you:
--   • content tables (categories, words) become read-only to the public — nobody
--     can wipe or edit your word lists via the anon key; you still edit them in
--     the dashboard (service role bypasses RLS).
--   • game tables (rooms, players, votes) stay fully usable by the client.
-- Apply during a quiet moment and smoke-test a quick game afterward.

-- 1) Enable RLS
alter table rooms      enable row level security;
alter table players    enable row level security;
alter table votes      enable row level security;
alter table categories enable row level security;
alter table words      enable row level security;

-- 2) Content tables — public read, no public writes.
drop policy if exists "categories public read" on categories;
create policy "categories public read" on categories for select using (true);

drop policy if exists "words public read" on words;
create policy "words public read" on words for select using (true);

-- 3) Game tables — the client needs full CRUD (create/join rooms, cast & clear
--    votes, update status/flags, leave/kick). Permissive by design.
drop policy if exists "rooms anon all" on rooms;
create policy "rooms anon all" on rooms for all using (true) with check (true);

drop policy if exists "players anon all" on players;
create policy "players anon all" on players for all using (true) with check (true);

drop policy if exists "votes anon all" on votes;
create policy "votes anon all" on votes for all using (true) with check (true);

-- Rollback (if a smoke test fails, disable RLS again):
--   alter table rooms disable row level security;
--   alter table players disable row level security;
--   alter table votes disable row level security;
--   alter table categories disable row level security;
--   alter table words disable row level security;
