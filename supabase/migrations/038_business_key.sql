



alter table public.license_registrations add column if not exists location_id uuid;

create index if not exists idx_license_registrations_location
  on public.license_registrations (location_id);


comment on column public.licenses.kind is
  'register = legacy per-location key; manager = tenant-wide portal code; business = one key per business (POS picks a location, owner console is tenant-wide).';
