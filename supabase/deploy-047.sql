-- Rackd cloud schema — deploy bundle for migration 047 (per-use-case SMS consent).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/047_sms_consent.sql ====================
-- 047_sms_consent.sql
--
-- Per-use-case SMS opt-in, recorded on the customer profile. Carriers (A2P 10DLC)
-- require explicit, logged consent for each message category, gathered on the same
-- screen as the phone number. Transactional = order/pickup texts; marketing =
-- promotions. `sms_consent_at` timestamps the most recent change for the audit trail.
alter table public.storefront_customers add column if not exists sms_consent_transactional boolean not null default false;
alter table public.storefront_customers add column if not exists sms_consent_marketing    boolean not null default false;
alter table public.storefront_customers add column if not exists sms_consent_at            timestamptz;
