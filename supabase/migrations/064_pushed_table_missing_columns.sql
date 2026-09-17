

alter table public.transactions_cloud add column if not exists order_source text;
alter table public.transactions_cloud add column if not exists online_order_id text;
alter table public.transactions_cloud add column if not exists original_txn_id bigint;
