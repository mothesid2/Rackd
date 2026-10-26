do $$
begin
  if exists (select 1 from public.onboarding_applications where email like '%@demo.rackd.test') then raise exception 'CLEANUP FAIL: applications remain'; end if;
  if exists (select 1 from public.hardware_orders where email like '%@demo.rackd.test') then raise exception 'CLEANUP FAIL: orders remain'; end if;
  if exists (select 1 from public.licenses where name like 'Demo %') or exists (select 1 from public.locations where tenant_id not in (select tenant_id from public.licenses)) then
    raise exception 'CLEANUP FAIL: demo business remains'; end if;
  if exists (select 1 from public.agreement_versions where version = 'demo-seed') then raise exception 'CLEANUP FAIL: agreement versions remain'; end if;
  if exists (select 1 from public.shipping_addresses where full_name = 'Demo Shopkeeper') then raise exception 'CLEANUP FAIL: addresses remain'; end if;
  -- stock restored to the seeded catalog quantities
  if (select stock_qty from public.hardware_products where sku = 'POS-FULL') <> 25 or (select stock_qty from public.hardware_products where sku = 'ACC-SCAN') <> 50 then
    raise exception 'CLEANUP FAIL: stock not restored'; end if;
end $$;
select 'SEED CLEANUP PASSED' as result;
