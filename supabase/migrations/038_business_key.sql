-- 038_business_key.sql
-- Business-key model (spec: one auth key per BUSINESS, not per location).
--
-- Before: one license_key = one location (kind='register'), plus optional
-- tenant-wide kind='manager' codes. Now a single kind='business' key per tenant
-- is used by BOTH surfaces:
--   • Owner Console — activates with the key, requests NO location -> tenant-wide
--     token (location_id claim omitted -> current_location_id() is null -> sees
--     every location). Consumes no seat.
--   • POS kiosk     — activates with the SAME key, picks a location ONCE, then the
--     jwt-issuer mints a location-scoped token for that location and the kiosk is
--     locked to it locally. Consumes a seat.
--
-- Schema change is small: the seat registry records WHICH location a kiosk locked
-- to, so the Owner Console can show kiosks under their location and free a seat
-- per store. 'business' is just a new value of the existing free-text
-- licenses.kind column (added in 021) — no new column needed there.

-- Which location a registered kiosk bound to (null for legacy per-location or
-- manager registrations). Purely informational for the seat registry + console.
alter table public.license_registrations add column if not exists location_id uuid;

create index if not exists idx_license_registrations_location
  on public.license_registrations (location_id);

-- A business key's max_registers is the total kiosks allowed ACROSS all the
-- business's locations (seats are counted per license_key, which is now one key
-- for the whole business). No constraint change — documented here for intent.
comment on column public.licenses.kind is
  'register = legacy per-location key; manager = tenant-wide portal code; business = one key per business (POS picks a location, owner console is tenant-wide).';
