-- Rackd cloud schema — INCREMENTAL bundle for multi-location (v3).
-- Apply to an already-provisioned project that is at migration 014.
-- Safe to re-run: every statement is idempotent (if not exists / drop-if-exists /
-- guarded backfill). Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/015_locations.sql ====================
-- 015_locations.sql
-- Multi-location foundation (spec v3): Tenant -> Location -> Register.
--
-- Before this, the model was flat: one license_key = one tenant_id = one store
-- (see 013_store_aggregates.sql). We introduce an explicit Location layer so a
-- tenant (business) can own multiple stores, each with its own auth code
-- (license_key) and its own set of registers (seats). Registers sharing a
-- location sync live data; they cannot see other locations.
--
-- This migration is non-breaking: it adds the location layer and backfills one
-- location per existing license, so single-store installs keep working. The
-- register/manager RLS split lands in 016.

-- ── auth helper: location id from the JWT ────────────────────────────────────
-- Mirrors public.current_tenant_id(). A register token carries location_id; a
-- manager (portal) token omits it, so this returns null and tenant-wide policies
-- apply. Added by the jwt-issuer Edge Function.
create or replace function public.current_location_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'location_id', '')::uuid;
$$;

-- ── locations ────────────────────────────────────────────────────────────────
create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  name       text not null default 'Store',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_locations_tenant on public.locations (tenant_id);

alter table public.locations enable row level security;

-- Readable by any authenticated token whose tenant matches (registers and the
-- manager portal both need to resolve their location name). Writes are
-- service_role only (owner console), so no insert/update/delete policies.
drop policy if exists "locations_select_own" on public.locations;
create policy "locations_select_own"
  on public.locations for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

drop trigger if exists trg_locations_updated_at on public.locations;
create trigger trg_locations_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();

-- ── licenses gain a location ────────────────────────────────────────────────
-- One license_key (auth code) belongs to exactly one location.
alter table public.licenses add column if not exists location_id uuid;

create index if not exists idx_licenses_location on public.licenses (location_id);

-- Backfill: every existing license becomes its own single location (named from
-- the license's tenant name when present). Idempotent — only fills nulls.
do $$
declare
  lic record;
  new_loc uuid;
begin
  for lic in select id, tenant_id, name from public.licenses where location_id is null loop
    insert into public.locations (tenant_id, name)
    values (lic.tenant_id, coalesce(lic.name, 'Store'))
    returning id into new_loc;

    update public.licenses set location_id = new_loc where id = lic.id;
  end loop;
end $$;

-- ==================== supabase/migrations/016_location_scoping.sql ====================
-- 016_location_scoping.sql
-- Add the location/register identity columns to the shared cloud mirrors and make
-- READS location-aware. Companion to 015_locations.sql.
--
-- Scoping model (works for both token tiers):
--   • Register token  -> carries location_id  -> sees only its location's rows.
--   • Manager token   -> omits location_id (current_location_id() is null)
--                        -> sees the whole tenant (all locations) for the portal.
--
-- NON-BREAKING BY DESIGN: only SELECT policies change here. INSERT/UPDATE stay
-- tenant-scoped (unchanged) because the push path in sync.ts does not yet stamp
-- location_id — write-scoping tightens in Phase 1 alongside that producer change.
-- Registers do no cloud SELECTs today (they read local SQLite), so the stricter
-- read policy has no runtime effect until the Phase 1 pull worker + manager portal
-- land; existing single-store rows are backfilled to their one location.

-- ── 1. add columns ───────────────────────────────────────────────────────────
-- location_id: which store the row belongs to (all shared tables).
-- register_id: which till produced it (till identity = license_registrations.machine_id).
-- uid:         stable cross-register identity for shared, updatable rows (customers).
alter table public.customers_cloud             add column if not exists location_id uuid;
alter table public.customers_cloud             add column if not exists register_id text;
alter table public.customers_cloud             add column if not exists uid uuid;
alter table public.inventory_cloud             add column if not exists location_id uuid;
alter table public.inventory_cloud             add column if not exists register_id text;
alter table public.transactions_cloud          add column if not exists location_id uuid;
alter table public.transactions_cloud          add column if not exists register_id text;
alter table public.transaction_items_cloud     add column if not exists location_id uuid;
alter table public.transaction_items_cloud     add column if not exists register_id text;
alter table public.cash_drawer_sessions_cloud  add column if not exists location_id uuid;
alter table public.cash_drawer_sessions_cloud  add column if not exists register_id text;

-- ── 2. backfill from the (single, pre-v3) location per tenant ────────────────
-- At this point each tenant still has exactly one license/location, so the join
-- is unambiguous. Idempotent: only fills nulls.
update public.customers_cloud            c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.inventory_cloud            c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.transactions_cloud         c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.transaction_items_cloud    c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.cash_drawer_sessions_cloud c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;

-- Existing rows all came from the single legacy register; give shared customers a
-- stable uid so the Phase 3 pull applier has an identity to key on.
update public.customers_cloud set register_id = 'legacy'          where register_id is null;
update public.customers_cloud set uid         = gen_random_uuid() where uid is null;
update public.inventory_cloud            set register_id = 'legacy' where register_id is null;
update public.transactions_cloud         set register_id = 'legacy' where register_id is null;
update public.transaction_items_cloud    set register_id = 'legacy' where register_id is null;
update public.cash_drawer_sessions_cloud set register_id = 'legacy' where register_id is null;

-- ── 3. indexes for the pull cursor (location + updated_at) ───────────────────
create index if not exists idx_customers_cloud_loc_upd            on public.customers_cloud            (location_id, updated_at);
create index if not exists idx_inventory_cloud_loc_upd            on public.inventory_cloud            (location_id, updated_at);
create index if not exists idx_transactions_cloud_loc_upd         on public.transactions_cloud         (location_id, updated_at);
create index if not exists idx_transaction_items_cloud_loc_upd    on public.transaction_items_cloud    (location_id, updated_at);
create index if not exists idx_cash_drawer_sessions_cloud_loc_upd on public.cash_drawer_sessions_cloud (location_id, updated_at);
create unique index if not exists idx_customers_cloud_tenant_uid  on public.customers_cloud            (tenant_id, uid);

-- ── 4. location-aware SELECT policies (register scope OR manager tenant-wide) ─
-- Reusable predicate, inlined per table:
--   tenant_id = current_tenant_id()
--   AND (current_location_id() IS NULL OR location_id = current_location_id())

drop policy if exists "customers_cloud_select_own" on public.customers_cloud;
create policy "customers_cloud_select_own"
  on public.customers_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "inventory_cloud_select_own" on public.inventory_cloud;
create policy "inventory_cloud_select_own"
  on public.inventory_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "transactions_cloud_select_own" on public.transactions_cloud;
create policy "transactions_cloud_select_own"
  on public.transactions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "transaction_items_cloud_select_own" on public.transaction_items_cloud;
create policy "transaction_items_cloud_select_own"
  on public.transaction_items_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "cash_drawer_sessions_cloud_select_own" on public.cash_drawer_sessions_cloud;
create policy "cash_drawer_sessions_cloud_select_own"
  on public.cash_drawer_sessions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

-- ==================== supabase/migrations/017_location_write_scoping.sql ====================
-- 017_location_write_scoping.sql
-- Tighten INSERT/UPDATE on the shared mirrors to be location-aware, now that the
-- push path (sync.ts) stamps location_id + register_id on every row.
--
-- Same predicate as the 016 read policies, so it degrades safely:
--   • Register token  -> location_id must equal current_location_id().
--   • Manager token / legacy pre-v3 token (no location claim) -> tenant-scoped,
--     exactly as before. This keeps writes working during the 24h token-refresh
--     window after the jwt-issuer change ships.

-- customers_cloud
drop policy if exists "customers_cloud_insert_own" on public.customers_cloud;
create policy "customers_cloud_insert_own"
  on public.customers_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "customers_cloud_update_own" on public.customers_cloud;
create policy "customers_cloud_update_own"
  on public.customers_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

-- inventory_cloud
drop policy if exists "inventory_cloud_insert_own" on public.inventory_cloud;
create policy "inventory_cloud_insert_own"
  on public.inventory_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "inventory_cloud_update_own" on public.inventory_cloud;
create policy "inventory_cloud_update_own"
  on public.inventory_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

-- transactions_cloud (insert-only)
drop policy if exists "transactions_cloud_insert_own" on public.transactions_cloud;
create policy "transactions_cloud_insert_own"
  on public.transactions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

-- transaction_items_cloud (insert-only)
drop policy if exists "transaction_items_cloud_insert_own" on public.transaction_items_cloud;
create policy "transaction_items_cloud_insert_own"
  on public.transaction_items_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

-- cash_drawer_sessions_cloud (insert-only)
drop policy if exists "cash_drawer_sessions_cloud_insert_own" on public.cash_drawer_sessions_cloud;
create policy "cash_drawer_sessions_cloud_insert_own"
  on public.cash_drawer_sessions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));

