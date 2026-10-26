-- Verifies supabase/seed/onboarding_demo.sql produced the intended demo data, then (in the runner) the
-- cleanup is verified to remove all of it.
do $$
declare n bigint;
begin
  select count(*) into n from public.onboarding_applications where email like '%@demo.rackd.test';
  if n <> 6 then raise exception 'SEED FAIL: expected 6 demo applications, got %', n; end if;
  if (select array_agg(status order by status) from public.onboarding_applications where email like '%@demo.rackd.test')
      <> array['approved','draft','in_review','needs_info','rejected','submitted'] then
    raise exception 'SEED FAIL: statuses %', (select array_agg(status) from public.onboarding_applications where email like '%@demo.rackd.test');
  end if;

  -- permit flags the console should show: one expiring within 30 days, one expired
  if not exists (select 1 from public.onboarding_licenses l join public.onboarding_applications a on a.id = l.application_id
                  where a.email = 'alice@demo.rackd.test' and l.kind = 'tx_ecig' and l.expiry between current_date and current_date + 30) then
    raise exception 'SEED FAIL: expiring permit missing'; end if;
  if not exists (select 1 from public.onboarding_licenses l join public.onboarding_applications a on a.id = l.application_id
                  where a.email = 'bob@demo.rackd.test' and l.expiry < current_date) then
    raise exception 'SEED FAIL: expired permit missing'; end if;

  -- provisioning ran for real: business, key, location with storefront off, permits copied, invite recorded
  if (select count(*) from public.licenses where kind = 'business' and name = 'Demo Cloud Nine LLC' and license_key ~ '^RACKD-') <> 1 then raise exception 'SEED FAIL: demo business license'; end if;
  if (select count(*) from public.locations l join public.licenses x on x.tenant_id = l.tenant_id where x.name = 'Demo Cloud Nine LLC' and l.is_storefront_enabled = false) <> 1 then raise exception 'SEED FAIL: demo location'; end if;
  if (select count(*) from public.owner_invites where email = 'cara@demo.rackd.test' and consumed_at is null) <> 1 then raise exception 'SEED FAIL: demo invite'; end if;
  if (select status from public.onboarding_applications where email = 'cara@demo.rackd.test') <> 'approved' then raise exception 'SEED FAIL: provisioned status'; end if;

  -- every submitted-type demo application has both signatures, children, and a document per permit
  if (select count(*) from public.agreement_signatures s join public.onboarding_applications a on a.id = s.application_id where a.email like '%@demo.rackd.test') <> 10 then
    raise exception 'SEED FAIL: signatures'; end if;
  if exists (select 1 from public.onboarding_licenses l join public.onboarding_applications a on a.id = l.application_id
              where a.email like '%@demo.rackd.test' and l.document_id is null) then raise exception 'SEED FAIL: permit without document row'; end if;

  -- hardware: pending, paid (stock taken) and shipped orders, all test-mode
  if (select array_agg(status order by status) from public.hardware_orders where email like '%@demo.rackd.test') <> array['paid','pending','shipped'] then
    raise exception 'SEED FAIL: demo orders'; end if;
  if exists (select 1 from public.hardware_orders where email like '%@demo.rackd.test' and not is_test) then raise exception 'SEED FAIL: demo orders must be test mode'; end if;
  raise notice 'seed check ok';
end $$;
select 'SEED CHECK PASSED' as result;
