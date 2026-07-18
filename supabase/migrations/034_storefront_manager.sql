-- 034_storefront_manager.sql
-- Manager-portal control surface for the storefront. Two needs the base schema
-- didn't cover:
--   1) Toggling a location's storefront on/off + its tax rate. locations is
--      service_role-write-only (015), so a plain PATCH from a manager token is
--      denied. This SECURITY DEFINER RPC lets a MANAGER (kind='manager', own
--      tenant) flip just those two fields — nothing else on the row.
--   2) Building the online menu: the portal already reads inventory_cloud +
--      storefront_products (tenant RLS) and upserts opt-in rows via the existing
--      sfp_manager_insert/update policies, so no new grant is needed there.

create or replace function public.set_storefront_settings(
  p_location uuid, p_enabled boolean, p_tax_rate numeric default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;

  update public.locations
     set is_storefront_enabled = coalesce(p_enabled, is_storefront_enabled),
         tax_rate = coalesce(p_tax_rate, tax_rate)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;

  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_settings(uuid, boolean, numeric) from public, anon;
grant execute on function public.set_storefront_settings(uuid, boolean, numeric) to authenticated;
