

create or replace function public.storefront_menu(p_location uuid)
returns table (barcode text, name text, category text, price numeric, available integer, stock_status text)
language sql stable security definer set search_path = public as $$
  select sp.barcode,
         coalesce(inv.name, sp.barcode)                                   as name,
         inv.category,
         coalesce(sp.override_price, inv.price)                           as price,
         public.storefront_available(l.tenant_id, p_location, sp.barcode) as available,
         case
           when public.storefront_available(l.tenant_id, p_location, sp.barcode) <= 0 then 'out'
           when public.storefront_available(l.tenant_id, p_location, sp.barcode) <= 3 then 'low'
           else 'in'
         end                                                              as stock_status
    from public.storefront_products sp
    join public.locations l on l.id = sp.location_id and l.is_storefront_enabled
    left join lateral (
      select name, category, price from public.inventory_cloud
       where tenant_id = l.tenant_id and location_id = p_location and barcode = sp.barcode
       order by updated_at desc limit 1
    ) inv on true
   where sp.location_id = p_location and sp.is_visible
     and coalesce(sp.override_price, inv.price) is not null
   order by inv.category nulls last, name;
$$;
grant execute on function public.storefront_menu(uuid) to anon, authenticated;
