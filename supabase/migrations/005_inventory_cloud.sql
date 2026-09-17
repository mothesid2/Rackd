


create table if not exists public.inventory_cloud (
  id                bigint not null,        
  tenant_id         uuid not null,
  product_id        bigint,                 
  sku               text,                   
  barcode           text,
  name              text,                   
  category          text,
  price             numeric(12,2),
  cost              numeric(12,2),
  quantity          integer not null default 0,
  reorder_point     integer,
  is_active         boolean default true,
  adjustment_reason text,                   
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_inventory_cloud_tenant  on public.inventory_cloud (tenant_id);
create index if not exists idx_inventory_cloud_created on public.inventory_cloud (created_at);

alter table public.inventory_cloud enable row level security;


create policy "inventory_cloud_insert_own"
  on public.inventory_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "inventory_cloud_update_own"
  on public.inventory_cloud for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "inventory_cloud_select_own"
  on public.inventory_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_inventory_cloud_updated_at
  before update on public.inventory_cloud
  for each row execute function public.set_updated_at();
