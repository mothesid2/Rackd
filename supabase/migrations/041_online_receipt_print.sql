

alter table public.online_orders add column if not exists receipt_printed_at timestamptz;
