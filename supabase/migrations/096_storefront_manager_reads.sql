-- 096: read helpers for the Storefront Manager UI (one call each, identical for staff and Owner Console tokens).
-- They are SECURITY DEFINER so the module never depends on the RLS of tables like inventory_cloud or employees_cloud
-- (which differ by token kind); each one re-checks storefront permissions and tenant ownership itself.
-- Reverse with supabase/down/096_down.sql.

create or replace function public.sf_my_permissions()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'owner', public.sf_is_owner(),
    'admin', public.sf_is_admin_role(),
    'view', public.sf_can('storefront.view'),
    'items_edit', public.sf_can('storefront.items.edit'),
    'orders_manage', public.sf_can('storefront.orders.manage'),
    'settings_edit', public.sf_can('storefront.settings.edit'),
    'reports_view', public.sf_can('storefront.reports.view'),
    'fees_view', public.sf_can('storefront.fees.view'),
    'manage_staff', public.sf_is_owner() or public.sf_is_admin_role());
$$;

-- Items with POS data resolved (name, price, quantity come live from the POS inventory for source='pos').
create or replace function public.sf_items_list(p_location uuid)
returns table (id uuid, source text, pos_product_id text, name text, brand text, flavor text, size text, price numeric, image_url text,
               category text, status text, qty integer, available integer, sort_order integer, read_only boolean, pos_missing boolean, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.sf_can('storefront.view') then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.sf_location_tenant(p_location) is distinct from public.current_tenant_id() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select it.id, it.source, it.pos_product_id, coalesce(it.name, inv.name), it.brand, it.flavor, it.size, coalesce(it.price, inv.price), it.image_url,
         coalesce(it.category, inv.category), it.status,
         case when it.source = 'pos' then inv.quantity else it.qty end,
         public.sf_item_available(it.id), it.sort_order, it.source = 'pos', it.source = 'pos' and inv.barcode is null, it.updated_at
    from public.storefront_items it
    left join lateral (select i.barcode, i.name, i.category, i.price, i.quantity from public.inventory_cloud i
                        where it.source = 'pos' and i.tenant_id = it.tenant_id and i.location_id = it.location_id and i.barcode = it.pos_product_id
                        order by i.updated_at desc limit 1) inv on true
   where it.location_id = p_location
   order by it.sort_order, it.created_at;
end;
$$;

-- "Add from my POS": search the location's POS inventory.
create or replace function public.sf_pos_products(p_location uuid, p_search text default null, p_limit integer default 40)
returns table (barcode text, name text, category text, price numeric, quantity integer, already_added boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.sf_can('storefront.items.edit') then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.sf_location_tenant(p_location) is distinct from public.current_tenant_id() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select distinct on (i.barcode) i.barcode, i.name, i.category, i.price, i.quantity,
         exists (select 1 from public.storefront_items s where s.location_id = p_location and s.source = 'pos' and s.pos_product_id = i.barcode)
    from public.inventory_cloud i
   where i.tenant_id = public.current_tenant_id() and i.location_id = p_location and i.barcode is not null and coalesce(i.is_active, true)
     and (p_search is null or trim(p_search) = '' or i.name ilike '%' || replace(replace(trim(p_search), '%', ''), '_', '') || '%' or i.barcode = trim(p_search))
   order by i.barcode, i.updated_at desc
   limit greatest(1, least(p_limit, 200));
end;
$$;

-- Staff and their effective storefront permissions (owner or admin only: this is the permission editor).
create or replace function public.sf_staff_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare keys text[] := array['storefront.view', 'storefront.items.edit', 'storefront.orders.manage', 'storefront.settings.edit', 'storefront.reports.view', 'storefront.fees.view'];
begin
  if not (public.sf_is_owner() or public.sf_is_admin_role()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'uid', e.uid, 'name', coalesce(e.name, e.username), 'username', e.username, 'role', e.role, 'active', coalesce(e.is_active, true),
      'permissions', (select jsonb_object_agg(k, case when e.role = 'admin' then true else coalesce(
                        (select p.is_granted from public.employee_permissions_cloud p where p.tenant_id = e.tenant_id and p.employee_uid = e.uid and p.permission_key = k order by p.updated_at desc limit 1),
                        public.sf_default_grant(k)) end) from unnest(keys) k),
      'locked', e.role = 'admin') order by e.role, e.name)
      from public.employees_cloud e
     where e.tenant_id = public.current_tenant_id() and e.role in ('admin', 'manager')), '[]'::jsonb);
end;
$$;

-- Owner Console tokens are not "managers" for the legacy image policy; let them upload storefront photos too.
drop policy if exists product_images_owner_write on storage.objects;
create policy product_images_owner_write on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.sf_is_owner() and (storage.foldername(name))[1] = public.current_tenant_id()::text);

revoke all on function public.sf_my_permissions(), public.sf_items_list(uuid), public.sf_pos_products(uuid, text, integer), public.sf_staff_list() from public, anon;
grant execute on function public.sf_my_permissions(), public.sf_items_list(uuid), public.sf_pos_products(uuid, text, integer), public.sf_staff_list() to authenticated;
