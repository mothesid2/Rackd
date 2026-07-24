-- 051_twilio_owner_managed.sql
--
-- Twilio SMS config moves from POS Settings (per-kiosk, editable by any manager)
-- to Owner Console only (business-wide, owner-only). Columns live on the
-- business's `licenses` row, same treatment as contact_email/contact_phone
-- (migration 049) — no client insert/update policy exists on `licenses`, so
-- only the service-role `admin` Edge Function can write these. Every kiosk
-- already pulls its own license row down via the existing license-cache
-- refresh (src/main/supabase/licenseCheck.ts), so no new sync mechanism is
-- needed — just new columns to carry along.

alter table public.licenses add column if not exists twilio_account_sid text;
alter table public.licenses add column if not exists twilio_auth_token text;
alter table public.licenses add column if not exists twilio_from_number text;
