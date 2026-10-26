delete from public.hardware_bundles where slug in ('full-pos-bundle', 'counter-lite-bundle', 'online-only-bundle');
delete from public.hardware_products where sku in (
  'POS-FULL','POS-LITE','KIT-ONLINE','ACC-VP100','ACC-SCAN','ACC-PRINT','ACC-DRAWER','ACC-IDSCAN','ACC-UPS','ACC-PAPER','ACC-CABLE')
  and not exists (select 1 from public.hardware_order_items i where i.product_id = hardware_products.id);
