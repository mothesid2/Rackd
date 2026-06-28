-- 005_inventory_cloud.sql
-- Cloud reporting layer for stock levels. The cloud is reporting-only, NOT the
-- source of truth: the local source is the canonical `products` table (the
-- `inventory` local table was consolidated away in migration 002). The sync
-- worker pushes lean stock-level snapshots (update/upsert), so descriptive
-- columns are nullable and `id` = the local product id.

create table if not exists public.inventory_cloud (
  id                bigint not null,        -- = local products.id
  tenant_id         uuid not null,
  product_id        bigint,                 -- mirrors id (carried in the snapshot payload)
  sku               text,                   -- from product_variants when present, else null
  barcode           text,
  name              text,                   -- nullable: lean snapshots omit it
  category          text,
  price             numeric(12,2),
  cost              numeric(12,2),
  quantity          integer not null default 0,
  reorder_point     integer,
  is_active         boolean default true,
  adjustment_reason text,                   -- 'sale' | 'manual'
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_inventory_cloud_tenant  on public.inventory_cloud (tenant_id);
create index if not exists idx_inventory_cloud_created on public.inventory_cloud (created_at);

alter table public.inventory_cloud enable row level security;

-- Upsert needs both insert (first sight) and update (subsequent snapshots).
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
