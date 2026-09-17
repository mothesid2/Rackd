


alter table public.transactions_cloud add column if not exists register_id text;
alter table public.transactions_cloud drop constraint if exists transactions_cloud_pkey;
alter table public.transactions_cloud add column if not exists cloud_id bigint generated always as identity;
alter table public.transactions_cloud add primary key (cloud_id);
create unique index if not exists idx_transactions_cloud_register_scope
  on public.transactions_cloud (tenant_id, register_id, id);

alter table public.transaction_items_cloud add column if not exists register_id text;
alter table public.transaction_items_cloud drop constraint if exists transaction_items_cloud_pkey;
alter table public.transaction_items_cloud add column if not exists cloud_id bigint generated always as identity;
alter table public.transaction_items_cloud add primary key (cloud_id);
create unique index if not exists idx_transaction_items_cloud_register_scope
  on public.transaction_items_cloud (tenant_id, register_id, id);

create index if not exists idx_transaction_items_cloud_txn_scope
  on public.transaction_items_cloud (tenant_id, register_id, transaction_id);

alter table public.cash_drawer_sessions_cloud add column if not exists register_id text;
alter table public.cash_drawer_sessions_cloud drop constraint if exists cash_drawer_sessions_cloud_pkey;
alter table public.cash_drawer_sessions_cloud add column if not exists cloud_id bigint generated always as identity;
alter table public.cash_drawer_sessions_cloud add primary key (cloud_id);
create unique index if not exists idx_cash_drawer_sessions_cloud_register_scope
  on public.cash_drawer_sessions_cloud (tenant_id, register_id, id);
