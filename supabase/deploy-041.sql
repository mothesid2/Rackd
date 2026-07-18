-- Rackd cloud schema — deploy bundle for migration 041 (online receipt auto-print flag).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/041_online_receipt_print.sql ====================
-- 041_online_receipt_print.sql
-- Auto-print coordination for online pickup receipts (spec item 9).
--
-- When an online order is paid, the destination location's POS auto-prints a
-- prepaid pickup receipt — no cashier action. `receipt_printed_at` is the claim
-- flag: a register at the location atomically sets it (update ... where
-- receipt_printed_at is null) so exactly ONE register prints, even if several are
-- online. Staff already have UPDATE on online_orders (oo_update_staff), so no new
-- policy is needed.
alter table public.online_orders add column if not exists receipt_printed_at timestamptz;
