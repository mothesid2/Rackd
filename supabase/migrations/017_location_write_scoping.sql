



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


drop policy if exists "transactions_cloud_insert_own" on public.transactions_cloud;
create policy "transactions_cloud_insert_own"
  on public.transactions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));


drop policy if exists "transaction_items_cloud_insert_own" on public.transaction_items_cloud;
create policy "transaction_items_cloud_insert_own"
  on public.transaction_items_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));


drop policy if exists "cash_drawer_sessions_cloud_insert_own" on public.cash_drawer_sessions_cloud;
create policy "cash_drawer_sessions_cloud_insert_own"
  on public.cash_drawer_sessions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and (public.current_location_id() is null or location_id = public.current_location_id()));
