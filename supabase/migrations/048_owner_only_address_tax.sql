-- 048_owner_only_address_tax.sql
--
-- Items 10 & 11 (UI/UX batch): a location's ADDRESS and online-store TAX RATE are
-- now owner-controlled only, not manager-editable. The Manager Portal UI no longer
-- shows editable fields for either (portal.js), but this migration also closes the
-- door server-side so a direct RPC call can't bypass that UI change:
--
--   • set_storefront_settings drops its p_tax_rate write. The tax rate is instead
--     derived automatically from the location's ZIP by the owner-only
--     set_location_address RPC below (a flat, editable-by-nobody lookup table —
--     good enough for a per-store estimate; refine the table as needed).
--   • set_storefront_branding drops its p_address/p_zip writes — address/zip are
--     now set exclusively via the service-role `admin` Edge Function (Owner
--     Console), never by a manager token.
--   • set_location_address (NEW): service-role only (Owner Console), sets
--     address + zip and recomputes tax_rate from the zip in one call.

-- ── a flat, coarse ZIP-prefix -> approximate combined sales tax rate table ────
-- Keyed by the first 3 digits of the ZIP (USPS ZIP3 ranges roughly track state
-- lines). Deliberately approximate — a real tax-rate API can replace this table
-- later without changing any caller.
create table if not exists public.zip3_tax_rates (
  zip3     text primary key,
  rate     numeric(6,4) not null
);
alter table public.zip3_tax_rates enable row level security;
-- Read-only reference data — no client (manager or POS) needs direct access;
-- only the SECURITY DEFINER functions below read it. No policies -> no access
-- for `authenticated`; service_role bypasses RLS for the seed insert.

create or replace function public.tax_rate_for_zip(p_zip text, p_default numeric default 0.0825)
returns numeric language sql stable set search_path = public as $$
  select coalesce(
    (select rate from public.zip3_tax_rates where zip3 = left(regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g'), 3)),
    p_default
  );
$$;

-- ── set_storefront_settings: manager may only toggle on/off, never the tax rate ─
create or replace function public.set_storefront_settings(
  p_location uuid, p_enabled boolean, p_tax_rate numeric default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;

  if coalesce(p_enabled, false) then
    if not exists (
      select 1 from public.locations
       where id = p_location and tenant_id = public.current_tenant_id() and stripe_onboarding_complete
    ) then
      raise exception 'stripe_onboarding_required';
    end if;
  end if;

  -- p_tax_rate is intentionally ignored: tax rate is owner/location-address
  -- derived only (item 11), never manager-settable, regardless of what a caller
  -- sends.
  update public.locations
     set is_storefront_enabled = coalesce(p_enabled, is_storefront_enabled)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;

  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_settings(uuid, boolean, numeric) from public, anon;
grant execute on function public.set_storefront_settings(uuid, boolean, numeric) to authenticated;

-- ── set_storefront_branding: manager may only set logo, never address/zip ──────
create or replace function public.set_storefront_branding(
  p_location uuid, p_address text default null, p_logo_url text default null,
  p_show_logo boolean default null, p_zip text default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;
  -- p_address/p_zip are intentionally ignored here (item 10): address is set once,
  -- by the owner, via set_location_address below. Only logo fields are manager-set.
  update public.locations
     set logo_url  = coalesce(p_logo_url, logo_url),
         show_logo = coalesce(p_show_logo, show_logo)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_branding(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.set_storefront_branding(uuid, text, text, boolean, text) to authenticated;

-- ── set_location_address: OWNER-ONLY (service role / admin Edge Function) ──────
-- Sets a location's address once at shop setup (and whenever the owner needs to
-- correct it), and recomputes tax_rate from the zip in the same call so the two
-- never drift apart. Not exposed to `authenticated` — only the admin Edge
-- Function (service role) calls this.
create or replace function public.set_location_address(
  p_location uuid, p_address text, p_zip text
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  update public.locations
     set address   = coalesce(p_address, address),
         zip       = coalesce(p_zip, zip),
         tax_rate  = public.tax_rate_for_zip(coalesce(p_zip, zip), tax_rate)
   where id = p_location
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_location_address(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_location_address(uuid, text, text) to service_role;

-- ── seed a handful of common state rates by ZIP3 prefix (extend as needed) ─────
insert into public.zip3_tax_rates (zip3, rate) values
  ('000', 0.0625), -- fallback bucket, unused (no real ZIP starts with 000)
  ('750', 0.0825), ('751', 0.0825), ('752', 0.0825), ('753', 0.0825), ('754', 0.0825), -- TX (Dallas/Ft Worth/Tyler area)
  ('770', 0.0825), ('772', 0.0825), ('773', 0.0825), ('774', 0.0825), ('775', 0.0825), -- TX (Houston area)
  ('787', 0.0825), ('786', 0.0825),                                                    -- TX (Austin area)
  ('900', 0.0950), ('901', 0.0950), ('902', 0.0950), ('906', 0.0950),                   -- CA (LA area)
  ('941', 0.0863), ('944', 0.0863),                                                     -- CA (SF Bay area)
  ('100', 0.0888), ('101', 0.0888), ('102', 0.0888),                                    -- NY (Manhattan)
  ('600', 0.1025), ('606', 0.1025),                                                     -- IL (Chicago)
  ('850', 0.0860), ('852', 0.0860),                                                     -- AZ (Phoenix)
  ('300', 0.0790), ('303', 0.0790),                                                     -- GA (Atlanta)
  ('331', 0.0700), ('332', 0.0700), ('334', 0.0700),                                     -- FL (Miami/S FL)
  ('980', 0.1025), ('981', 0.1025)                                                       -- WA (Seattle)
on conflict (zip3) do nothing;
