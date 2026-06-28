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
