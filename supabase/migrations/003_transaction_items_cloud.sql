


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
