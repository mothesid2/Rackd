-- Removes the backfilled POS-sync items and settings rows. Anything a manager created afterwards is removed too
-- (items cannot be distinguished once edited), so only run this immediately after deploying 094.
delete from public.storefront_items where source = 'pos';
delete from public.storefront_settings where inventory_mode = 'pos_sync' and not enabled;
