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
