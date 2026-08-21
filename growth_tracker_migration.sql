-- ReaderBull: Book Growth Tracker tables (19 August 2026, see
-- ReaderBull_Growth_Tracker_Data_Model_Plan_2026-08-19.md for the full
-- reasoning, and Section 6.2 of ReaderBull_Master_Handover.md / rule 18 in
-- ReaderBull_Project_Rules.md for the approved design this schema serves).
--
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New
-- query), then Run. Paste this in as one block rather than typing it out
-- by hand, pasting avoids the editor's auto-close-bracket bug already hit
-- once on this project.
--
-- Two tables:
--   tracked_competitors:      which competitor books an author has chosen
--                              to track against one of their own books.
--   growth_tracker_snapshots: weekly time-series (reviews, category rank,
--                              estimated revenue) for the author's own
--                              book AND every tracked competitor, so the
--                              8-week trend chart has real history for
--                              all lines, not just competitors.
--
-- Both RLS-enabled, select-only for the owning author (auth.uid() =
-- user_id). No insert/update/delete policy for authenticated users, every
-- write happens server-side (api/growth-tracker.js, service_role key),
-- same reasoning as public.subscriptions: an author should never be able
-- to grant themselves extra tracked competitors, or forge a snapshot, by
-- editing client-side data.

create table if not exists public.tracked_competitors (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  amazon_url text,
  asin text,
  added_at timestamptz not null default now(),
  -- Soft delete: removing a competitor stops future snapshots and hides
  -- it from the pills/panels, but keeps its historical rows in
  -- growth_tracker_snapshots so past weeks on the trend chart don't
  -- silently lose a line if an author removes a competitor partway
  -- through.
  removed_at timestamptz
);

-- Stops the same ASIN being tracked twice on the same book while active.
-- Partial index (where removed_at is null) so a removed-then-re-added
-- competitor doesn't collide with its own old soft-deleted row.
create unique index if not exists tracked_competitors_active_asin_idx
  on public.tracked_competitors (book_id, asin)
  where removed_at is null and asin is not null;

create index if not exists tracked_competitors_book_active_idx
  on public.tracked_competitors (book_id, added_at)
  where removed_at is null;

alter table public.tracked_competitors enable row level security;

create policy "Authors can view their own tracked competitors"
  on public.tracked_competitors for select
  using (auth.uid() = user_id);

create table if not exists public.growth_tracker_snapshots (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Null for the author's own book, set for a competitor snapshot. Kept
  -- as two columns (snapshot_type + tracked_competitor_id) rather than
  -- one, so "give me every snapshot for this book's tracker" is a single
  -- book_id query, no join through tracked_competitors required for the
  -- dashboard's normal read path.
  snapshot_type text not null check (snapshot_type in ('own', 'competitor')),
  tracked_competitor_id uuid references public.tracked_competitors(id) on delete cascade,
  -- Non-null, stable dedupe key: the tracked competitor's own id (as
  -- text) for a competitor snapshot, or 'own:<book_id>' for the author's
  -- own book. Exists ONLY so a single, ordinary (non-partial) unique
  -- constraint below can be the upsert target from
  -- api/growth-tracker.js's weekly job. A partial unique index (e.g.
  -- "where snapshot_type = 'own'") can't be targeted by PostgREST's
  -- on_conflict=... query param, which emits a plain ON CONFLICT
  -- (columns) with no WHERE clause, so it silently would not match a
  -- partial index, worked out before writing the upsert call, not
  -- discovered by trial and error against production. A plain
  -- unique(tracked_competitor_id, week_start) alone wouldn't dedupe
  -- 'own' rows either way, since Postgres never treats two NULLs as
  -- equal, every 'own' snapshot would look like a fresh row.
  subject_key text not null,
  -- Monday of the ISO week the job ran, truncated. Comparable across all
  -- tracked books even though Hobby cron timing has up to +/- 59 minutes
  -- of slop, and the one field the trend chart and bar panels both group
  -- by.
  week_start date not null,
  reviews integer,
  category_rank integer,
  estimated_revenue numeric,
  captured_at timestamptz not null default now(),
  -- One snapshot per subject per week. Idempotent upsert target
  -- (Prefer: resolution=merge-duplicates via ?on_conflict=subject_key,week_start),
  -- important because Vercel's own cron docs call out that delivery can
  -- occasionally invoke the same scheduled run more than once, jobs
  -- should be safe to re-run.
  unique (subject_key, week_start)
);

create index if not exists growth_snapshots_book_week_idx
  on public.growth_tracker_snapshots (book_id, week_start);

alter table public.growth_tracker_snapshots enable row level security;

create policy "Authors can view their own growth tracker snapshots"
  on public.growth_tracker_snapshots for select
  using (auth.uid() = user_id);
