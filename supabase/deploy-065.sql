



create policy "transactions_cloud_delete_own" on public.transactions_cloud for delete to authenticated
  using (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());

create policy "transaction_items_cloud_delete_own" on public.transaction_items_cloud for delete to authenticated
  using (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());
