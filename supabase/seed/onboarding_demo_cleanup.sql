-- Removes everything onboarding_demo.sql created (matched by the reserved domain @demo.rackd.test).
-- Audit log rows are append-only and are intentionally left in place.

do $clean$
declare t uuid;
begin
  -- put stock back for demo orders that had taken it
  update public.hardware_products p set stock_qty = p.stock_qty + s.q
    from (select i.product_id, sum(i.quantity) q from public.hardware_order_items i
            join public.hardware_orders o on o.id = i.order_id
           where o.email like '%@demo.rackd.test' and o.status in ('paid', 'fulfilled', 'shipped') and i.product_id is not null
           group by i.product_id) s
   where p.id = s.product_id;

  delete from public.hardware_orders where email like '%@demo.rackd.test';
  delete from public.shipping_addresses a where a.full_name = 'Demo Shopkeeper'
     and not exists (select 1 from public.hardware_orders o where o.shipping_address_id = a.id);
  delete from public.stripe_events where event_id like 'evt_demo%';

  -- the demo business created by approval
  for t in select provisioned_tenant_id from public.onboarding_applications where email like '%@demo.rackd.test' and provisioned_tenant_id is not null loop
    delete from public.permit_notices where permit_id in (select id from public.business_permits where tenant_id = t);
    delete from public.business_permits where tenant_id = t;
    delete from public.business_fee_settings where tenant_id = t;
    delete from public.locations where tenant_id = t;
    delete from public.licenses where tenant_id = t;
  end loop;
  delete from public.provision_runs where application_id in (select id from public.onboarding_applications where email like '%@demo.rackd.test');
  delete from public.owner_invites where application_id in (select id from public.onboarding_applications where email like '%@demo.rackd.test');

  delete from public.onboarding_applications where email like '%@demo.rackd.test';   -- cascades locations, owners, documents, events, notes, signatures, consents
  delete from public.agreement_versions where version = 'demo-seed';
  raise notice 'Demo data removed.';
end
$clean$;
