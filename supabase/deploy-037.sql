-- Rackd cloud schema — deploy bundle for migration 037 (storefront customer name).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/037_storefront_customer_name.sql ====================
-- Capture the customer's name at account creation so the storefront can greet a
-- returning customer by first name. Nullable; the client backfills first_name from
-- the sign-in form / auth user_metadata on first authenticated load.
alter table public.storefront_customers add column if not exists first_name text;
alter table public.storefront_customers add column if not exists last_name  text;
