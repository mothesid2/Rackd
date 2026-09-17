





delete from public.inventory_cloud a
using public.inventory_cloud b
where a.tenant_id = b.tenant_id
  and a.register_id = b.register_id
  and a.barcode = b.barcode
  and a.barcode is not null
  and (a.updated_at, a.cloud_id) < (b.updated_at, b.cloud_id);


drop index if exists public.idx_inventory_cloud_register_scope;


create unique index if not exists idx_inventory_cloud_register_barcode
  on public.inventory_cloud (tenant_id, register_id, barcode);
