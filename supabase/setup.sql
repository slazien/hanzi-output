-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- One row per user holds that user's practice data as a JSON document.

create table if not exists public.progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- Row-level security: a signed-in user can read and write only their own row.
alter table public.progress enable row level security;

revoke all on public.progress from anon;
grant select, insert, update, delete on public.progress to authenticated;

drop policy if exists "own row: read" on public.progress;
drop policy if exists "own row: insert" on public.progress;
drop policy if exists "own row: update" on public.progress;
drop policy if exists "own row: delete" on public.progress;

create policy "own row: read" on public.progress
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own row: insert" on public.progress
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own row: update" on public.progress
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own row: delete" on public.progress
  for delete to authenticated using ((select auth.uid()) = user_id);
