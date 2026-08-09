-- Rackd cloud schema — deploy bundle for migration 053 (time clock soft-delete, for Manager Portal shift add/delete).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/053_time_clock_soft_delete.sql ====================
-- 053_time_clock_soft_delete.sql
--
-- Manager Portal timesheets get full control (add + delete a shift), not just
-- correcting an existing punch's times. Adding a shift needs nothing new —
-- 030's INSERT policy already lets a manager token insert tenant-wide.
--
-- Deleting is the part that needs care. Punches sync to kiosks via the same
-- peer-pull every other table uses (src/main/supabase/sync.ts pullCycle):
-- purely additive, upsert-by-uid, no concept of "this row disappeared
-- upstream." A real SQL DELETE here would leave a stale copy on any kiosk
-- that already pulled the punch — and tip-pool/X-Z reporting run off the
-- LOCAL copy on the kiosk generating the report, so a stale punch would keep
-- counting hours after being "deleted." Soft-delete instead: a manager
-- "deleting" a shift just sets deleted=true (a normal UPDATE, already covered
-- by 030's existing update policy — no new RLS needed), which rides the
-- existing pull/apply path like any other correction. src/main/supabase/sync.ts
-- applyTimeClock turns that into a real local DELETE on the kiosk, so nothing
-- downstream (tip pool, X/Z reports) needs to know this column exists.
alter table public.time_clock_cloud add column if not exists deleted boolean not null default false;
create index if not exists idx_time_clock_cloud_deleted on public.time_clock_cloud (deleted) where deleted;
