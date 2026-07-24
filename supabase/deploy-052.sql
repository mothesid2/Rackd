-- Rackd cloud schema — deploy bundle for migration 052 (real merchant fee rate, replaces flat tip deduction).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.
--
-- IMPORTANT: run this BEFORE the next admin Edge Function deploy that adds the
-- setLocationMerchantFee action — that action is written defensively (isolated
-- from the core business-list query) so it fails safely even if run first, but
-- there's no reason to risk it. Run this, confirm it applies cleanly, then deploy.

-- ==================== supabase/migrations/052_merchant_fee_rate.sql ====================
-- 052_merchant_fee_rate.sql
--
-- Replaces the flat, manager-editable "tip pool deduction %" (legally risky —
-- an arbitrary skim booked as owner revenue is not defensible as a processing-
-- cost deduction from pooled tips) with an owner-only, per-location REAL
-- merchant/card-processing rate. Same rate also feeds an "estimated card
-- processing cost" line in revenue reporting, since card fees eat into
-- product-sale revenue too, not just tips. Default 0 (no deduction) until the
-- owner explicitly sets a real rate — never a guessed number.

alter table public.locations add column if not exists merchant_fee_pct numeric(5,2) not null default 0;
