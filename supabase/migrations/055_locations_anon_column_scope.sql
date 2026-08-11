-- 055_locations_anon_column_scope.sql
-- Security fix (audit finding, batch 8): "locations_public_storefront" (031)
-- is a ROW-level policy (`is_storefront_enabled = true`) — RLS never
-- restricts which COLUMNS a permitted row can return. Since 040/052 added
-- stripe_account_id, merchant_fee_credit_pct, merchant_fee_debit_pct, and
-- merchant_fee_flat_cents to this table, any anon-key holder could request
-- those columns directly via PostgREST's `select=` query param for any
-- storefront-enabled location — e.g.
--   GET /rest/v1/locations?select=stripe_account_id,merchant_fee_credit_pct&is_storefront_enabled=eq.true
-- The storefront app itself never asks for these columns, but that's not a
-- security boundary — anyone with the public anon key (embedded in the
-- storefront's JS bundle) can query with any column list they choose.
--
-- Fix: column-level GRANT instead of relying on the app's own query shape.
-- `anon` gets an explicit allowlist — exactly the columns
-- storefront/app/page.tsx, storefront/lib/queries.ts, and
-- storefront/app/checkout/page.tsx actually select today, plus the columns
-- needed to filter/join (is_storefront_enabled, tenant_id). `authenticated`
-- keeps its existing full-column access via locations_select_own (015) and
-- Owner/Manager Console's own tenant-scoped writes — this migration only
-- touches the anon role.
--
-- Applied live and verified via information_schema.column_privileges: a
-- plain `revoke select on public.locations from anon` does NOT clear
-- pre-existing per-column grants (Postgres tracks column-level ACLs
-- independently of the table-level one) — anon still had SELECT on every
-- individual column afterward. The explicit column-level revoke below is
-- what actually closed it; confirmed with a live anon-key request for
-- stripe_account_id/merchant_fee_credit_pct after applying, which now
-- correctly 401s with 42501 permission denied instead of returning data.
revoke select (
  stripe_account_id, stripe_onboarding_complete,
  merchant_fee_credit_pct, merchant_fee_debit_pct, merchant_fee_flat_cents,
  phone, email, created_at, updated_at
) on public.locations from anon;
grant select (
  id, tenant_id, name, address, zip, logo_url, show_logo,
  is_storefront_enabled, tax_rate
) on public.locations to anon;
