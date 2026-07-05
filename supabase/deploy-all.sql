-- Rackd cloud schema — paste into Supabase SQL editor and Run.
-- Generated from supabase/migrations/*.sql (in order).

-- ==================== supabase/migrations/001_licenses.sql ====================
-- 001_licenses.sql
-- Licensing table + shared helpers used by every later migration.
--
-- RLS multi-tenancy assumes the client authenticates with a JWT carrying
-- `tenant_id` and `license_key` claims (e.g. a per-install signed token). The
-- anon key alone has no tenant context. The service_role key bypasses RLS and
-- is used server-side to provision/manage licenses.

-- ── shared helpers (defined once, reused by all cloud tables) ───────────────

-- Auto-update updated_at on every row UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Tenant id from the authenticated JWT.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
$$;

-- License key from the authenticated JWT.
create or replace function public.current_license_key()
returns text
language sql
stable
as $$
  select auth.jwt() ->> 'license_key';
$$;

-- ── licenses ────────────────────────────────────────────────────────────────
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
-- license_key already has a unique btree index from the UNIQUE constraint.

alter table public.licenses enable row level security;

-- A client may read ONLY its own license row, matched by license_key. There are
-- intentionally NO insert/update/delete policies: clients can never write here;
-- only the service_role (which bypasses RLS) manages licenses.
create policy "licenses_select_own"
  on public.licenses for select
  to authenticated
  using (license_key = public.current_license_key());

create trigger trg_licenses_updated_at
  before update on public.licenses
  for each row execute function public.set_updated_at();

-- ==================== supabase/migrations/002_transactions_cloud.sql ====================
-- 002_transactions_cloud.sql
-- Cloud mirror of local `transactions` (insert-only; a completed sale is never
-- updated or deleted in the cloud). Columns match the local row the sync worker
-- pushes; `id` is the local transaction id, scoped per tenant.

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

-- ==================== supabase/migrations/003_transaction_items_cloud.sql ====================
-- 003_transaction_items_cloud.sql
-- Cloud mirror of local `transaction_items` (insert-only). Line items belonging
-- to a transactions_cloud row, scoped per tenant.

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

-- ==================== supabase/migrations/004_customers_cloud.sql ====================
-- 004_customers_cloud.sql
-- Cloud mirror of local `customers` (insert + update). Last-write-wins on
-- updated_at is enforced by the sync worker before it upserts here.

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

-- ==================== supabase/migrations/005_inventory_cloud.sql ====================
-- 005_inventory_cloud.sql
-- Cloud reporting layer for stock levels. The cloud is reporting-only, NOT the
-- source of truth: the local source is the canonical `products` table (the
-- `inventory` local table was consolidated away in migration 002). The sync
-- worker pushes lean stock-level snapshots (update/upsert), so descriptive
-- columns are nullable and `id` = the local product id.

create table if not exists public.inventory_cloud (
  id                bigint not null,        -- = local products.id
  tenant_id         uuid not null,
  product_id        bigint,                 -- mirrors id (carried in the snapshot payload)
  sku               text,                   -- from product_variants when present, else null
  barcode           text,
  name              text,                   -- nullable: lean snapshots omit it
  category          text,
  price             numeric(12,2),
  cost              numeric(12,2),
  quantity          integer not null default 0,
  reorder_point     integer,
  is_active         boolean default true,
  adjustment_reason text,                   -- 'sale' | 'manual'
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_inventory_cloud_tenant  on public.inventory_cloud (tenant_id);
create index if not exists idx_inventory_cloud_created on public.inventory_cloud (created_at);

alter table public.inventory_cloud enable row level security;

-- Upsert needs both insert (first sight) and update (subsequent snapshots).
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

-- ==================== supabase/migrations/006_cash_drawer_sessions_cloud.sql ====================
-- 006_cash_drawer_sessions_cloud.sql
-- Cloud mirror of cash-drawer activity (insert-only).
--
-- MODELING DECISION: the app does not track formal open/close drawer *sessions*
-- with float/over-short; it records discrete drawer *events* in the local
-- `drawer_log` table (manual_open, cash_sale, cash_drop). So this cloud table is
-- modeled as an event log mirroring drawer_log, keyed by the local event id.
-- A richer session model can be layered on later if the POS starts tracking it.

create table if not exists public.cash_drawer_sessions_cloud (
  id            bigint not null,   -- = local drawer_log.id
  tenant_id     uuid not null,
  employee_id   integer,           -- drawer_log.cashier_id
  cashier_name  text,
  event         text not null,     -- 'manual_open' | 'cash_sale' | 'cash_drop'
  amount        numeric(12,2) not null default 0,
  note          text,
  opened_at     timestamptz,       -- event timestamp (drawer_log.created_at)
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

-- ==================== supabase/migrations/007_scan_data_queue.sql ====================
-- 007_scan_data_queue.sql
-- Manufacturer rebate scan submissions. Insert-only from the client; reads are
-- restricted to the service_role (the rebate processor). The `submitted` flag is
-- the sync/processing status, advanced server-side.

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

-- Insert only from client; intentionally NO select policy for tenants — only the
-- service_role (bypasses RLS) reads this queue to submit rebates.
create policy "scan_data_queue_insert_own"
  on public.scan_data_queue for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create trigger trg_scan_data_queue_updated_at
  before update on public.scan_data_queue
  for each row execute function public.set_updated_at();

-- ==================== supabase/migrations/008_sms_campaigns.sql ====================
-- 008_sms_campaigns.sql
-- Twilio SMS marketing campaigns. Cloud-native (not mirrored from local); uuid
-- PK. Tenants can read and insert their own campaigns; deletes are service_role
-- only (no delete policy). `status` is the campaign/sync state.

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

-- No delete policy: only the service_role (bypasses RLS) may delete campaigns.

create trigger trg_sms_campaigns_updated_at
  before update on public.sms_campaigns
  for each row execute function public.set_updated_at();

-- ==================== supabase/migrations/009_settings_backup.sql ====================
-- 009_settings_backup.sql
-- Cloud backup of local settings (the local `settings` table itself is never
-- synced; this is an explicit, separate backup). One row per (tenant, key).
-- Tenants read/insert/update their own backup rows.

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

-- ==================== supabase/migrations/010_conflicts.sql ====================
-- 010_conflicts.sql
-- Cloud surface for sync conflicts so the manager PWA can review/resolve them.
-- Mirrors the local `conflicts` table (uuid PK here). Tenants read/insert/update
-- their own conflict rows.
--
-- NOTE: the local `conflicts` table is currently in the sync worker's NEVER_SYNC
-- set, so nothing populates this cloud table yet. If conflicts should appear in
-- a cloud PWA, either allow conflicts in the sync policy or have the PWA read
-- them from the local DB. Flagged for follow-up.

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

