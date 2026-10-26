-- 094: one-time backfill from the legacy storefront (storefront_products) into the Storefront Manager tables.
-- Idempotent. Reverse with supabase/down/094_down.sql (removes only rows this migration created).
--
-- LEFT UNCHANGED ON PURPOSE: online_orders, online_order_items, online_order_pickups, storefront_products and the
-- Stripe Connect card flow. They keep working for history; the card flow is gated by STRIPE_PRODUCT_PAYMENTS_ENABLED.
-- NOT CARRIED OVER: storefront_products.override_price. POS-sync items always show the POS price (read-only).

do $$
declare n_settings integer; n_items integer; n_override integer;
begin
  insert into public.storefront_settings (location_id, tenant_id, enabled, inventory_mode)
  select l.id, l.tenant_id, l.is_storefront_enabled, 'pos_sync'
    from public.locations l
   where l.is_storefront_enabled or exists (select 1 from public.storefront_products sp where sp.location_id = l.id)
  on conflict (location_id) do nothing;
  get diagnostics n_settings = row_count;

  insert into public.storefront_items (tenant_id, location_id, source, pos_product_id, status, sort_order)
  select sp.tenant_id, sp.location_id, 'pos', sp.barcode,
         case when sp.is_visible then 'available' else 'hidden' end,
         (row_number() over (partition by sp.location_id order by sp.created_at, sp.barcode))::integer
    from public.storefront_products sp
    join public.storefront_settings s on s.location_id = sp.location_id and s.inventory_mode = 'pos_sync'
   where exists (select 1 from public.inventory_cloud i where i.tenant_id = sp.tenant_id and i.location_id = sp.location_id and i.barcode = sp.barcode)
  on conflict do nothing;
  get diagnostics n_items = row_count;

  select count(*) into n_override from public.storefront_products where override_price is not null;
  raise notice 'storefront backfill: % settings rows, % items; % legacy override prices were not carried over', n_settings, n_items, n_override;
end $$;
