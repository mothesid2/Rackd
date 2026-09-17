


create table if not exists public.stock_movements_cloud (
  movement_uid uuid primary key,          
  tenant_id    uuid not null,
  location_id  uuid,                       
  register_id  text,                       
  product_id   bigint,                     
  barcode      text,                       
  sku          text,                       
  delta        integer not null,           
  reason       text not null,              
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_stock_movements_cloud_loc_upd on public.stock_movements_cloud (location_id, updated_at);
create index if not exists idx_stock_movements_cloud_tenant  on public.stock_movements_cloud (tenant_id);

alter table public.stock_movements_cloud enable row level security;


drop policy if exists "stock_movements_cloud_insert_own" on public.stock_movements_cloud;
create policy "stock_movements_cloud_insert_own"
  on public.stock_movements_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "stock_movements_cloud_select_own" on public.stock_movements_cloud;
create policy "stock_movements_cloud_select_own"
  on public.stock_movements_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

create trigger trg_stock_movements_cloud_updated_at
  before update on public.stock_movements_cloud
  for each row execute function public.set_updated_at();
