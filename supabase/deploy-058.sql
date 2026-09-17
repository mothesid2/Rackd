

alter table public.inventory_cloud drop constraint if exists inventory_cloud_pkey;
alter table public.inventory_cloud add column if not exists cloud_id bigint generated always as identity;
alter table public.inventory_cloud add primary key (cloud_id);

create unique index if not exists idx_inventory_cloud_register_scope
  on public.inventory_cloud (tenant_id, register_id, id);
