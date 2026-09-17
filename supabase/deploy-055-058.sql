






revoke select (
  stripe_account_id, stripe_onboarding_complete,
  merchant_fee_credit_pct, merchant_fee_debit_pct, merchant_fee_flat_cents,
  phone, email, created_at, updated_at
) on public.locations from anon;
grant select (
  id, tenant_id, name, address, zip, logo_url, show_logo,
  is_storefront_enabled, tax_rate
) on public.locations to anon;





revoke execute on function public.store_sales_by_location(timestamptz, timestamptz) from anon, authenticated, public;





drop policy if exists "sfc_select_self" on public.storefront_customers;
create policy "sfc_select_self" on public.storefront_customers for select to authenticated
  using ((select auth.uid()) = id);
drop policy if exists "sfc_insert_self" on public.storefront_customers;
create policy "sfc_insert_self" on public.storefront_customers for insert to authenticated
  with check ((select auth.uid()) = id);
drop policy if exists "sfc_update_self" on public.storefront_customers;
create policy "sfc_update_self" on public.storefront_customers for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "oo_select" on public.online_orders;
create policy "oo_select" on public.online_orders for select to authenticated
  using (
    (select auth.uid()) = customer_id
    or (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  );

drop policy if exists "ooi_select" on public.online_order_items;
create policy "ooi_select" on public.online_order_items for select to authenticated
  using (exists (select 1 from public.online_orders o where o.id = order_id and (
    (select auth.uid()) = o.customer_id
    or (o.tenant_id = public.current_tenant_id() and (public.is_manager() or o.location_id = public.current_location_id()))
  )));

drop policy if exists "regcmd_select_own" on public.register_commands;
create policy "regcmd_select_own" on public.register_commands for select to authenticated
  using (tenant_id = public.current_tenant_id() and machine_id = ((select auth.jwt()) ->> 'register_id'));
drop policy if exists "regcmd_update_own" on public.register_commands;
create policy "regcmd_update_own" on public.register_commands for update to authenticated
  using (tenant_id = public.current_tenant_id() and machine_id = ((select auth.jwt()) ->> 'register_id'))
  with check (tenant_id = public.current_tenant_id() and machine_id = ((select auth.jwt()) ->> 'register_id'));






alter table public.inventory_cloud drop constraint if exists inventory_cloud_pkey;
alter table public.inventory_cloud add column if not exists cloud_id bigint generated always as identity;
alter table public.inventory_cloud add primary key (cloud_id);

create unique index if not exists idx_inventory_cloud_register_scope
  on public.inventory_cloud (tenant_id, register_id, id);
