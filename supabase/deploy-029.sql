





create table if not exists public.employees_cloud (
  uid           uuid not null,
  tenant_id     uuid not null,
  location_id   uuid,
  register_id   text,
  username      text,
  name          text,
  role          text,                 
  password_hash text,                 
  pin_hash      text,                 
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, uid)
);
create index if not exists idx_employees_cloud_loc_upd on public.employees_cloud (location_id, updated_at);
alter table public.employees_cloud enable row level security;
drop policy if exists "employees_cloud_select" on public.employees_cloud;
create policy "employees_cloud_select" on public.employees_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "employees_cloud_insert" on public.employees_cloud;
create policy "employees_cloud_insert" on public.employees_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "employees_cloud_update" on public.employees_cloud;
create policy "employees_cloud_update" on public.employees_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
create trigger trg_employees_cloud_updated_at before update on public.employees_cloud
  for each row execute function public.set_updated_at();


create table if not exists public.employee_permissions_cloud (
  uid            uuid not null,
  tenant_id      uuid not null,
  location_id    uuid,
  register_id    text,
  employee_uid   uuid not null,
  permission_key text not null,
  is_granted     boolean not null default false,
  value          numeric,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, uid)
);
create index if not exists idx_emp_perm_cloud_loc_upd on public.employee_permissions_cloud (location_id, updated_at);
alter table public.employee_permissions_cloud enable row level security;
drop policy if exists "emp_perm_cloud_select" on public.employee_permissions_cloud;
create policy "emp_perm_cloud_select" on public.employee_permissions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "emp_perm_cloud_insert" on public.employee_permissions_cloud;
create policy "emp_perm_cloud_insert" on public.employee_permissions_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "emp_perm_cloud_update" on public.employee_permissions_cloud;
create policy "emp_perm_cloud_update" on public.employee_permissions_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
create trigger trg_emp_perm_cloud_updated_at before update on public.employee_permissions_cloud
  for each row execute function public.set_updated_at();


create table if not exists public.permission_override_log_cloud (
  uid                      uuid primary key,
  tenant_id                uuid not null,
  location_id              uuid,
  register_id              text,
  at                       timestamptz,
  acting_employee_uid      uuid,
  acting_employee_name     text,
  action_attempted         text,
  required_permission      text,
  authorizing_manager_uid  uuid,
  authorizing_manager_name text,
  was_approved             boolean not null default false,
  event_type               text not null default 'override',
  transaction_id           bigint,
  created_at               timestamptz not null default now()
);
create index if not exists idx_override_log_cloud on public.permission_override_log_cloud (tenant_id, at);
alter table public.permission_override_log_cloud enable row level security;

drop policy if exists "override_log_cloud_insert" on public.permission_override_log_cloud;
create policy "override_log_cloud_insert" on public.permission_override_log_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and (public.current_location_id() is null or location_id = public.current_location_id()));
drop policy if exists "override_log_cloud_select" on public.permission_override_log_cloud;
create policy "override_log_cloud_select" on public.permission_override_log_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));


create or replace function public.block_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'permission_override_log is append-only; % is not allowed', tg_op;
end;
$$;
drop trigger if exists trg_override_log_immutable on public.permission_override_log_cloud;
create trigger trg_override_log_immutable
  before update or delete on public.permission_override_log_cloud
  for each row execute function public.block_mutation();
