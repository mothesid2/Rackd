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
