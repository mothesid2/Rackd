


create table if not exists public.customers_cloud (
  id              bigint not null,
  tenant_id       uuid not null,
  first_name      text not null,
  last_name       text,
  phone           text,
  email           text,
  address         text,
  city            text,
  state           text,
  zip             text,
  dob             text,
  license_number  text,
  notes           text,
  opt_in_sms      boolean not null default false,
  loyalty_points  integer not null default 0,
  lifetime_points integer not null default 0,
  gold_member     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_customers_cloud_tenant  on public.customers_cloud (tenant_id);
create index if not exists idx_customers_cloud_created on public.customers_cloud (created_at);

alter table public.customers_cloud enable row level security;

create policy "customers_cloud_insert_own"
  on public.customers_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "customers_cloud_update_own"
  on public.customers_cloud for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "customers_cloud_select_own"
  on public.customers_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_customers_cloud_updated_at
  before update on public.customers_cloud
  for each row execute function public.set_updated_at();
