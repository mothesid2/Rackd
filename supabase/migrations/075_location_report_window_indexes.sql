

create index if not exists idx_transactions_cloud_report_window
  on public.transactions_cloud (tenant_id, location_id, created_at);

create index if not exists idx_transaction_items_cloud_report_window
  on public.transaction_items_cloud (tenant_id, location_id, created_at);
