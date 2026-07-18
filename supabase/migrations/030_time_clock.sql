-- 030_time_clock.sql
-- Employee time-clock punches, location-scoped so they sync across a store's
-- registers. Same RLS shape as the other location config: register sees its own
-- location, manager sees the tenant.
create table if not exists public.time_clock_cloud (
  uid           uuid not null,
  tenant_id     uuid not null,
  location_id   uuid,
  register_id   text,
  employee_uid  uuid not null,
  employee_name text,
  clock_in      timestamptz,
  clock_out     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, uid)
);
create index if not exists idx_time_clock_cloud_loc_upd on public.time_clock_cloud (location_id, updated_at);
alter table public.time_clock_cloud enable row level security;
drop policy if exists "time_clock_cloud_select" on public.time_clock_cloud;
create policy "time_clock_cloud_select" on public.time_clock_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "time_clock_cloud_insert" on public.time_clock_cloud;
create policy "time_clock_cloud_insert" on public.time_clock_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
drop policy if exists "time_clock_cloud_update" on public.time_clock_cloud;
create policy "time_clock_cloud_update" on public.time_clock_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
create trigger trg_time_clock_cloud_updated_at before update on public.time_clock_cloud
  for each row execute function public.set_updated_at();
