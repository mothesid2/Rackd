-- 037_storefront_customer_name.sql
-- Capture the customer's name at account creation so the storefront can greet a
-- returning customer by first name ("Welcome back, {first_name}"). Names live on
-- the auth-linked profile only (never synced to registers, like the other PII
-- fields here). Nullable so existing accounts keep working; the client fills
-- first_name from the sign-in form / auth user_metadata on first authenticated load.
alter table public.storefront_customers add column if not exists first_name text;
alter table public.storefront_customers add column if not exists last_name  text;
