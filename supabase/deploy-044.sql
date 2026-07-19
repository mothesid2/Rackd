-- Rackd cloud schema — deploy bundle for migration 044 (location branding + zip).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/044_location_branding.sql ====================
-- 044_location_branding.sql
-- Storefront listing branding (batch 3, item 2): each location shows its physical
-- ADDRESS on the storefront listing, and can optionally show its own uploaded LOGO
-- instead of the default shopping-bag icon. Managers set these in the portal.
alter table public.locations add column if not exists address   text;
alter table public.locations add column if not exists zip       text;   -- for storefront proximity sort (item 3)
alter table public.locations add column if not exists logo_url  text;
alter table public.locations add column if not exists show_logo boolean not null default false;

-- Manager-only setter for the branding fields (locations is service-role-write-only).
-- null keeps the current value; show_logo toggles explicitly.
create or replace function public.set_storefront_branding(
  p_location uuid, p_address text default null, p_logo_url text default null,
  p_show_logo boolean default null, p_zip text default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;
  update public.locations
     set address   = coalesce(p_address, address),
         zip       = coalesce(p_zip, zip),
         logo_url  = coalesce(p_logo_url, logo_url),
         show_logo = coalesce(p_show_logo, show_logo)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_branding(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.set_storefront_branding(uuid, text, text, boolean, text) to authenticated;
