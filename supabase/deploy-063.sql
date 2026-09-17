



alter table public.customers_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_customers_cloud_pull_order on public.customers_cloud (updated_at, cloud_id);

alter table public.stock_movements_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_stock_movements_cloud_pull_order on public.stock_movements_cloud (updated_at, cloud_id);

alter table public.manufacturers_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_manufacturers_cloud_pull_order on public.manufacturers_cloud (updated_at, cloud_id);

alter table public.rebate_rules_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_rebate_rules_cloud_pull_order on public.rebate_rules_cloud (updated_at, cloud_id);

alter table public.employees_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_employees_cloud_pull_order on public.employees_cloud (updated_at, cloud_id);

alter table public.employee_permissions_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_employee_permissions_cloud_pull_order on public.employee_permissions_cloud (updated_at, cloud_id);

alter table public.time_clock_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_time_clock_cloud_pull_order on public.time_clock_cloud (updated_at, cloud_id);


create index if not exists idx_inventory_cloud_pull_order on public.inventory_cloud (updated_at, cloud_id);
