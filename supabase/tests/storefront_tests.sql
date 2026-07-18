-- storefront_tests.sql — compliance + correctness tests for the online storefront.
--
-- Exercises the REAL Postgres logic (RPCs + RLS) that guarantees the three things
-- that must never break: no overselling, age-gating at checkout AND pickup, and
-- RLS isolation between customers and between stores. It simulates each caller by
-- setting request.jwt.claims (what current_tenant_id()/current_location_id()/
-- is_manager()/auth.uid() read) and, for direct-table RLS checks, `set role authenticated`.
--
-- HOW TO RUN: paste the whole file into the RackD SQL editor and Run. Everything
-- happens inside one transaction that ROLLS BACK at the end — no data persists.
-- Each check raises `PASS: …` as a NOTICE; the first failure raises an exception
-- (which aborts + rolls back) so a red result = a real regression.
--
-- Requires deploy-031 … 035 already applied.

begin;

-- ── fixtures (created as owner; RLS doesn't apply to us here) ─────────────────
do $$
declare
  T1 uuid := '11111111-1111-1111-1111-111111111111';  -- business A
  T2 uuid := '22222222-2222-2222-2222-222222222222';  -- business B
  L1 uuid := 'aaaaaaaa-0000-0000-0000-000000000001';  -- A's store (online)
  C1 uuid := 'cccccccc-0000-0000-0000-000000000001';  -- verified customer
  C2 uuid := 'cccccccc-0000-0000-0000-000000000002';  -- unverified customer
  C3 uuid := 'cccccccc-0000-0000-0000-000000000003';  -- verified-but-expired
  C4 uuid := 'cccccccc-0000-0000-0000-000000000004';  -- fresh, for self-attest tests
begin
  insert into public.locations (id, tenant_id, name, is_storefront_enabled, tax_rate)
    values (L1, T1, 'Test Store', true, 0);

  insert into public.inventory_cloud (id, tenant_id, location_id, barcode, name, category, price, quantity, updated_at)
    values (900001, T1, L1, 'BC1', 'Test Juice', 'eliquid', 10.00, 2, now());

  insert into public.storefront_products (tenant_id, location_id, barcode, is_visible)
    values (T1, L1, 'BC1', true);

  insert into public.storefront_customers (id, email, age_verified, age_verified_at)
    values (C1, 'c1@test.dev', true,  now()),
           (C2, 'c2@test.dev', false, null),
           (C3, 'c3@test.dev', true,  now() - interval '400 days'),
           (C4, 'c4@test.dev', false, null);
end $$;

-- claims helper: sets request.jwt.claims for the rest of THIS transaction.
create or replace function pg_temp.act_as(claims jsonb) returns void language sql as $$
  select set_config('request.jwt.claims', claims::text, true);
$$;

-- ── 1. Age-gating at checkout: unverified customer is blocked ─────────────────
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

-- ── 2. Age-gating: expired verification is treated as unverified ──────────────
do $$
declare blocked boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000003', 'role', 'authenticated'));
  begin
    perform public.reserve_online_order(
      '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
      '[{"barcode":"BC1","qty":1}]'::jsonb);   -- default 365-day window; verified 400d ago
  exception when others then
    if sqlerrm like '%age_verification_required%' then blocked := true;
    else raise exception 'FAIL age-gate(expired): wrong error: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'FAIL age-gate(expired): expired verification was accepted'; end if;
  raise notice 'PASS: expired age verification blocked at checkout';
end $$;

-- ── 3. Happy path + oversell: reserve all stock, then one more must fail ──────
do $$
declare v_order uuid; v_total numeric; v_avail integer; oversold boolean := false;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000001', 'role', 'authenticated'));

  -- Reserve all 2 units — should succeed, price sourced server-side (10 each).
  v_order := public.reserve_online_order(
    '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
    '[{"barcode":"BC1","qty":2}]'::jsonb);
  select total into v_total from public.online_orders where id = v_order;
  if v_total <> 20.00 then raise exception 'FAIL reserve: total was % (expected 20.00)', v_total; end if;

  v_avail := public.storefront_available(
    '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'BC1');
  if v_avail <> 0 then raise exception 'FAIL reserve: available was % after reserving all (expected 0)', v_avail; end if;
  raise notice 'PASS: reserve prices server-side (total $20.00) and consumes availability';

  -- One more unit must be refused — this is the oversell guard.
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

-- ── 4. RLS isolation: a customer cannot read another customer's orders ───────
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

-- ── 5. RLS isolation: a manager cannot edit another business's menu ──────────
do $$
declare cnt int;
begin
  perform pg_temp.act_as(jsonb_build_object('tenant_id', '22222222-2222-2222-2222-222222222222', 'kind', 'manager', 'role', 'authenticated'));
  set local role authenticated;
  update public.storefront_products set is_visible = false
    where location_id = 'aaaaaaaa-0000-0000-0000-000000000001';  -- belongs to T1
  get diagnostics cnt = row_count;
  reset role;
  if cnt <> 0 then raise exception 'FAIL RLS(menu): T2 manager edited % of T1''s products', cnt; end if;
  raise notice 'PASS: RLS isolates menu — a manager cannot edit another business''s products';
end $$;

-- ── 6. Age-gating at PICKUP: staff must confirm the in-person ID check ────────
-- Seed a paid order (status 'new') to hand off.
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
  -- Act as a register at this store (tenant + location claims, kind=register).
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

-- ── 7. Pickup happy path: stamps the order + writes the append-only audit ─────
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

-- ── 8. Pickup is single-use: a picked-up order cannot be picked up again ──────
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

-- ── 9. The pickup audit log is append-only (no UPDATE/DELETE, even as owner) ──
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

-- ── 10. Self-attest age gate: under-21 DOB is rejected ───────────────────────
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

-- ── 11. Self-attest age gate: a 21+ DOB verifies the account ──────────────────
do $$
declare v public.storefront_customers%rowtype;
begin
  perform pg_temp.act_as(jsonb_build_object('sub', 'cccccccc-0000-0000-0000-000000000004', 'role', 'authenticated'));
  v := public.self_attest_age((current_date - interval '30 years')::date);
  if v.age_verified is not true then raise exception 'FAIL self-attest(21+): account not verified'; end if;
  if v.age_verification_vendor <> 'self_attested' then raise exception 'FAIL self-attest(21+): vendor not stamped'; end if;
  raise notice 'PASS: self-attest with a 21+ DOB verifies the account';
end $$;

-- ── 12. The verification columns cannot be self-granted by a direct write ─────
do $$
declare after_verified boolean;
begin
  -- C2 is unverified; try to flip age_verified directly as the customer.
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
