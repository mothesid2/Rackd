




alter table public.employees_cloud add column if not exists must_change_password boolean not null default false;
alter table public.employees_cloud add column if not exists must_change_pin      boolean not null default false;


drop policy if exists "employees_cloud_select" on public.employees_cloud;
create policy "employees_cloud_select" on public.employees_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists "employees_cloud_insert" on public.employees_cloud;
create policy "employees_cloud_insert" on public.employees_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "employees_cloud_update" on public.employees_cloud;
create policy "employees_cloud_update" on public.employees_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
