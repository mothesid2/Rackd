






create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
$$;


create or replace function public.current_license_key()
returns text
language sql
stable
as $$
  select auth.jwt() ->> 'license_key';
$$;


create table if not exists public.licenses (
  id            uuid primary key default gen_random_uuid(),
  license_key   text unique not null,
  tenant_id     uuid not null,
  active        boolean not null default true,
  tier          text check (tier in ('core','standard','pro','enterprise')),
  features      text[] not null default '{}',
  expires_at    timestamptz,
  max_registers integer not null default 1,
  location_count integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_licenses_tenant  on public.licenses (tenant_id);
create index if not exists idx_licenses_created  on public.licenses (created_at);


alter table public.licenses enable row level security;


create policy "licenses_select_own"
  on public.licenses for select
  to authenticated
  using (license_key = public.current_license_key());

create trigger trg_licenses_updated_at
  before update on public.licenses
  for each row execute function public.set_updated_at();



create table if not exists public.transactions_cloud (
  id              bigint not null,
  tenant_id       uuid not null,
  cashier_id      integer,
  customer_id     integer,
  subtotal        numeric(12,2) not null default 0,
  tax_rate        numeric(6,4) not null default 0,
  tax_amount      numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  total           numeric(12,2) not null default 0,
  payment_method  text,
  payment_status  text,
  terminal_ref    text,
  cash_tendered   numeric(12,2),
  change_given    numeric(12,2),
  tip_amount      numeric(12,2),
  card_type       text,
  last4           text,
  auth_code       text,
  signature_data  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_transactions_cloud_tenant  on public.transactions_cloud (tenant_id);
create index if not exists idx_transactions_cloud_created on public.transactions_cloud (created_at);

alter table public.transactions_cloud enable row level security;

create policy "transactions_cloud_insert_own"
  on public.transactions_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "transactions_cloud_select_own"
  on public.transactions_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_transactions_cloud_updated_at
  before update on public.transactions_cloud
  for each row execute function public.set_updated_at();



create table if not exists public.transaction_items_cloud (
  id             bigint not null,
  tenant_id      uuid not null,
  transaction_id bigint not null,
  product_id     integer,
  variant_id     integer,
  qty            integer not null default 1,
  unit_price     numeric(12,2) not null default 0,
  line_total     numeric(12,2) not null default 0,
  description    text,
  category       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_transaction_items_cloud_tenant  on public.transaction_items_cloud (tenant_id);
create index if not exists idx_transaction_items_cloud_created on public.transaction_items_cloud (created_at);
create index if not exists idx_transaction_items_cloud_txn     on public.transaction_items_cloud (tenant_id, transaction_id);

alter table public.transaction_items_cloud enable row level security;

create policy "transaction_items_cloud_insert_own"
  on public.transaction_items_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "transaction_items_cloud_select_own"
  on public.transaction_items_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_transaction_items_cloud_updated_at
  before update on public.transaction_items_cloud
  for each row execute function public.set_updated_at();



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



create table if not exists public.inventory_cloud (
  id                bigint not null,        
  tenant_id         uuid not null,
  product_id        bigint,                 
  sku               text,                   
  barcode           text,
  name              text,                   
  category          text,
  price             numeric(12,2),
  cost              numeric(12,2),
  quantity          integer not null default 0,
  reorder_point     integer,
  is_active         boolean default true,
  adjustment_reason text,                   
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_inventory_cloud_tenant  on public.inventory_cloud (tenant_id);
create index if not exists idx_inventory_cloud_created on public.inventory_cloud (created_at);

alter table public.inventory_cloud enable row level security;


create policy "inventory_cloud_insert_own"
  on public.inventory_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "inventory_cloud_update_own"
  on public.inventory_cloud for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "inventory_cloud_select_own"
  on public.inventory_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_inventory_cloud_updated_at
  before update on public.inventory_cloud
  for each row execute function public.set_updated_at();



create table if not exists public.cash_drawer_sessions_cloud (
  id            bigint not null,   
  tenant_id     uuid not null,
  employee_id   integer,           
  cashier_name  text,
  event         text not null,     
  amount        numeric(12,2) not null default 0,
  note          text,
  opened_at     timestamptz,       
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_cash_drawer_sessions_cloud_tenant  on public.cash_drawer_sessions_cloud (tenant_id);
create index if not exists idx_cash_drawer_sessions_cloud_created on public.cash_drawer_sessions_cloud (created_at);

alter table public.cash_drawer_sessions_cloud enable row level security;

create policy "cash_drawer_sessions_cloud_insert_own"
  on public.cash_drawer_sessions_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "cash_drawer_sessions_cloud_select_own"
  on public.cash_drawer_sessions_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_cash_drawer_sessions_cloud_updated_at
  before update on public.cash_drawer_sessions_cloud
  for each row execute function public.set_updated_at();



create table if not exists public.scan_data_queue (
  id             bigint not null,
  tenant_id      uuid not null,
  upc            text,
  quantity       integer not null default 1,
  unit_price     numeric(12,2),
  manufacturer   text,
  transaction_id bigint,
  sold_at        timestamptz,
  payload        jsonb,
  submitted      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_scan_data_queue_tenant    on public.scan_data_queue (tenant_id);
create index if not exists idx_scan_data_queue_created   on public.scan_data_queue (created_at);
create index if not exists idx_scan_data_queue_submitted on public.scan_data_queue (submitted);

alter table public.scan_data_queue enable row level security;


create policy "scan_data_queue_insert_own"
  on public.scan_data_queue for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create trigger trg_scan_data_queue_updated_at
  before update on public.scan_data_queue
  for each row execute function public.set_updated_at();



create table if not exists public.sms_campaigns (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  name         text not null,
  message      text not null,
  status       text not null default 'draft' check (status in ('draft','scheduled','sending','sent','failed')),
  scheduled_at timestamptz,
  sent_count   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_sms_campaigns_tenant  on public.sms_campaigns (tenant_id);
create index if not exists idx_sms_campaigns_created on public.sms_campaigns (created_at);
create index if not exists idx_sms_campaigns_status  on public.sms_campaigns (status);

alter table public.sms_campaigns enable row level security;

create policy "sms_campaigns_select_own"
  on public.sms_campaigns for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "sms_campaigns_insert_own"
  on public.sms_campaigns for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());



create trigger trg_sms_campaigns_updated_at
  before update on public.sms_campaigns
  for each row execute function public.set_updated_at();



create table if not exists public.settings_backup (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  key        text not null,
  value      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create index if not exists idx_settings_backup_tenant  on public.settings_backup (tenant_id);
create index if not exists idx_settings_backup_created on public.settings_backup (created_at);

alter table public.settings_backup enable row level security;

create policy "settings_backup_select_own"
  on public.settings_backup for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "settings_backup_insert_own"
  on public.settings_backup for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "settings_backup_update_own"
  on public.settings_backup for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create trigger trg_settings_backup_updated_at
  before update on public.settings_backup
  for each row execute function public.set_updated_at();



create table if not exists public.conflicts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  table_name        text not null,
  record_id         text not null,
  local_updated_at  timestamptz,
  remote_updated_at timestamptz,
  local_payload     jsonb,
  resolved          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_conflicts_tenant   on public.conflicts (tenant_id);
create index if not exists idx_conflicts_created  on public.conflicts (created_at);
create index if not exists idx_conflicts_resolved on public.conflicts (resolved);

alter table public.conflicts enable row level security;

create policy "conflicts_select_own"
  on public.conflicts for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "conflicts_insert_own"
  on public.conflicts for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "conflicts_update_own"
  on public.conflicts for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create trigger trg_conflicts_updated_at
  before update on public.conflicts
  for each row execute function public.set_updated_at();



create table if not exists public.license_registrations (
  id           uuid primary key default gen_random_uuid(),
  license_key  text not null,
  tenant_id    uuid not null,
  machine_id   text not null,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (license_key, machine_id)
);

create index if not exists idx_license_registrations_key    on public.license_registrations (license_key);
create index if not exists idx_license_registrations_tenant on public.license_registrations (tenant_id);

alter table public.license_registrations enable row level security;




alter table public.licenses add column if not exists name text;
alter table public.licenses add column if not exists display_config jsonb not null default '{}'::jsonb;

