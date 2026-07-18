-- Rackd cloud schema — INCREMENTAL bundle: Phase 2 (inventory event-deltas).
-- Apply after deploy-015-017.sql. Idempotent; paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/018_stock_movements.sql ====================
-- 018_stock_movements.sql
-- Inventory event-deltas (spec v3, Phase 2). The append-only movement log that
-- lets registers in a location share live stock while staying offline-first.
--
-- Each row is one immutable stock change (delta). Registers push their own
-- movements and pull peers' movements for their location, replaying each exactly
-- once (dedup on movement_uid) to keep local stock_qty convergent. Insert-only:
-- a movement is never updated or deleted. inventory_cloud stays the reporting
-- mirror (absolute snapshots); this is the sharing substrate.

create table if not exists public.stock_movements_cloud (
  movement_uid uuid primary key,          -- client-generated; global dedup identity
  tenant_id    uuid not null,
  location_id  uuid,                       -- store scope (pull filters on this)
  register_id  text,                       -- origin till (peers skip their own)
  product_id   bigint,                     -- origin register's local product id (advisory)
  barcode      text,                       -- cross-register product identity (primary)
  sku          text,                       -- cross-register product identity (fallback)
  delta        integer not null,           -- signed: -sold / +received / +returned
  reason       text not null,              -- 'sale' | 'manual' | 'receive' | 'return'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_stock_movements_cloud_loc_upd on public.stock_movements_cloud (location_id, updated_at);
create index if not exists idx_stock_movements_cloud_tenant  on public.stock_movements_cloud (tenant_id);

alter table public.stock_movements_cloud enable row level security;

-- Location-aware insert (register scoped to its store; manager/legacy token
-- tenant-scoped). No update/delete policy — the log is append-only.
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
