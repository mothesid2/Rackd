-- 087: PLACEHOLDER hardware catalog. Idempotent; every row is_placeholder=true so the store shows a dev
-- banner. Prices and specs are NOT real: edit them in the admin console (audit-logged).
-- Reverse with supabase/down/087_down.sql.

insert into public.hardware_products (sku, name, category, description, price_cents, specs, stock_qty, max_per_order, sort_order) values
 ('POS-FULL',  'Full POS Station', 'station',
  '15.6 inch dual-screen POS (cashier + customer display), mini PC, VESA mount and stand.', 129900,
  '{"cashier_display":"15.6 inch (TBD)","customer_display":"TBD","cpu":"TBD","ram":"TBD","storage":"TBD","mount":"VESA (TBD)","stand":"TBD"}', 25, 5, 10),
 ('POS-LITE',  'Counter Lite', 'station',
  'Single-screen counter POS.', 79900,
  '{"display":"TBD","cpu":"TBD","ram":"TBD","storage":"TBD"}', 25, 5, 20),
 ('KIT-ONLINE','Online-Only Kit (Model B)', 'kit',
  'iPad, stand and power for the online order board.', 49900,
  '{"tablet":"iPad (model TBD)","stand":"TBD","power":"TBD"}', 25, 5, 30),
 ('ACC-VP100', 'Payment terminal (VP100)', 'accessory', 'Card terminal.', 24900, '{"model":"VP100"}', 50, 10, 40),
 ('ACC-SCAN',  'Bluetooth barcode scanner', 'accessory', 'Wireless 1D/2D scanner.', 8900, '{"connectivity":"Bluetooth (TBD)"}', 50, 10, 50),
 ('ACC-PRINT', 'Receipt printer (WiFi/BT)', 'accessory', 'Thermal receipt printer.', 17900, '{"connectivity":"WiFi / Bluetooth (TBD)"}', 50, 10, 60),
 ('ACC-DRAWER','Cash drawer + RJ11 cable', 'accessory', 'Cash drawer with RJ11 cable.', 12900, '{"cable":"RJ11"}', 50, 10, 70),
 ('ACC-IDSCAN','USB ID scanner', 'accessory', 'USB driver-license / ID scanner.', 19900, '{"connectivity":"USB"}', 50, 10, 80),
 ('ACC-UPS',   'UPS / surge protector', 'accessory', 'Battery backup and surge protection.', 8900, '{"capacity":"TBD"}', 50, 10, 90),
 ('ACC-PAPER', 'Thermal paper (case)', 'consumable', 'Case of thermal receipt paper.', 4900, '{"rolls_per_case":"TBD"}', 200, 20, 100),
 ('ACC-CABLE', 'Security cable', 'accessory', 'Anti-theft security cable.', 2900, '{}', 100, 10, 110)
on conflict (sku) do nothing;

insert into public.hardware_bundles (slug, name, description, model_fit, discount_cents, sort_order) values
 ('full-pos-bundle',   'Full POS bundle',   'Dual-screen station with terminal, scanner, printer and drawer.', 'model_a', 10000, 10),
 ('counter-lite-bundle','Counter Lite bundle','Single-screen station with terminal, scanner, printer and drawer.', 'model_a', 7500, 20),
 ('online-only-bundle','Online-Only bundle', 'iPad order board kit for storefront-only shops.', 'model_b', 0, 30)
on conflict (slug) do nothing;

-- swap_group 'station' lets the bundle builder swap Full POS <-> Counter Lite
insert into public.hardware_bundle_items (bundle_id, product_id, quantity, swap_group, is_optional)
select b.id, p.id, x.qty, x.swap_group, x.opt
  from (values
    ('full-pos-bundle','POS-FULL',1,'station',false), ('full-pos-bundle','ACC-VP100',1,null,false),
    ('full-pos-bundle','ACC-SCAN',1,null,false), ('full-pos-bundle','ACC-PRINT',1,null,false),
    ('full-pos-bundle','ACC-DRAWER',1,null,false), ('full-pos-bundle','ACC-IDSCAN',1,null,true),
    ('full-pos-bundle','ACC-UPS',1,null,true), ('full-pos-bundle','ACC-PAPER',1,null,true),
    ('counter-lite-bundle','POS-LITE',1,'station',false), ('counter-lite-bundle','ACC-VP100',1,null,false),
    ('counter-lite-bundle','ACC-SCAN',1,null,false), ('counter-lite-bundle','ACC-PRINT',1,null,false),
    ('counter-lite-bundle','ACC-DRAWER',1,null,false), ('counter-lite-bundle','ACC-PAPER',1,null,true),
    ('online-only-bundle','KIT-ONLINE',1,null,false), ('online-only-bundle','ACC-CABLE',1,null,true)
  ) as x(slug, sku, qty, swap_group, opt)
  join public.hardware_bundles b on b.slug = x.slug
  join public.hardware_products p on p.sku = x.sku
on conflict do nothing;
