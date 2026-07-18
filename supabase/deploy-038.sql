-- Rackd cloud schema — deploy bundle for migration 038 (business-key model).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/038_business_key.sql ====================
-- One auth key per BUSINESS. Owner Console -> tenant-wide token (no location);
-- POS kiosk -> picks a location once, gets a location-scoped token, locks to it.
-- The seat registry records which location a kiosk bound to. 'business' is a new
-- value of the existing licenses.kind text column — no new column there.
alter table public.license_registrations add column if not exists location_id uuid;

create index if not exists idx_license_registrations_location
  on public.license_registrations (location_id);

comment on column public.licenses.kind is
  'register = legacy per-location key; manager = tenant-wide portal code; business = one key per business (POS picks a location, owner console is tenant-wide).';
