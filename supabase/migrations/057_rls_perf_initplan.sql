-- 057_rls_perf_initplan.sql
-- Performance hardening (audit batch 8, item 1 adjacent) — found via
-- `supabase db advisors --linked --type performance`: 4 tables have RLS
-- policies that call auth.uid()/auth.jwt() directly, which Postgres
-- re-evaluates per ROW instead of once per query. Standard fix per
-- Supabase's own docs: wrap in a scalar subquery so the planner caches it
-- as an InitPlan. Logic is byte-for-byte identical — only the auth.*() call
-- sites are wrapped, nothing about who can see/write what changes.
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
