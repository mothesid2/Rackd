-- Rackd cloud schema — INCREMENTAL bundle: security hardening (H-1 + L-2).
-- Apply after deploy-022.sql. Idempotent; paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/023_rls_fail_closed.sql ====================
-- 023_rls_fail_closed.sql
-- Security hardening (review findings H-1 + L-2).
--
-- H-1: the 016/017/018 policies granted tenant-wide access whenever the token had
-- NO location_id ("current_location_id() is null"). That is fail-OPEN: a register
-- token that somehow lacks a location silently gets every location in its tenant.
-- Replace that with an explicit manager check (public.is_manager()) so a register
-- with a missing/null location fails CLOSED (sees nothing) instead.
--
-- L-2: managers were able to write EVERY location-scoped table (stock movements,
-- transactions, …). A manager is a reporting + light-management role, so its writes
-- are now limited to customers_cloud (the only thing the portal edits). Registers
-- still write their own location's rows; managers can no longer write stock/sales.

-- ── explicit role predicate (reads the signed 'kind' claim) ─────────────────
create or replace function public.is_manager()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'kind', 'register') = 'manager';
$$;

-- ── SELECT: manager (tenant-wide) OR own location. Fail-closed for registers ──
-- customers_cloud
drop policy if exists "customers_cloud_select_own" on public.customers_cloud;
create policy "customers_cloud_select_own" on public.customers_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- inventory_cloud
drop policy if exists "inventory_cloud_select_own" on public.inventory_cloud;
create policy "inventory_cloud_select_own" on public.inventory_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- transactions_cloud
drop policy if exists "transactions_cloud_select_own" on public.transactions_cloud;
create policy "transactions_cloud_select_own" on public.transactions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- transaction_items_cloud
drop policy if exists "transaction_items_cloud_select_own" on public.transaction_items_cloud;
create policy "transaction_items_cloud_select_own" on public.transaction_items_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- cash_drawer_sessions_cloud
drop policy if exists "cash_drawer_sessions_cloud_select_own" on public.cash_drawer_sessions_cloud;
create policy "cash_drawer_sessions_cloud_select_own" on public.cash_drawer_sessions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- stock_movements_cloud
drop policy if exists "stock_movements_cloud_select_own" on public.stock_movements_cloud;
create policy "stock_movements_cloud_select_own" on public.stock_movements_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- ── WRITE: customers may be written by a manager (portal) OR the owning register.
--    Everything else is register-only (own location); managers cannot write it. ──

-- customers_cloud (manager light-management edits + register writes)
drop policy if exists "customers_cloud_insert_own" on public.customers_cloud;
create policy "customers_cloud_insert_own" on public.customers_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "customers_cloud_update_own" on public.customers_cloud;
create policy "customers_cloud_update_own" on public.customers_cloud for update to authenticated
  using      (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- inventory_cloud (register-only)
drop policy if exists "inventory_cloud_insert_own" on public.inventory_cloud;
create policy "inventory_cloud_insert_own" on public.inventory_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());
drop policy if exists "inventory_cloud_update_own" on public.inventory_cloud;
create policy "inventory_cloud_update_own" on public.inventory_cloud for update to authenticated
  using      (tenant_id = public.current_tenant_id() and location_id = public.current_location_id())
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());

-- transactions_cloud (register-only, insert)
drop policy if exists "transactions_cloud_insert_own" on public.transactions_cloud;
create policy "transactions_cloud_insert_own" on public.transactions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());

-- transaction_items_cloud (register-only, insert)
drop policy if exists "transaction_items_cloud_insert_own" on public.transaction_items_cloud;
create policy "transaction_items_cloud_insert_own" on public.transaction_items_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());

-- cash_drawer_sessions_cloud (register-only, insert)
drop policy if exists "cash_drawer_sessions_cloud_insert_own" on public.cash_drawer_sessions_cloud;
create policy "cash_drawer_sessions_cloud_insert_own" on public.cash_drawer_sessions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());

-- stock_movements_cloud (register-only, insert)
drop policy if exists "stock_movements_cloud_insert_own" on public.stock_movements_cloud;
create policy "stock_movements_cloud_insert_own" on public.stock_movements_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());
