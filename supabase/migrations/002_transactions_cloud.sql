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
