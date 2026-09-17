





create or replace function public.current_location_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'location_id', '')::uuid;
$$;


create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  name       text not null default 'Store',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_locations_tenant on public.locations (tenant_id);

alter table public.locations enable row level security;


drop policy if exists "locations_select_own" on public.locations;
create policy "locations_select_own"
  on public.locations for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

drop trigger if exists trg_locations_updated_at on public.locations;
create trigger trg_locations_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();


alter table public.licenses add column if not exists location_id uuid;

create index if not exists idx_licenses_location on public.licenses (location_id);


do $$
declare
  lic record;
  new_loc uuid;
begin
  for lic in select id, tenant_id, name from public.licenses where location_id is null loop
    insert into public.locations (tenant_id, name)
    values (lic.tenant_id, coalesce(lic.name, 'Store'))
    returning id into new_loc;

    update public.licenses set location_id = new_loc where id = lic.id;
  end loop;
end $$;




alter table public.customers_cloud             add column if not exists location_id uuid;
alter table public.customers_cloud             add column if not exists register_id text;
alter table public.customers_cloud             add column if not exists uid uuid;
alter table public.inventory_cloud             add column if not exists location_id uuid;
alter table public.inventory_cloud             add column if not exists register_id text;
alter table public.transactions_cloud          add column if not exists location_id uuid;
alter table public.transactions_cloud          add column if not exists register_id text;
alter table public.transaction_items_cloud     add column if not exists location_id uuid;
alter table public.transaction_items_cloud     add column if not exists register_id text;
alter table public.cash_drawer_sessions_cloud  add column if not exists location_id uuid;
alter table public.cash_drawer_sessions_cloud  add column if not exists register_id text;


update public.customers_cloud            c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.inventory_cloud            c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.transactions_cloud         c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.transaction_items_cloud    c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;
update public.cash_drawer_sessions_cloud c set location_id = l.location_id from public.licenses l where c.location_id is null and c.tenant_id = l.tenant_id;


update public.customers_cloud set register_id = 'legacy'          where register_id is null;
update public.customers_cloud set uid         = gen_random_uuid() where uid is null;
update public.inventory_cloud            set register_id = 'legacy' where register_id is null;
update public.transactions_cloud         set register_id = 'legacy' where register_id is null;
update public.transaction_items_cloud    set register_id = 'legacy' where register_id is null;
update public.cash_drawer_sessions_cloud set register_id = 'legacy' where register_id is null;


create index if not exists idx_customers_cloud_loc_upd            on public.customers_cloud            (location_id, updated_at);
create index if not exists idx_inventory_cloud_loc_upd            on public.inventory_cloud            (location_id, updated_at);
create index if not exists idx_transactions_cloud_loc_upd         on public.transactions_cloud         (location_id, updated_at);
create index if not exists idx_transaction_items_cloud_loc_upd    on public.transaction_items_cloud    (location_id, updated_at);
create index if not exists idx_cash_drawer_sessions_cloud_loc_upd on public.cash_drawer_sessions_cloud (location_id, updated_at);
create unique index if not exists idx_customers_cloud_tenant_uid  on public.customers_cloud            (tenant_id, uid);



drop policy if exists "customers_cloud_select_own" on public.customers_cloud;
create policy "customers_cloud_select_own"
  on public.customers_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "inventory_cloud_select_own" on public.inventory_cloud;
create policy "inventory_cloud_select_own"
  on public.inventory_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "transactions_cloud_select_own" on public.transactions_cloud;
create policy "transactions_cloud_select_own"
  on public.transactions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "transaction_items_cloud_select_own" on public.transaction_items_cloud;
create policy "transaction_items_cloud_select_own"
  on public.transaction_items_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));

drop policy if exists "cash_drawer_sessions_cloud_select_own" on public.cash_drawer_sessions_cloud;
create policy "cash_drawer_sessions_cloud_select_own"
  on public.cash_drawer_sessions_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and (public.current_location_id() is null or location_id = public.current_location_id()));




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

