

create table if not exists public.categories_cloud (
  uid         uuid not null,
  tenant_id   uuid not null,
  name        text not null,
  is_active   boolean not null default true,
  register_id text,                
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, uid)
);
create index if not exists idx_categories_cloud_upd on public.categories_cloud (tenant_id, updated_at);
alter table public.categories_cloud enable row level security;


drop policy if exists "categories_cloud_select" on public.categories_cloud;
create policy "categories_cloud_select" on public.categories_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists "categories_cloud_insert" on public.categories_cloud;
create policy "categories_cloud_insert" on public.categories_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id());
drop policy if exists "categories_cloud_update" on public.categories_cloud;
create policy "categories_cloud_update" on public.categories_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());

create trigger trg_categories_cloud_updated_at before update on public.categories_cloud
  for each row execute function public.set_updated_at();
