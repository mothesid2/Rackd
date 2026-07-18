-- Rackd cloud schema — INCREMENTAL bundle: Phase 7 (refund linkage).
-- Apply after deploy-021.sql. Idempotent; paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/022_transactions_original.sql ====================
-- 022_transactions_original.sql
-- Phase 7: refunds are transactions linked to the sale they reverse. The local
-- transactions table gained original_txn_id (migration 006); mirror it here so the
-- push path (SELECT * -> upsert) doesn't hit an unknown column, and so the manager
-- portal can tell a refund from a sale.
alter table public.transactions_cloud add column if not exists original_txn_id bigint;
