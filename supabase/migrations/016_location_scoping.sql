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
