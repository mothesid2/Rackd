


begin;


do $$
declare
  T1 uuid := '11111111-1111-1111-1111-111111111111';  
  T2 uuid := '22222222-2222-2222-2222-222222222222';  
  L1 uuid := 'aaaaaaaa-0000-0000-0000-000000000001';  
  L2 uuid := 'aaaaaaaa-0000-0000-0000-000000000002';  
  C1 uuid := 'cccccccc-0000-0000-0000-000000000001';  
  C2 uuid := 'cccccccc-0000-0000-0000-000000000002';  
  C3 uuid := 'cccccccc-0000-0000-0000-000000000003';  
  C4 uuid := 'cccccccc-0000-0000-0000-000000000004';  
begin
  insert into public.locations (id, tenant_id, name, is_storefront_enabled, tax_rate)
    values (L1, T1, 'Test Store', true, 0),
           (L2, T1, 'Test Store 2', true, 0.0825);

  insert into public.inventory_cloud (id, tenant_id, location_id, barcode, name, category, price, quantity, updated_at)
    values (900001, T1, L1, 'BC1', 'Test Juice', 'eliquid', 10.00, 2, now()),
           (900002, T1, L2, 'BC2', 'Test Juice 2', 'eliquid', 10.00, 5, now());

  insert into public.storefront_products (tenant_id, location_id, barcode, is_visible)
    values (T1, L1, 'BC1', true),
           (T1, L2, 'BC2', true);

  insert into public.storefront_customers (id, email, age_verified, age_verified_at)
    values (C1, 'c1@test.dev', true,  now()),
           (C2, 'c2@test.dev', false, null),
           (C3, 'c3@test.dev', true,  now() - interval '400 days'),
           (C4, 'c4@test.dev', false, null);
end $$;


create or replace function pg_temp.act_as(claims jsonb) returns void language sql as $$
  select set_config('request.jwt.claims', claims::text, true);
$$;


do $$
declare blocked boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000002', 'role', 'authenticated'));
  begin
    perform public.reserve_online_order(
      '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
      '[{"barcode":"BC1","qty":1}]'::jsonb);
  exception when others then
    if sqlerrm like '%age_verification_required%' then blocked := true;
    else raise exception 'FAIL age-gate(checkout): wrong error: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'FAIL age-gate(checkout): unverified customer was allowed to reserve'; end if;
  raise notice 'PASS: unverified customer blocked at checkout (age_verification_required)';
end $$;


do $$
declare blocked boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000003', 'role', 'authenticated'));
  begin
    perform public.reserve_online_order(
      '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
      '[{"barcode":"BC1","qty":1}]'::jsonb);   
  exception when others then
    if sqlerrm like '%age_verification_required%' then blocked := true;
    else raise exception 'FAIL age-gate(expired): wrong error: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'FAIL age-gate(expired): expired verification was accepted'; end if;
  raise notice 'PASS: expired age verification blocked at checkout';
end $$;


do $$
declare v_order uuid; v_subtotal numeric; v_tax numeric; v_fee numeric; v_fee_tax numeric; v_total numeric; v_avail integer; oversold boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000001', 'role', 'authenticated'));

  
  v_order := public.reserve_online_order(
    '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
    '[{"barcode":"BC1","qty":2}]'::jsonb);
  select subtotal, tax, online_fee, fee_tax, total into v_subtotal, v_tax, v_fee, v_fee_tax, v_total from public.online_orders where id = v_order;
  
  
  if v_subtotal <> 20.00 then raise exception 'FAIL reserve: subtotal was % (expected 20.00)', v_subtotal; end if;
  if v_tax <> 0.00 then raise exception 'FAIL reserve: tax was % (expected 0.00 — tax_rate is 0 for this location)', v_tax; end if;
  if v_fee <> 1.00 then raise exception 'FAIL reserve: online_fee was % (expected 1.00 — 5%% of $20 subtotal)', v_fee; end if;
  if v_fee_tax <> 0.00 then raise exception 'FAIL reserve: fee_tax was % (expected 0.00 — tax_rate is 0 for this location)', v_fee_tax; end if;
  if v_total <> 21.00 then raise exception 'FAIL reserve: total was % (expected 21.00 = subtotal + tax + fee + fee_tax)', v_total; end if;

  v_avail := public.storefront_available(
    '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'BC1');
  if v_avail <> 0 then raise exception 'FAIL reserve: available was % after reserving all (expected 0)', v_avail; end if;
  raise notice 'PASS: reserve prices server-side (subtotal $20 + tax $0 + fee $1 = total $21) and consumes availability';

  
  begin
    perform public.reserve_online_order(
      '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
      '[{"barcode":"BC1","qty":1}]'::jsonb);
  exception when others then
    if sqlerrm like '%insufficient_stock%' then oversold := true;
    else raise exception 'FAIL oversell: wrong error: %', sqlerrm; end if;
  end;
  if not oversold then raise exception 'FAIL oversell: sold beyond available stock'; end if;
  raise notice 'PASS: oversell prevented (insufficient_stock once availability is 0)';
end $$;


do $$
declare v_order uuid; v_subtotal numeric; v_tax numeric; v_fee numeric; v_fee_tax numeric; v_total numeric;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000001', 'role', 'authenticated'));
  v_order := public.reserve_online_order(
    '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002',
    '[{"barcode":"BC2","qty":1}]'::jsonb);
  select subtotal, tax, online_fee, fee_tax, total into v_subtotal, v_tax, v_fee, v_fee_tax, v_total from public.online_orders where id = v_order;
  
  if v_tax <> 0.83 then raise exception 'FAIL: tax was % (expected 0.83 = 8.25%% of the $10 subtotal)', v_tax; end if;
  if v_fee <> 0.50 then raise exception 'FAIL: online_fee was % (expected 0.50 — 5%% of $10 subtotal)', v_fee; end if;
  
  if v_fee_tax <> 0.04 then raise exception 'FAIL: fee_tax was % (expected 0.04 = 8.25%% of the $0.50 surcharge)', v_fee_tax; end if;
  if v_total <> 11.37 then raise exception 'FAIL: total was % (expected 11.37 = 10.00 + 0.83 tax + 0.50 fee + 0.04 fee_tax)', v_total; end if;
  raise notice 'PASS: tax applies to both the subtotal ($0.83) and the surcharge ($0.04), itemized as four distinct lines';
end $$;


do $$
declare cnt int;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000002', 'role', 'authenticated'));
  set local role authenticated;
  select count(*) into cnt from public.online_orders
    where customer_id = 'cccccccc-0000-0000-0000-000000000001';
  reset role;
  if cnt <> 0 then raise exception 'FAIL RLS(orders): C2 could read % of C1''s orders', cnt; end if;
  raise notice 'PASS: RLS isolates orders — one customer cannot read another''s';
end $$;


do $$
declare cnt int;
begin
  perform pg_temp.act_as(jsonb_build_object('tenant_id', '22222222-2222-2222-2222-222222222222', 'kind', 'manager', 'role', 'authenticated'));
  set local role authenticated;
  update public.storefront_products set is_visible = false
    where location_id = 'aaaaaaaa-0000-0000-0000-000000000001';  
  get diagnostics cnt = row_count;
  reset role;
  if cnt <> 0 then raise exception 'FAIL RLS(menu): T2 manager edited % of T1''s products', cnt; end if;
  raise notice 'PASS: RLS isolates menu — a manager cannot edit another business''s products';
end $$;


do $$
declare O uuid := 'dddddddd-0000-0000-0000-000000000001';
begin
  insert into public.online_orders (id, order_number, tenant_id, location_id, customer_id, status, subtotal, tax, total)
    values (O, 'PICKUP01', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001', 'new', 10, 0, 10);
  insert into public.online_order_items (order_id, barcode, name, qty, unit_price, line_total)
    values (O, 'BC1', 'Test Juice', 1, 10, 10);
end $$;

do $$
declare blocked boolean := false;
begin
  
  perform pg_temp.act_as(jsonb_build_object(
    'tenant_id', '11111111-1111-1111-1111-111111111111',
    'location_id', 'aaaaaaaa-0000-0000-0000-000000000001',
    'register_id', 'R1', 'kind', 'register', 'role', 'authenticated'));
  begin
    perform public.complete_online_pickup('dddddddd-0000-0000-0000-000000000001', 'emp-uid-1', 'Alex', false);
  exception when others then
    if sqlerrm like '%id_check_required%' then blocked := true;
    else raise exception 'FAIL pickup-gate: wrong error: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'FAIL pickup-gate: pickup completed without the ID check'; end if;
  raise notice 'PASS: pickup blocked unless staff confirms the in-person ID check';
end $$;


do $$
declare v public.online_orders%rowtype; audit_cnt int;
begin
  perform pg_temp.act_as(jsonb_build_object(
    'tenant_id', '11111111-1111-1111-1111-111111111111',
    'location_id', 'aaaaaaaa-0000-0000-0000-000000000001',
    'register_id', 'R1', 'kind', 'register', 'role', 'authenticated'));
  v := public.complete_online_pickup('dddddddd-0000-0000-0000-000000000001', 'emp-uid-1', 'Alex', true);
  if v.status <> 'picked_up' then raise exception 'FAIL pickup: status is % (expected picked_up)', v.status; end if;
  if v.id_checked_at_pickup is not true then raise exception 'FAIL pickup: id_checked_at_pickup not set'; end if;
  if v.picked_up_by_employee_uid <> 'emp-uid-1' then raise exception 'FAIL pickup: employee not attributed'; end if;

  select count(*) into audit_cnt from public.online_order_pickups
    where order_id = 'dddddddd-0000-0000-0000-000000000001' and id_checked and employee_uid = 'emp-uid-1';
  if audit_cnt <> 1 then raise exception 'FAIL pickup: expected 1 audit row, found %', audit_cnt; end if;
  raise notice 'PASS: pickup stamps the order (employee + ID check) and writes one audit row';
end $$;


do $$
declare blocked boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object(
    'tenant_id', '11111111-1111-1111-1111-111111111111',
    'location_id', 'aaaaaaaa-0000-0000-0000-000000000001',
    'register_id', 'R1', 'kind', 'register', 'role', 'authenticated'));
  begin
    perform public.complete_online_pickup('dddddddd-0000-0000-0000-000000000001', 'emp-uid-1', 'Alex', true);
  exception when others then
    if sqlerrm like '%not_pickable%' then blocked := true;
    else raise exception 'FAIL pickup-reuse: wrong error: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'FAIL pickup-reuse: an already picked-up order was picked up twice'; end if;
  raise notice 'PASS: a picked-up order cannot be picked up again (not_pickable)';
end $$;


do $$
declare immutable boolean := false;
begin
  begin
    update public.online_order_pickups set id_checked = false
      where order_id = 'dddddddd-0000-0000-0000-000000000001';
  exception when others then
    if sqlerrm like '%append-only%' then immutable := true;
    else raise exception 'FAIL audit-immutable: wrong error: %', sqlerrm; end if;
  end;
  if not immutable then raise exception 'FAIL audit-immutable: the pickup audit row could be modified'; end if;
  raise notice 'PASS: pickup audit log is append-only (UPDATE blocked)';
end $$;


do $$
declare blocked boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000004', 'role', 'authenticated'));
  begin
    perform public.self_attest_age((current_date - interval '18 years')::date);
  exception when others then
    if sqlerrm like '%under_21%' then blocked := true;
    else raise exception 'FAIL self-attest(under21): wrong error: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'FAIL self-attest(under21): an under-21 DOB was accepted'; end if;
  raise notice 'PASS: self-attest rejects an under-21 date of birth';
end $$;


do $$
declare v public.storefront_customers%rowtype;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000004', 'role', 'authenticated'));
  v := public.self_attest_age((current_date - interval '30 years')::date);
  if v.age_verified is not true then raise exception 'FAIL self-attest(21+): account not verified'; end if;
  if v.age_verification_vendor <> 'self_attested' then raise exception 'FAIL self-attest(21+): vendor not stamped'; end if;
  raise notice 'PASS: self-attest with a 21+ DOB verifies the account';
end $$;


do $$
declare after_verified boolean;
begin
  
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000002', 'role', 'authenticated'));
  set local role authenticated;
  update public.storefront_customers set age_verified = true, age_verified_at = now()
    where id = 'cccccccc-0000-0000-0000-000000000002';
  reset role;
  select age_verified into after_verified from public.storefront_customers
    where id = 'cccccccc-0000-0000-0000-000000000002';
  if after_verified is true then raise exception 'FAIL guard: a customer self-granted age_verified via direct UPDATE'; end if;
  raise notice 'PASS: verification columns are frozen against direct client writes (guard trigger)';
end $$;

do $$ begin raise notice '── ALL STOREFRONT TESTS PASSED ──'; end $$;

rollback;
