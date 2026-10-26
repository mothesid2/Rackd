-- Storefront Manager: RLS, permissions, reservations, fee math, stock races, hold expiry, statements.
-- Runs after migrations 081-094 in one transaction and rolls back. Any failure raises an exception.
-- NOTE: the "last unit" test proves serialization by sequential calls plus a check that the item rows are
-- locked FOR UPDATE; true parallel sessions need a real Postgres (not available in the embedded test database).

begin;

create or replace function pg_temp.become(p_role text, p_claims jsonb) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  if p_role <> 'postgres' then execute format('set local role %I', p_role); end if;
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_code text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlstate = p_code then return; end if;
    raise exception 'FAIL %: expected SQLSTATE % but got % (%)', p_label, p_code, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL %: expected SQLSTATE % but statement succeeded', p_label, p_code;
end $$;
-- like expect_error but matches the exception message (for the raise exception 'slug' style used by the RPCs)
create or replace function pg_temp.expect_msg(p_sql text, p_msg text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm like p_msg || '%' then return; end if;
    raise exception 'FAIL %: expected message "%" but got "%" (%)', p_label, p_msg, sqlerrm, sqlstate;
  end;
  raise exception 'FAIL %: expected error "%" but statement succeeded', p_label, p_msg;
end $$;
create or replace function pg_temp.expect_count(p_sql text, p_expected bigint, p_label text) returns void language plpgsql as $$
declare n bigint;
begin execute p_sql into n;
  if n is distinct from p_expected then raise exception 'FAIL %: expected % but got %', p_label, p_expected, n; end if;
end $$;
-- reservations are never deleted in production (the audit trail is append-only); tests wipe them with the guard lifted
create or replace function pg_temp.wipe(p_id uuid default null) returns void language plpgsql as $$
begin
  alter table public.reservation_events disable trigger trg_res_events_immutable;
  if p_id is null then delete from public.fee_ledger; perform pg_temp.wipe(); else delete from public.fee_ledger where reservation_id = p_id; delete from public.reservations where id = p_id; end if;
  alter table public.reservation_events enable trigger trg_res_events_immutable;
end $$;
create or replace function pg_temp.ck(p_kind text, p_tenant uuid, p_emp uuid default null, p_loc uuid default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('role', 'authenticated', 'kind', p_kind, 'tenant_id', p_tenant, 'employee_uid', p_emp, 'location_id', p_loc));
$$;
create or replace function pg_temp.cust(p_id uuid) returns jsonb language sql as $$ select jsonb_build_object('role', 'authenticated', 'sub', p_id); $$;

-- ================================================================ fixtures
do $$
begin
  insert into public.locations (id, tenant_id, name) values
    ('aaaaaaaa-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'T1 POS store'),
    ('aaaaaaaa-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', 'T1 curated store'),
    ('aaaaaaaa-0000-0000-0000-0000000000c1', '22222222-2222-2222-2222-222222222222', 'T2 store');
  insert into public.storefront_settings (location_id, tenant_id, enabled, inventory_mode) values
    ('aaaaaaaa-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', true, 'pos_sync'),
    ('aaaaaaaa-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', true, 'curated'),
    ('aaaaaaaa-0000-0000-0000-0000000000c1', '22222222-2222-2222-2222-222222222222', true, 'curated');
  insert into public.employees_cloud (uid, tenant_id, username, name, role) values
    ('e0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'adm', 'Ada Admin', 'admin'),
    ('e0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'mgr', 'Mo Manager', 'manager'),
    ('e0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'deny', 'Dee Restricted', 'manager'),
    ('e0000000-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222', 'mgr2', 'Other Tenant Mgr', 'manager'),
    ('e0000000-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', 'cash', 'Cass Cashier', 'cashier');
  -- DENY loses items.edit (default on) and gains settings.edit + fees.view (default off)
  insert into public.employee_permissions_cloud (uid, tenant_id, employee_uid, permission_key, is_granted) values
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'e0000000-0000-0000-0000-00000000000c', 'storefront.items.edit', false),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'e0000000-0000-0000-0000-00000000000c', 'storefront.settings.edit', true),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'e0000000-0000-0000-0000-00000000000c', 'storefront.fees.view', true);
  insert into public.inventory_cloud (tenant_id, location_id, barcode, name, category, price, quantity) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'BC1', 'POS Juice', 'eliquid', 10.00, 5),
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'BC2', 'POS Glass Pipe', 'glass', 20.00, 0);
  insert into public.storefront_customers (id, first_name, last_name, age_verified, age_verified_at) values
    ('c1000000-0000-0000-0000-000000000001', 'Cora', 'Customer', true, now()),
    ('c1000000-0000-0000-0000-000000000002', 'Dan', 'Buyer', true, now()),
    ('c1000000-0000-0000-0000-000000000003', 'Eve', 'Third', true, now()),
    ('c1000000-0000-0000-0000-000000000004', 'Unv', 'Erified', false, null),
    ('c1000000-0000-0000-0000-000000000005', 'Old', 'Check', true, now() - interval '400 days');
end $$;

-- ================================================================ 1. permission helper matrix
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111';
begin
  perform pg_temp.become('authenticated', pg_temp.ck('owner', t1));
  if not (public.sf_can('storefront.settings.edit') and public.sf_can('storefront.fees.view')) then raise exception 'FAIL: owner token has every key'; end if;
  perform pg_temp.become('authenticated', pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000a'));
  if not (public.sf_can('storefront.settings.edit') and public.sf_can('storefront.fees.view')) then raise exception 'FAIL: admin role has every key'; end if;
  perform pg_temp.become('authenticated', pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'));
  if not (public.sf_can('storefront.view') and public.sf_can('storefront.items.edit') and public.sf_can('storefront.orders.manage') and public.sf_can('storefront.reports.view')) then
    raise exception 'FAIL: manager defaults on'; end if;
  if public.sf_can('storefront.settings.edit') or public.sf_can('storefront.fees.view') then raise exception 'FAIL: manager defaults off'; end if;
  perform pg_temp.become('authenticated', pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000c'));
  if public.sf_can('storefront.items.edit') then raise exception 'FAIL: explicit revoke beats the default'; end if;
  if not (public.sf_can('storefront.settings.edit') and public.sf_can('storefront.fees.view')) then raise exception 'FAIL: explicit grant beats the default'; end if;
  perform pg_temp.become('authenticated', pg_temp.ck('register', t1, null, 'aaaaaaaa-0000-0000-0000-0000000000a1'));
  if public.sf_can('storefront.view') then raise exception 'FAIL: register token is not a manager'; end if;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  if public.sf_can('storefront.view') then raise exception 'FAIL: customer has no storefront permissions'; end if;
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error('select public.sf_can(''storefront.view'')', '42501', 'anon cannot probe permissions');
  raise notice 'PASS 1: permission matrix';
end $$;

-- ================================================================ 2. items: RLS, modes, POS read-only
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; t2 uuid := '22222222-2222-2222-2222-222222222222';
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b');
  deny jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000c');
  mgr2 jsonb := pg_temp.ck('manager', t2, 'e0000000-0000-0000-0000-00000000000d');
  lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; la uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1';
  item uuid;
begin
  perform pg_temp.become('authenticated', mgr);
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty, category) values (t1, lb, 'curated', 'Curated Mango', 12.50, 3, 'eliquid') returning id into item;
  update public.storefront_items set status = 'sold_out' where id = item;
  perform pg_temp.expect_count('select count(*) from public.storefront_items where status = ''sold_out''', 1, 'manager sees and edits their items');
  perform pg_temp.expect_msg(format('insert into public.storefront_items (tenant_id, location_id, source, pos_product_id) values (%L, %L, ''pos'', ''BC1'')', t1, lb), 'pos_items_not_allowed_in_curated_mode', 'POS items need pos_sync mode');
  perform pg_temp.expect_msg(format('insert into public.storefront_items (tenant_id, location_id, source, name, price) values (%L, %L, ''curated'', ''x'', 1)', t1, la), 'curated_items_not_allowed_in_pos_mode', 'curated items need curated mode');
  perform pg_temp.expect_error(format('insert into public.storefront_items (tenant_id, location_id, source, name, price) values (%L, %L, ''curated'', '' '', 1)', t1, lb), '23514', 'curated item needs a name');
  perform pg_temp.expect_error(format('insert into public.storefront_items (tenant_id, location_id, source, name, price) values (%L, %L, ''curated'', ''Neg'', -1)', t1, lb), '23514', 'no negative price');

  -- POS-sync item: read from inventory, only visibility/order editable
  insert into public.storefront_items (tenant_id, location_id, source, pos_product_id, status) values (t1, la, 'pos', 'BC1', 'available');
  perform pg_temp.expect_msg(format('insert into public.storefront_items (tenant_id, location_id, source, pos_product_id) values (%L, %L, ''pos'', ''NOPE'')', t1, la), 'pos_product_not_found', 'POS item must exist in inventory');
  perform pg_temp.expect_msg(format('update public.storefront_items set price = 1 where location_id = %L', la), 'pos_item_read_only', 'POS price is read-only');
  perform pg_temp.expect_msg(format('update public.storefront_items set qty = 99 where location_id = %L', la), 'pos_item_read_only', 'POS quantity is read-only');
  perform pg_temp.expect_msg(format('update public.storefront_items set name = ''x'' where location_id = %L', la), 'pos_item_read_only', 'POS name is read-only');
  update public.storefront_items set status = 'hidden', sort_order = 7 where location_id = la;
  perform pg_temp.expect_msg(format('update public.storefront_items set location_id = %L where id = %L', la, item), 'item_identity_is_immutable', 'items cannot move between locations');

  raise notice 'PASS 2a: items modes and POS read-only fields';
end $$;

do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; t2 uuid := '22222222-2222-2222-2222-222222222222';
  deny jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000c');
  mgr2 jsonb := pg_temp.ck('manager', t2, 'e0000000-0000-0000-0000-00000000000d');
  lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; item uuid; n bigint;
begin
  select id into item from public.storefront_items where name = 'Curated Mango';
  perform pg_temp.become('authenticated', deny);
  update public.storefront_items set status = 'hidden' where id = item;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a manager without items.edit changed an item'; end if;
  perform pg_temp.expect_error(format('insert into public.storefront_items (tenant_id, location_id, source, name, price) values (%L, %L, ''curated'', ''Nope'', 1)', t1, lb), '42501', 'no items.edit, no insert');
  delete from public.storefront_items where id = item;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: delete without items.edit'; end if;

  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_count('select count(*) from public.storefront_items', 0, 'other tenant sees no items');
  perform pg_temp.expect_error(format('insert into public.storefront_items (tenant_id, location_id, source, name, price) values (%L, %L, ''curated'', ''Hijack'', 1)', t2, lb), '42501', 'cannot write into another tenant location (even labelling it as own tenant)');
  perform pg_temp.expect_error(format('insert into public.storefront_items (tenant_id, location_id, source, name, price) values (%L, %L, ''curated'', ''Hijack'', 1)', t1, lb), '42501', 'cannot write with a foreign tenant id');

  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error('select count(*) from public.storefront_items', '42501', 'anon cannot read the items table');
  perform pg_temp.expect_error('select count(*) from public.storefront_settings', '42501', 'anon cannot read settings');
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  perform pg_temp.expect_count('select count(*) from public.storefront_items', 0, 'customers cannot read the manager view');
  raise notice 'PASS 2: items RLS, modes and POS read-only fields';
end $$;

-- ================================================================ 3. settings, defaults, owner-only controls
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111';
  owner jsonb := pg_temp.ck('owner', t1);
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b');
  deny jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000c');
  lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; lc uuid := 'aaaaaaaa-0000-0000-0000-0000000000c1'; r public.storefront_settings;
begin
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_error(format('update public.storefront_settings set paused = true where location_id = %L', lb), '42501', 'no direct settings writes');
  perform pg_temp.expect_error(format('select public.sf_save_settings(%L, ''{"hold_minutes": 30}'')', lb), '42501', 'settings.edit required');
  perform public.sf_set_paused(lb, true, 'Out for lunch');                         -- orders.manage is enough for the pause switch
  perform pg_temp.expect_count(format('select count(*) from public.storefront_settings where location_id = %L and paused and pause_reason = ''Out for lunch''', lb), 1, 'pause works');
  perform public.sf_set_paused(lb, false);

  perform pg_temp.become('authenticated', deny);
  r := public.sf_save_settings(lb, '{"hold_minutes": 45, "pickup_instructions": "Ring the bell", "max_qty_per_item": 2}');
  if r.hold_minutes <> 45 or r.max_qty_per_item <> 2 then raise exception 'FAIL: settings saved'; end if;
  perform pg_temp.expect_msg(format('select public.sf_save_settings(%L, ''{"payment_mode": "prepay_card"}'')', lb), 'prepay_not_available', 'prepay stays off until a gateway is connected');
  perform pg_temp.expect_error(format('select public.sf_save_settings(%L, ''{"hold_minutes": 2}'')', lb), '23514', 'hold below the minimum');
  perform pg_temp.expect_error(format('select public.sf_save_settings(%L, ''{"hold_minutes": 99999}'')', lb), '23514', 'hold above the maximum');
  perform pg_temp.expect_error(format('select public.sf_save_settings(%L, ''{"payment_mode": "bitcoin"}'')', lb), '23514', 'unknown payment mode');
  perform pg_temp.expect_msg(format('select public.sf_save_settings(%L, ''{}'')', lc), 'forbidden', 'another tenant location is refused');

  -- business defaults and the inheritance
  perform pg_temp.expect_error('select public.sf_owner_save_defaults(''{"hold_minutes": 90}'')', '42501', 'business defaults are owner-only');
  perform pg_temp.expect_error(format('select public.sf_owner_set_inventory_mode(%L, ''pos_sync'')', lb), '42501', 'inventory mode is owner-only');
  perform pg_temp.become('authenticated', owner);
  perform public.sf_owner_save_defaults('{"hold_minutes": 90, "max_items_per_order": 12}');
  perform pg_temp.expect_msg('select public.sf_owner_save_defaults(''{"allowed_payment_modes": ["pay_at_pickup", "prepay_card"]}'')', 'prepay_not_available', 'owner cannot enable prepay either');
  perform pg_temp.expect_error('select public.sf_owner_save_defaults(''{"fee_type": "percent", "fee_value": 150}'')', '23514', 'percent fee over 100');
  perform pg_temp.expect_error('select public.sf_owner_save_defaults(''{"fee_type": "flat"}'')', '23514', 'fee type needs a value');
  perform pg_temp.expect_error('select public.sf_owner_save_defaults(''{"fee_type": "flat", "fee_value": -2}'')', '23514', 'negative fee');
  perform pg_temp.become('postgres', null);
  if (select hold_minutes from public.sf_effective_settings(lb)) <> 45 then raise exception 'FAIL: location override wins'; end if;
  if (select max_items_per_order from public.sf_effective_settings(lb)) <> 12 then raise exception 'FAIL: business default inherited'; end if;
  update public.storefront_settings set hold_minutes = null where location_id = lb;
  if (select hold_minutes from public.sf_effective_settings(lb)) <> 90 then raise exception 'FAIL: cleared override inherits the default'; end if;
  update public.storefront_settings set hold_minutes = 45, max_qty_per_item = 5 where location_id = lb;
  update public.business_storefront_defaults set max_items_per_order = 20 where tenant_id = t1;

  -- the public location gate follows the manager's switch, and the business switch turns everything off
  perform pg_temp.become('authenticated', owner);
  perform pg_temp.expect_count(format('select count(*) from public.locations where id = %L and is_storefront_enabled', lb), 1, 'gate on');
  perform public.sf_owner_save_defaults('{"storefront_enabled": false}');
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count('select count(*) from public.locations where tenant_id = ''11111111-1111-1111-1111-111111111111'' and is_storefront_enabled', 0, 'business off: every location off');
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.become('authenticated', deny);
  perform pg_temp.expect_msg(format('select public.sf_save_settings(%L, ''{"enabled": true}'')', lb), 'storefront_disabled_by_owner', 'a manager cannot re-enable what the owner disabled');
  perform pg_temp.become('authenticated', owner);
  perform public.sf_owner_save_defaults('{"storefront_enabled": true}');
  perform pg_temp.become('authenticated', deny);
  perform public.sf_save_settings(lb, '{"enabled": true}');
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.locations where id = %L and is_storefront_enabled', lb), 1, 'gate back on');
  raise notice 'PASS 3: settings, defaults and owner-only controls';
end $$;

-- ================================================================ 4. customer menu contract
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; la uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'); m jsonb;
begin
  perform pg_temp.become('postgres', null);
  update public.storefront_settings set enabled = true where location_id = la;      -- group 3 switched the whole business off, then only lb back on
  perform pg_temp.become('authenticated', mgr);
  update public.storefront_items set status = 'available' where location_id = la;           -- BC1 back on the menu
  insert into public.storefront_items (tenant_id, location_id, source, pos_product_id, status) values (t1, la, 'pos', 'BC2', 'available');   -- out of stock in the POS
  update public.storefront_items set status = 'available' where name = 'Curated Mango';
  insert into public.storefront_items (tenant_id, location_id, source, name, price, status, category) values (t1, lb, 'curated', 'Hidden Item', 5, 'hidden', 'eliquid');
  insert into public.storefront_items (tenant_id, location_id, source, name, price, status, qty) values (t1, lb, 'curated', 'Sold Item', 6, 'sold_out', 4);

  perform pg_temp.become('anon', null);
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_v2(%L)', lb), 2, 'curated menu: available + sold out, never hidden');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_v2(%L) where name = ''Hidden Item''', lb), 0, 'hidden items never reach customers');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_v2(%L) where name = ''Sold Item'' and status = ''sold_out''', lb), 1, 'sold out is labelled, not hidden');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_v2(%L) where name = ''POS Juice'' and price = 10.00 and available = 5', la), 1, 'POS item name, price and quantity come from the POS');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_v2(%L) where name = ''POS Glass Pipe'' and status = ''sold_out''', la), 1, 'zero stock in the POS reads as sold out');
  m := public.storefront_public_info(lb);
  if not (m ->> 'enabled')::boolean or (m ->> 'accepting')::boolean is not true or m -> 'fee' ->> 'label' <> 'Reservation fee' or m ->> 'payment_mode' <> 'pay_at_pickup' or (m ->> 'prepay_available')::boolean then
    raise exception 'FAIL: public info %', m; end if;
  if (public.storefront_public_info('aaaaaaaa-0000-0000-0000-0000000000c1') ->> 'enabled')::boolean is not true then raise exception 'FAIL: T2 enabled'; end if;
  if public.storefront_public_info(gen_random_uuid()) ->> 'enabled' <> 'false' then raise exception 'FAIL: unknown location'; end if;

  -- the change signal customers subscribe to is readable, and nothing sensitive is
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_version where location_id = %L and version > 0', lb), 1, 'menu version bumps on item changes');
  perform pg_temp.become('postgres', null);
  update public.storefront_settings set enabled = false where location_id = lb;
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_count(format('select count(*) from public.storefront_menu_v2(%L)', lb), 0, 'disabled location has no public menu');
  perform pg_temp.become('postgres', null);
  update public.storefront_settings set enabled = true where location_id = lb;
  raise notice 'PASS 4: customer menu contract';
end $$;

-- ================================================================ 5. create_reservation: validation, fee snapshot math
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; la uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1';
  c1 jsonb := pg_temp.cust('c1000000-0000-0000-0000-000000000001'); c2 jsonb := pg_temp.cust('c1000000-0000-0000-0000-000000000002');
  mango uuid; hidden uuid; sold uuid; juice uuid; r jsonb; owner jsonb := pg_temp.ck('owner', t1);
begin
  perform pg_temp.become('postgres', null);
  update public.storefront_items set qty = null where name = 'Curated Mango';          -- unlimited: these tests are about fees and validation
  select id into mango from public.storefront_items where name = 'Curated Mango';
  select id into hidden from public.storefront_items where name = 'Hidden Item';
  select id into sold from public.storefront_items where name = 'Sold Item';
  select id into juice from public.storefront_items where pos_product_id = 'BC1';

  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error(format('select public.create_reservation(%L, ''[]'')', lb), '42501', 'anon cannot reserve');
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000004'));
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))), 'age_verification_required', 'unverified customer');
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000005'));
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))), 'age_verification_required', 'stale age verification');

  perform pg_temp.become('authenticated', c1);
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, ''[]'')', lb), 'cart_empty', 'empty cart');
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', hidden, 'qty', 1))), 'item_unavailable', 'hidden item');
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', sold, 'qty', 1))), 'item_unavailable', 'sold-out item');
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 0))), 'qty_invalid', 'zero quantity');
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 6))), 'qty_over_limit', 'above max_qty_per_item (5)');
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', la, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))), 'item_unavailable', 'item from another location');

  -- default placeholder fee: 5% (platform config) -> 2 x 12.50 = 25.00 -> 1.25
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 2)), 'extra bag');
  if (r ->> 'subtotal')::numeric <> 25.00 or (r ->> 'fee_amount')::numeric <> 1.25 or (r ->> 'total')::numeric <> 26.25 then raise exception 'FAIL: percent fee math %', r; end if;
  if r ->> 'fee_type' <> 'percent' or (r ->> 'fee_value')::numeric <> 5 or r ->> 'payment_mode' <> 'pay_at_pickup' or r ->> 'payment_status' <> 'unpaid' or r ->> 'status' <> 'new' then raise exception 'FAIL: snapshot %', r; end if;
  if r ->> 'customer_name' <> 'Cora C.' then raise exception 'FAIL: first name and last initial, got %', r ->> 'customer_name'; end if;
  perform set_config('t.res1', r ->> 'id', true);

  -- the snapshot never changes when the shop's fee changes afterwards
  perform pg_temp.become('authenticated', owner);
  perform public.sf_owner_save_defaults('{"fee_type": "flat", "fee_value": 2.50}');
  perform pg_temp.become('authenticated', c1);
  if (select fee_amount from public.reservations where id = current_setting('t.res1')::uuid) <> 1.25 then raise exception 'FAIL: fee snapshot must not move'; end if;

  -- flat business override, in dollars
  perform pg_temp.become('authenticated', c2);
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1)));
  if (r ->> 'fee_amount')::numeric <> 2.50 or r ->> 'fee_type' <> 'flat' or (r ->> 'total')::numeric <> 15.00 then raise exception 'FAIL: flat fee %', r; end if;
  perform set_config('t.res2', r ->> 'id', true);

  -- half-cent rounding: 10.10 x 5% = 0.505 -> 0.51 (half up)
  perform pg_temp.become('authenticated', owner);
  perform public.sf_owner_save_defaults('{"fee_type": "percent", "fee_value": 5}');
  perform pg_temp.become('postgres', null);
  update public.inventory_cloud set price = 10.10 where barcode = 'BC1';
  perform pg_temp.expect_count('select count(*) from (select public.sf_compute_fee(''percent'', 5, 10.10) f) x where f = 0.51', 1, 'half-cent rounds up');
  perform pg_temp.expect_count('select count(*) from (select public.sf_compute_fee(''percent'', 5, 12.35) f) x where f = 0.62', 1, '12.35 x 5% = 0.6175 -> 0.62');
  perform pg_temp.expect_count('select count(*) from (select public.sf_compute_fee(''percent'', 8.25, 100) f) x where f = 8.25', 1, 'fractional percent');
  perform pg_temp.expect_count('select count(*) from (select public.sf_compute_fee(''flat'', 1.499, 100) f) x where f = 1.50', 1, 'flat rounds to the cent');
  perform pg_temp.expect_count('select count(*) from (select public.sf_compute_fee(''percent'', 5, 0) f) x where f = 0', 1, 'zero subtotal');

  -- plan fee (business_fee_settings, flat stored in CENTS) is used when there is no business override
  perform pg_temp.become('postgres', null);
  update public.business_storefront_defaults set fee_type = null, fee_value = null where tenant_id = t1;
  insert into public.business_fee_settings (tenant_id, online_fee_type, online_fee_value) values (t1, 'flat', 150);
  if (select fee_value from public.sf_fee_config(t1)) <> 1.50 then raise exception 'FAIL: plan flat fee converts cents to dollars'; end if;
  update public.business_fee_settings set online_fee_type = 'percent', online_fee_value = 7.5 where tenant_id = t1;
  if (select fee_value from public.sf_fee_config(t1)) <> 7.5 then raise exception 'FAIL: plan percent fee'; end if;
  delete from public.business_fee_settings where tenant_id = t1;
  update public.business_storefront_defaults set fee_type = 'percent', fee_value = 5 where tenant_id = t1;

  -- waivers
  update public.business_storefront_defaults set fee_waived = true where tenant_id = t1;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000003'));
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1)));
  if (r ->> 'fee_amount')::numeric <> 0 or r ->> 'fee_waived' <> 'true' or r ->> 'fee_waiver_reason' <> 'business waiver' or (r ->> 'total')::numeric <> 12.50 then raise exception 'FAIL: business waiver %', r; end if;
  perform set_config('t.res3', r ->> 'id', true);
  perform pg_temp.become('postgres', null);
  update public.business_storefront_defaults set fee_waived = false, first_order_fee_waiver = true where tenant_id = t1;
  perform pg_temp.wipe(current_setting('t.res3')::uuid);
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000003'));
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1)));
  if r ->> 'fee_waiver_reason' <> 'first order' or (r ->> 'fee_amount')::numeric <> 0 then raise exception 'FAIL: first-order waiver %', r; end if;
  perform set_config('t.res3', r ->> 'id', true);
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1)));
  if (r ->> 'fee_amount')::numeric <> 0.63 or r ->> 'fee_waived' <> 'false' then raise exception 'FAIL: second order pays the fee (12.50 x 5%% = 0.625 -> 0.63): %', r; end if;
  perform set_config('t.res4', r ->> 'id', true);
  perform pg_temp.become('postgres', null);
  update public.business_storefront_defaults set first_order_fee_waiver = false where tenant_id = t1;
  raise notice 'PASS 5: reservation validation and fee snapshots';
end $$;

-- ================================================================ 6. the last unit, rate limits, hours, open limits
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  ca uuid := 'c1000000-0000-0000-0000-000000000001'; cb uuid := 'c1000000-0000-0000-0000-000000000002'; last_one uuid; r jsonb; n integer;
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b');
begin
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();                         -- clean slate for the race
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty, status) values (t1, lb, 'curated', 'Last Unit', 9.99, 1, 'available') returning id into last_one;
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', last_one, 'qty', 1)));
  perform set_config('t.last1', r ->> 'id', true);
  perform pg_temp.become('authenticated', pg_temp.cust(cb));
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', last_one, 'qty', 1))), 'insufficient_stock', 'the last unit goes to exactly one customer');
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id in (select reservation_id from public.reservation_items where item_id = %L)', last_one), 1, 'the losing attempt left nothing behind');
  if public.sf_item_available(last_one) <> 0 then raise exception 'FAIL: availability counts open reservations'; end if;
  -- releasing the unit (customer cancels) makes it available to the next customer
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  perform public.cancel_my_reservation(current_setting('t.last1')::uuid);
  perform pg_temp.become('authenticated', pg_temp.cust(cb));
  r := public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', last_one, 'qty', 1)));
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.reservation_items ri join public.reservations r on r.id = ri.reservation_id where ri.item_id = %L and r.status in (''new'',''confirmed'',''ready'')', last_one), 1, 'never more reservations than units');
  -- serialization relies on locking every requested item row FOR UPDATE, in a fixed order
  if position('for update' in lower(pg_get_functiondef('public.create_reservation(uuid, jsonb, text)'::regprocedure))) = 0 then raise exception 'FAIL: create_reservation must lock the item rows'; end if;
  if position('order by id for update' in lower(pg_get_functiondef('public.create_reservation(uuid, jsonb, text)'::regprocedure))) = 0 then raise exception 'FAIL: item locks must be taken in a fixed order'; end if;

  -- unlimited curated items (qty null) are never "insufficient"
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty) values (t1, lb, 'curated', 'Unlimited', 3, null);
  if public.sf_item_available((select id from public.storefront_items where name = 'Unlimited')) is not null then raise exception 'FAIL: null qty is unlimited'; end if;

  -- per-customer limits: 3 open at a location
  perform pg_temp.wipe();
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  for n in 1..3 loop
    perform public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', (select id from public.storefront_items where name = 'Unlimited'), 'qty', 1)));
  end loop;
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', (select id from public.storefront_items where name = 'Unlimited'), 'qty', 1))), 'too_many_open_reservations', '4th open reservation');
  -- hourly rate limit: 5 per hour across all locations
  perform pg_temp.become('postgres', null);
  update public.reservations set status = 'cancelled' where customer_id = ca;
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  perform public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', (select id from public.storefront_items where name = 'Unlimited'), 'qty', 1)));
  perform public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', (select id from public.storefront_items where name = 'Unlimited'), 'qty', 1)));
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', (select id from public.storefront_items where name = 'Unlimited'), 'qty', 1))), 'rate_limited', '6th reservation in an hour');

  -- paused, closed hours and cutoff
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();
  update public.storefront_settings set paused = true where location_id = lb;
  perform pg_temp.become('authenticated', pg_temp.cust(cb));
  perform pg_temp.expect_msg(format('select public.create_reservation(%L, %L::jsonb)', lb, jsonb_build_array(jsonb_build_object('item_id', (select id from public.storefront_items where name = 'Unlimited'), 'qty', 1))), 'not_accepting_orders', 'paused');
  perform pg_temp.become('postgres', null);
  update public.storefront_settings set paused = false, pickup_hours = '{"mon":{"open":"00:00","close":"00:00","closed":true},"tue":{"closed":true},"wed":{"closed":true},"thu":{"closed":true},"fri":{"closed":true},"sat":{"closed":true},"sun":{"closed":true}}' where location_id = lb;
  if public.sf_accepting(lb) then raise exception 'FAIL: closed every day'; end if;
  update public.storefront_settings set pickup_hours = '{"mon":{"open":"00:00","close":"23:59"},"tue":{"open":"00:00","close":"23:59"},"wed":{"open":"00:00","close":"23:59"},"thu":{"open":"00:00","close":"23:59"},"fri":{"open":"00:00","close":"23:59"},"sat":{"open":"00:00","close":"23:59"},"sun":{"open":"00:00","close":"23:59"}}' where location_id = lb;
  if not public.sf_accepting(lb) then raise exception 'FAIL: open all day'; end if;
  update public.storefront_settings set pickup_hours = null where location_id = lb;
  raise notice 'PASS 6: last unit, per-customer limits, pause and hours';
end $$;

-- ================================================================ 7. staff workflow, ID rule, fee ledger, visibility
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; t2 uuid := '22222222-2222-2222-2222-222222222222';
  lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; la uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1';
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'); deny jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000c');
  mgr2 jsonb := pg_temp.ck('manager', t2, 'e0000000-0000-0000-0000-00000000000d'); fees jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000a');
  ca uuid := 'c1000000-0000-0000-0000-000000000001'; cb uuid := 'c1000000-0000-0000-0000-000000000002';
  mango uuid; vape uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid;
begin
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();
  update public.storefront_settings set require_id_at_pickup = false where location_id = lb;      -- the shop turned the toggle OFF
  select id into mango from public.storefront_items where name = 'Curated Mango';
  insert into public.storefront_items (tenant_id, location_id, source, name, price, category, qty) values (t1, lb, 'curated', 'Disposable Vape', 20, 'vape', null) returning id into vape;
  update public.storefront_items set category = 'accessories' where id = mango;
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  r1 := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))) ->> 'id')::uuid;       -- non-restricted
  r2 := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', vape, 'qty', 1))) ->> 'id')::uuid;        -- restricted category
  perform pg_temp.become('authenticated', pg_temp.cust(cb));
  r3 := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))) ->> 'id')::uuid;
  r4 := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))) ->> 'id')::uuid;
  r5 := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', mango, 'qty', 1))) ->> 'id')::uuid;

  -- who may act
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_error(format('select public.sf_reservation_confirm(%L)', r1), '42501', 'other tenant cannot act');
  perform pg_temp.expect_count('select count(*) from public.reservations', 0, 'other tenant cannot see reservations');
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  perform pg_temp.expect_error(format('select public.sf_reservation_confirm(%L)', r1), '42501', 'customers cannot act as staff');
  perform pg_temp.expect_count('select count(*) from public.reservations', 2, 'customer sees only their own reservations');
  perform pg_temp.expect_count('select count(*) from public.reservation_items', 2, 'customer sees only their own lines');
  perform pg_temp.expect_count('select count(*) from public.reservation_events', 0, 'customers do not see the staff audit trail');
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error('select count(*) from public.reservations', '42501', 'anon cannot read reservations');
  perform pg_temp.become('authenticated', pg_temp.ck('register', t1, null, la));
  perform pg_temp.expect_count('select count(*) from public.reservations', 0, 'a POS at another location sees none');
  perform pg_temp.become('authenticated', pg_temp.ck('register', t1, null, lb));
  perform pg_temp.expect_count('select count(*) from public.reservations', 5, 'the POS at this location sees its reservations');
  perform pg_temp.expect_error(format('select public.sf_reservation_confirm(%L)', r1), '42501', 'a POS token cannot use manager actions');

  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_count('select count(*) from public.reservations', 5, 'manager sees the location orders');
  perform public.sf_reservation_confirm(r1);
  perform pg_temp.expect_msg(format('select public.sf_reservation_confirm(%L)', r1), 'invalid_transition', 'cannot confirm twice');
  perform public.sf_reservation_ready(r1);
  perform pg_temp.expect_msg(format('select public.sf_reservation_pickup(%L, false)', r2), 'id_check_required', 'vape items ALWAYS need the ID check, even with the shop toggle off');
  perform public.sf_reservation_pickup(r2, true);
  perform public.sf_reservation_pickup(r1, false);                                    -- non-restricted + toggle off: allowed
  perform pg_temp.expect_msg(format('select public.sf_reservation_pickup(%L, true)', r1), 'invalid_transition', 'cannot pick up twice');
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and id_checked_at_pickup and id_checked_by = ''Mo Manager''', r2), 1, 'who checked the ID is recorded');
  perform public.sf_reservation_pay_register(r2);
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and payment_status = ''paid_at_register''', r2), 1, 'paid at register recorded');
  perform pg_temp.expect_msg(format('select public.sf_reservation_cancel(%L, '' '')', r3), 'reason_required', 'cancel needs a reason');
  perform public.sf_reservation_cancel(r3, 'Customer called');
  perform public.sf_reservation_no_show(r4);
  perform pg_temp.expect_msg(format('select public.sf_reservation_pay_register(%L)', r3), 'invalid_transition', 'cancelled orders cannot be paid');
  perform pg_temp.expect_msg(format('select public.sf_reservation_no_show(%L)', r2), 'invalid_transition', 'picked-up orders cannot become no-show');

  -- with the toggle ON everything needs the check
  perform pg_temp.become('postgres', null);
  update public.storefront_settings set require_id_at_pickup = true where location_id = lb;
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_msg(format('select public.sf_reservation_pickup(%L, false)', r5), 'id_check_required', 'toggle on: every pickup needs the ID check');

  -- fees accrue ONLY on pickup; cancelled and no-show orders never owe a fee
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where reservation_id in (%L, %L)', r3, r4), 0, 'no ledger rows for cancelled / no-show');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where reservation_id in (%L, %L) and status = ''accrued''', r1, r2), 2, 'picked-up orders accrue');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger l join public.reservations r on r.id = l.reservation_id where l.reservation_id = %L and l.amount = r.fee_amount', r2), 1, 'ledger amount equals the snapshot');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where reservation_id = %L and period = to_char(now() at time zone ''America/Chicago'', ''YYYY-MM'')', r1), 1, 'period is the pickup month in the shop timezone');

  -- ledger visibility needs storefront.fees.view
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_count('select count(*) from public.fee_ledger', 0, 'default manager cannot see fees');
  perform pg_temp.become('authenticated', fees);
  perform pg_temp.expect_count('select count(*) from public.fee_ledger', 2, 'admin role sees the ledger');
  perform pg_temp.become('authenticated', deny);
  perform pg_temp.expect_count('select count(*) from public.fee_ledger', 2, 'explicit fees.view grants it');
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_count('select count(*) from public.fee_ledger', 0, 'other tenant sees nothing');
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_error('select count(*) from public.storefront_outbox', '42501', 'outbox is service-only');
  perform pg_temp.expect_error('insert into public.fee_ledger (tenant_id, location_id, reservation_id, amount, period) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, ''2026-01'')', '42501', 'no direct ledger writes');
  perform pg_temp.expect_error(format('update public.reservations set status = ''picked_up'' where id = %L', r5), '42501', 'no direct reservation writes');

  -- append-only audit trail; notifications queued
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_error(format('update public.reservation_events set type = ''x'' where reservation_id = %L', r1), 'P0001', 'events are immutable (update)');
  perform pg_temp.expect_error(format('delete from public.reservation_events where reservation_id = %L', r1), 'P0001', 'events are immutable (delete)');
  perform pg_temp.expect_count(format('select count(*) from public.reservation_events where reservation_id = %L and type in (''created'', ''confirmed'', ''ready'', ''picked_up'')', r1), 4, 'full trail for an order');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_outbox where reservation_id = %L and audience = ''shop'' and kind = ''new_reservation''', r1), 1, 'shop notified of the new reservation');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_outbox where reservation_id = %L and audience = ''customer'' and kind in (''confirmed'', ''ready'')', r1), 2, 'customer notified: confirmed and ready');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_outbox where reservation_id in (%L, %L) and audience = ''customer'' and kind in (''cancelled'', ''no_show'')', r3, r4), 2, 'customer notified of cancel and no-show');
  perform set_config('t.picked1', r1::text, true);
  perform set_config('t.picked2', r2::text, true);
  raise notice 'PASS 7: workflow, ID rule, ledger and visibility';
end $$;

-- ================================================================ 8. item unavailable: remove / replace with a stable fee snapshot
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'); ca uuid := 'c1000000-0000-0000-0000-000000000001';
  a uuid; b uuid; c uuid; res uuid; l1 uuid; l2 uuid; j jsonb;
begin
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty) values (t1, lb, 'curated', 'Item A', 10.00, 10) returning id into a;
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty) values (t1, lb, 'curated', 'Item B', 20.00, 10) returning id into b;
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty) values (t1, lb, 'curated', 'Item C', 7.77, 1) returning id into c;
  update public.business_storefront_defaults set fee_type = 'percent', fee_value = 10 where tenant_id = t1;
  perform pg_temp.become('authenticated', pg_temp.cust(ca));
  res := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', a, 'qty', 1), jsonb_build_object('item_id', b, 'qty', 1))) ->> 'id')::uuid;
  if (select fee_amount from public.reservations where id = res) <> 3.00 then raise exception 'FAIL: 10%% of 30'; end if;
  select id into l1 from public.reservation_items where reservation_id = res and name = 'Item A';
  select id into l2 from public.reservation_items where reservation_id = res and name = 'Item B';

  perform pg_temp.become('authenticated', mgr);
  j := public.sf_reservation_item_unavailable(res, l1);
  if (j ->> 'subtotal')::numeric <> 20.00 or (j ->> 'fee_amount')::numeric <> 2.00 or (j ->> 'total')::numeric <> 22.00 then raise exception 'FAIL: removal recalculation %', j; end if;
  perform pg_temp.expect_msg(format('select public.sf_reservation_item_unavailable(%L, %L)', res, l2), 'cannot_remove_last_item', 'removing the only line must be a cancel');
  j := public.sf_reservation_item_unavailable(res, l2, c, 1);
  if (j ->> 'subtotal')::numeric <> 7.77 or (j ->> 'fee_amount')::numeric <> 0.78 or (j ->> 'total')::numeric <> 8.55 then raise exception 'FAIL: replacement recalculation %', j; end if;
  perform pg_temp.expect_count(format('select count(*) from public.reservation_items where reservation_id = %L and is_removed', res), 2, 'removed lines stay for the audit');
  perform pg_temp.expect_count(format('select count(*) from public.storefront_outbox where reservation_id = %L and kind = ''items_changed''', res), 2, 'customer told about each change');
  if (select fee_value from public.reservations where id = res) <> 10 then raise exception 'FAIL: snapshot untouched'; end if;
end $$;

do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'); a uuid; b uuid; res uuid; l uuid; j jsonb;
begin
  perform pg_temp.become('postgres', null);
  select id into a from public.storefront_items where name = 'Item A';
  select id into b from public.storefront_items where name = 'Item B';
  update public.storefront_items set status = 'available' where id = a;
  update public.business_storefront_defaults set fee_waived = true where tenant_id = t1;       -- waived fee stays 0 through edits
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000002'));
  res := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', a, 'qty', 1), jsonb_build_object('item_id', b, 'qty', 1))) ->> 'id')::uuid;
  select id into l from public.reservation_items where reservation_id = res and name = 'Item A';
  perform pg_temp.become('postgres', null);
  update public.storefront_items set status = 'sold_out' where id = b;
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_msg(format('select public.sf_reservation_item_unavailable(%L, %L, %L)', res, l, b), 'item_unavailable', 'cannot replace with a sold-out item');
  j := public.sf_reservation_item_unavailable(res, l, a, 2);
  if (j ->> 'fee_amount')::numeric <> 0 or (j ->> 'total')::numeric <> (j ->> 'subtotal')::numeric then raise exception 'FAIL: waived fee stays zero %', j; end if;
  perform pg_temp.become('postgres', null);
  update public.business_storefront_defaults set fee_waived = false, fee_type = 'percent', fee_value = 5 where tenant_id = t1;
  update public.storefront_items set status = 'available' where id = b;
  raise notice 'PASS 8: item unavailable flow keeps the fee snapshot';
end $$;

-- ================================================================ 9. POS completes a reservation as a normal sale
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; la uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  juice uuid; res uuid; pos jsonb := pg_temp.ck('register', t1, null, 'aaaaaaaa-0000-0000-0000-0000000000a1');
begin
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();
  select id into juice from public.storefront_items where pos_product_id = 'BC1';
  update public.storefront_items set status = 'available' where id = juice;
  update public.inventory_cloud set price = 10.00 where barcode = 'BC1';
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  res := (public.create_reservation(la, jsonb_build_array(jsonb_build_object('item_id', juice, 'qty', 2))) ->> 'id')::uuid;
  if (select subtotal from public.reservations where id = res) <> 20.00 then raise exception 'FAIL: POS price used'; end if;
  if public.sf_item_available(juice) <> 3 then raise exception 'FAIL: POS stock minus open reservations (5 - 2)'; end if;

  perform pg_temp.become('authenticated', pg_temp.ck('register', t1, null, lb));
  perform pg_temp.expect_error(format('select public.pos_link_reservation_sale(%L, ''SALE-1'', null, ''X'')', res), '42501', 'POS at another location');
  perform pg_temp.become('authenticated', pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'));
  perform pg_temp.expect_error(format('select public.pos_link_reservation_sale(%L, ''SALE-1'', null, ''X'')', res), '42501', 'managers use the board, not the POS function');
  perform pg_temp.become('authenticated', pos);
  perform pg_temp.expect_msg(format('select public.pos_link_reservation_sale(%L, '' '', null, ''Cass'')', res), 'sale_required', 'needs the sale id');
  perform public.pos_link_reservation_sale(res, 'SALE-1001', null, 'Cass Cashier');
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and status = ''picked_up'' and sale_id = ''SALE-1001'' and payment_status = ''paid_at_register'' and id_checked_at_pickup', res), 1, 'linked to the sale, paid at register, ID checked');
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where reservation_id = %L and status = ''accrued''', res), 1, 'fee accrues for POS-completed pickups too');
  perform pg_temp.become('authenticated', pos);
  perform pg_temp.expect_msg(format('select public.pos_link_reservation_sale(%L, ''SALE-2'', null, ''Cass'')', res), 'invalid_transition', 'cannot link twice');
  raise notice 'PASS 9: POS pickups';
end $$;

-- ================================================================ 10. hold expiry
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  item uuid; rn uuid; rc uuid; rr uuid; rp uuid; rk uuid; n integer; mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b');
begin
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();
  insert into public.storefront_items (tenant_id, location_id, source, name, price, qty) values (t1, lb, 'curated', 'Expiry Item', 4.00, 4) returning id into item;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  rn := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  rc := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000002'));
  rr := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  rp := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  perform pg_temp.become('authenticated', mgr);
  perform public.sf_reservation_confirm(rc);
  perform public.sf_reservation_ready(rr);
  perform public.sf_reservation_pickup(rp, true);
  if public.sf_item_available(item) <> 1 then raise exception 'FAIL: 4 units, 3 open reservations (rp is picked up and still holds nothing)'; end if;

  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_error('select public.expire_reservation_holds()', '42501', 'managers cannot run the job');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  if public.expire_reservation_holds() <> 0 then raise exception 'FAIL: nothing is due yet'; end if;
  perform pg_temp.become('postgres', null);
  update public.reservations set hold_expires_at = now() - interval '1 minute' where id in (rn, rc, rr, rp);
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  n := public.expire_reservation_holds();
  if n <> 3 then raise exception 'FAIL: expected 3 expired holds, got %', n; end if;
  if public.expire_reservation_holds() <> 0 then raise exception 'FAIL: expiry is idempotent'; end if;
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and status = ''cancelled'' and cancel_reason = ''hold expired''', rn), 1, 'unprepared order is cancelled');
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and status = ''cancelled''', rc), 1, 'confirmed but never ready: cancelled');
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and status = ''no_show''', rr), 1, 'ready and never collected: no-show');
  perform pg_temp.expect_count(format('select count(*) from public.reservations where id = %L and status = ''picked_up''', rp), 1, 'picked-up orders are untouched');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where reservation_id in (%L, %L, %L)', rn, rc, rr), 0, 'expired holds owe no fee');
  if public.sf_item_available(item) <> 4 then raise exception 'FAIL: expiry releases the stock'; end if;
  perform pg_temp.expect_count(format('select count(*) from public.storefront_outbox where reservation_id in (%L, %L, %L) and audience = ''customer'' and kind in (''cancelled'', ''no_show'')', rn, rc, rr), 3, 'customers told');

  -- shops that turned auto-cancel off keep their holds
  update public.storefront_settings set auto_cancel_no_show = false where location_id = lb;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000003'));
  rk := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  perform pg_temp.become('postgres', null);
  update public.reservations set hold_expires_at = now() - interval '1 hour' where id = rk;
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  if public.expire_reservation_holds() <> 0 then raise exception 'FAIL: auto-cancel disabled'; end if;
  perform pg_temp.become('postgres', null);
  update public.storefront_settings set auto_cancel_no_show = true where location_id = lb;
  raise notice 'PASS 10: hold expiry';
end $$;

-- ================================================================ 11. statements: totals, idempotency, dry run, mark paid
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; t2 uuid := '22222222-2222-2222-2222-222222222222';
  lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; lc uuid := 'aaaaaaaa-0000-0000-0000-0000000000c1'; owner jsonb := pg_temp.ck('owner', t1);
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'); fees jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000a');
  mgr2 jsonb := pg_temp.ck('manager', t2, 'e0000000-0000-0000-0000-00000000000d'); j jsonb; st uuid; rid uuid;
begin
  perform pg_temp.become('postgres', null);
  delete from public.fee_statements; perform pg_temp.wipe();
  -- hand-built ledger across two months and two tenants (reservations are required by the foreign key)
  for rid in select gen_random_uuid() from generate_series(1, 6) loop
    insert into public.reservations (id, code, tenant_id, location_id, customer_id, status, subtotal, fee_amount, total, age_verified_at_booking, hold_expires_at, picked_up_at)
    values (rid, upper(substr(rid::text, 1, 8)), case when (select count(*) from public.reservations) < 5 then t1 else t2 end,
            case when (select count(*) from public.reservations) < 5 then lb else lc end, gen_random_uuid(), 'picked_up', 10, 0.50, 10.50, now(), now(), '2026-03-15 15:00+00');
  end loop;
  insert into public.fee_ledger (tenant_id, location_id, reservation_id, amount, status, period)
  select r.tenant_id, r.location_id, r.id,
         (array[0.50, 1.25, 0.99, 2.00, 0.50, 3.00])[row_number() over (order by r.code)],
         (array['accrued', 'accrued', 'accrued', 'waived', 'accrued', 'accrued'])[row_number() over (order by r.code)],
         (array['2026-03', '2026-03', '2026-04', '2026-03', '2026-03', '2026-03'])[row_number() over (order by r.code)]
    from public.reservations r;
  -- expected for tenant T1 in 2026-03: accrued rows only. Compute independently of the function under test.
  select sum(amount), count(*) into j from (select 1) x, lateral (select coalesce(sum(amount),0) amount, count(*) from public.fee_ledger where tenant_id = t1 and period = '2026-03' and status = 'accrued') y limit 1;
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_error(format('select public.sf_build_statement(%L, ''2026-03'')', t1), '42501', 'managers cannot build statements');
  perform pg_temp.expect_error(format('select public.sf_build_statement(%L, ''2026-03'')', t1), '42501', 'managers cannot build statements');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  perform pg_temp.expect_msg(format('select public.sf_build_statement(%L, ''2026-13'')', t1), 'period_invalid', 'bad period');
  j := public.sf_build_statement(t1, '2026-03', true);
  if (j ->> 'dry_run')::boolean is not true then raise exception 'FAIL: dry run flag'; end if;
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.fee_statements where tenant_id = %L', t1), 0, 'dry run writes nothing');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where tenant_id = %L and status = ''invoiced''', t1), 0, 'dry run does not touch the ledger');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  j := public.sf_build_statement(t1, '2026-03');
  if (j ->> 'count')::int <> (select count(*) from public.fee_ledger where tenant_id = t1 and period = '2026-03' and status = 'invoiced') then raise exception 'FAIL: count matches invoiced rows %', j; end if;
  if (j ->> 'total')::numeric <> (select sum(amount) from public.fee_ledger where tenant_id = t1 and period = '2026-03' and status = 'invoiced') then raise exception 'FAIL: total matches invoiced rows %', j; end if;
  if (j ->> 'total')::numeric = 0 then raise exception 'FAIL: fixture produced a zero statement'; end if;
  st := (j ->> 'statement_id')::uuid;
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where tenant_id = %L and period = ''2026-04'' and status = ''accrued''', t1), 1, 'other months stay accrued');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where tenant_id = %L and status = ''waived''', t1), 1, 'waived rows never invoiced');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where tenant_id = %L and period = ''2026-03'' and status = ''accrued''', t2), 2, 'other tenants untouched');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  j := public.sf_build_statement(t1, '2026-03');
  if (j ->> 'already_issued')::boolean is not true or (j ->> 'statement_id')::uuid <> st then raise exception 'FAIL: building twice returns the same statement %', j; end if;
  perform pg_temp.expect_count(format('select count(*) from public.fee_statements where tenant_id = %L', t1), 1, 'one statement per tenant and month');
  j := public.sf_build_statement(t1, '2026-02');
  if (j ->> 'total')::numeric <> 0 or (j ->> 'count')::int <> 0 then raise exception 'FAIL: empty month %', j; end if;

  -- visibility and paying
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_count('select count(*) from public.fee_statements', 0, 'default manager cannot see statements');
  perform pg_temp.become('authenticated', fees);
  perform pg_temp.expect_count('select count(*) from public.fee_statements', 2, 'admin sees own statements');
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_count('select count(*) from public.fee_statements', 0, 'other tenant sees none');
  perform pg_temp.become('authenticated', fees);
  perform pg_temp.expect_error(format('select public.sf_mark_statement_paid(%L)', st), '42501', 'a shop cannot mark its own statement paid');
  perform pg_temp.become('authenticated', owner);
  perform public.sf_mark_statement_paid(st);
  perform public.sf_mark_statement_paid(st);          -- idempotent
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count(format('select count(*) from public.fee_statements where id = %L and status = ''paid'' and paid_at is not null', st), 1, 'statement paid');
  perform pg_temp.expect_count(format('select count(*) from public.fee_ledger where statement_id = %L and status = ''paid''', st), (select count(*) from public.fee_ledger where statement_id = st), 'ledger rows follow the statement');
  perform pg_temp.become('authenticated', pg_temp.ck('owner', t2));
  perform pg_temp.expect_msg(format('select public.sf_mark_statement_paid(%L)', st), 'statement_not_found', 'another business owner token cannot touch it');
  raise notice 'PASS 11: statements';
end $$;

-- ================================================================ 12. reports, dashboard, permission toggles
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; lc uuid := 'aaaaaaaa-0000-0000-0000-0000000000c1';
  owner jsonb := pg_temp.ck('owner', t1); mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b');
  adm jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000a'); mgr2 jsonb := pg_temp.ck('manager', '22222222-2222-2222-2222-222222222222', 'e0000000-0000-0000-0000-00000000000d');
  j jsonb; item uuid; r uuid;
begin
  perform pg_temp.become('postgres', null);
  delete from public.fee_statements; perform pg_temp.wipe();
  select id into item from public.storefront_items where name = 'Unlimited';
  update public.business_storefront_defaults set fee_type = 'percent', fee_value = 10, fee_waived = false where tenant_id = t1;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  r := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 2))) ->> 'id')::uuid;      -- 6.00 + 0.60
  perform pg_temp.become('authenticated', mgr);
  perform public.sf_reservation_pickup(r, true);
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000002'));
  r := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  perform pg_temp.become('authenticated', mgr);
  perform public.sf_reservation_no_show(r);

  j := public.sf_report(lb, now() - interval '1 day', now() + interval '1 day');
  if (j ->> 'orders')::int <> 2 or (j ->> 'online_sales')::numeric <> 6.00 or (j ->> 'no_show_rate')::numeric <> 0.5 then raise exception 'FAIL: report %', j; end if;
  if (j -> 'by_status' ->> 'picked_up')::int <> 1 or (j -> 'by_status' ->> 'no_show')::int <> 1 then raise exception 'FAIL: by status %', j; end if;
  if jsonb_array_length(j -> 'top_items') <> 1 or j -> 'top_items' -> 0 ->> 'name' <> 'Unlimited' then raise exception 'FAIL: top items %', j; end if;
  if jsonb_array_length(j -> 'hourly') < 1 then raise exception 'FAIL: hourly heatmap'; end if;
  -- fees_accrued only counts what the reports permission shows; business roll-up works for a tenant-wide token
  if (j ->> 'fees_accrued')::numeric <> 0.60 then raise exception 'FAIL: fees in report %', j; end if;
  j := public.sf_report(null, now() - interval '1 day', now() + interval '1 day');
  if (j ->> 'orders')::int <> 2 or jsonb_array_length(j -> 'by_location') <> 1 then raise exception 'FAIL: roll-up %', j; end if;
  perform pg_temp.expect_error(format('select public.sf_report(%L, now() - interval ''1 day'', now())', lc), '42501', 'another tenant location');
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_error(format('select public.sf_report(%L, now() - interval ''1 day'', now())', lb), '42501', 'other tenant manager');
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  perform pg_temp.expect_error(format('select public.sf_report(%L, now() - interval ''1 day'', now())', lb), '42501', 'customers cannot run reports');

  perform pg_temp.become('authenticated', mgr);
  j := public.sf_dashboard(lb);
  if (j ->> 'today')::int <> 2 or (j ->> 'pending')::int <> 0 or (j ->> 'orders_7d')::int <> 2 or (j ->> 'sales_7d')::numeric <> 6.00 or (j ->> 'fees_7d')::numeric <> 0.60 then raise exception 'FAIL: dashboard %', j; end if;
  if (j ->> 'sold_out')::int < 1 then raise exception 'FAIL: dashboard sold-out count %', j; end if;
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_error(format('select public.sf_dashboard(%L)', lb), '42501', 'dashboard is tenant scoped');

  -- permission toggles: owner/admin only, logged append-only, effective immediately
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_error('select public.sf_set_permission(''e0000000-0000-0000-0000-00000000000c'', ''storefront.reports.view'', false)', '42501', 'managers cannot grant permissions');
  perform pg_temp.become('authenticated', adm);
  perform public.sf_set_permission('e0000000-0000-0000-0000-00000000000b', 'storefront.orders.manage', false);
  perform pg_temp.expect_msg('select public.sf_set_permission(''e0000000-0000-0000-0000-00000000000b'', ''storefront.root'', true)', 'permission_key_invalid', 'unknown key');
  perform pg_temp.expect_msg('select public.sf_set_permission(gen_random_uuid(), ''storefront.view'', true)', 'employee_not_found', 'unknown employee');
  perform pg_temp.expect_msg('select public.sf_set_permission(''e0000000-0000-0000-0000-00000000000d'', ''storefront.view'', false)', 'employee_not_found', 'cannot touch another tenant employee');
  perform pg_temp.become('authenticated', mgr);
  if public.sf_can('storefront.orders.manage') then raise exception 'FAIL: revoke takes effect immediately'; end if;
  perform pg_temp.expect_error(format('select public.sf_reservation_confirm(%L)', r), '42501', 'revoked manager cannot act');
  perform pg_temp.become('authenticated', owner);
  perform public.sf_set_permission('e0000000-0000-0000-0000-00000000000b', 'storefront.orders.manage', true);
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count('select count(*) from public.permission_override_log_cloud where event_type = ''storefront_permission'' and required_permission = ''storefront.orders.manage''', 2, 'both changes logged');
  perform pg_temp.expect_count('select count(*) from public.permission_override_log_cloud where event_type = ''storefront_permission'' and acting_employee_name = ''Mo Manager'' and authorizing_manager_name = ''Ada Admin'' and action_attempted = ''revoke storefront.orders.manage''', 1, 'who changed whose permission');
  perform pg_temp.expect_error('delete from public.permission_override_log_cloud', 'P0001', 'override log stays append-only');
  perform pg_temp.become('authenticated', owner);
  perform pg_temp.expect_count('select count(*) from public.employee_permissions_cloud where permission_key = ''storefront.orders.manage''', 1, 'toggling again updates the same row');
  raise notice 'PASS 12: reports, dashboard, permission toggles';
end $$;

-- ================================================================ 13. no card path, legacy flow untouched
do $$
begin
  perform pg_temp.become('postgres', null);
  -- the DB has no column or function that could hold or process a card for reservations
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('reservations', 'reservation_items', 'fee_ledger', 'fee_statements', 'storefront_settings')
              and column_name ~* '(card|stripe|payment_intent|pan|cvc|token)') then raise exception 'FAIL: reservation tables must not store card or Stripe data'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_reservation', 'sf_save_settings', 'sf_owner_save_defaults')
              and pg_get_functiondef(p.oid) ~* 'stripe') then raise exception 'FAIL: storefront RPCs must not reference Stripe'; end if;
  if (select (value ->> 'enabled')::boolean from public.app_config where key = 'storefront_prepay') is not false then raise exception 'FAIL: prepay flag defaults off'; end if;
  -- an Owner Console (business) token is not a platform admin: it cannot flip the prepay switch (RLS updates 0 rows)
  perform pg_temp.become('authenticated', pg_temp.ck('owner', '11111111-1111-1111-1111-111111111111'));
  update public.app_config set value = '{"enabled": true}' where key = 'storefront_prepay';
  perform pg_temp.become('postgres', null);
  if (select (value ->> 'enabled')::boolean from public.app_config where key = 'storefront_prepay') is not false then raise exception 'FAIL: only a platform admin may enable prepay'; end if;
  raise notice 'PASS 13: no card path';
end $$;

-- ================================================================ 14. outbox worker
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1'; r uuid; c record; n integer; item uuid;
begin
  perform pg_temp.become('postgres', null);
  perform pg_temp.wipe();
  delete from public.storefront_outbox;
  update public.storefront_customers set email = 'cora@test.dev' where id = 'c1000000-0000-0000-0000-000000000001';
  update public.locations set email = ' shop@t1.dev ' where id = lb;
  select id into item from public.storefront_items where name = 'Unlimited';
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  r := (public.create_reservation(lb, jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 1))) ->> 'id')::uuid;
  perform pg_temp.become('authenticated', pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'));
  perform pg_temp.expect_error('select * from public.sf_outbox_claim(10)', '42501', 'managers cannot drain the outbox');
  perform pg_temp.expect_error('select public.sf_outbox_done(1, true)', '42501', 'managers cannot mark sent');
  perform public.sf_reservation_ready(r);
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  select count(*) into n from public.sf_outbox_claim(10);
  if n <> 2 then raise exception 'FAIL: expected 2 pending notifications (new, ready), got %', n; end if;
  select * into c from public.storefront_outbox where kind = 'new_reservation';
  if c.attempts <> 1 then raise exception 'FAIL: claiming counts an attempt'; end if;
  select * into c from public.sf_outbox_claim(10) where kind = 'new_reservation';
  if c.payload ->> 'shop_email' <> 'shop@t1.dev' or c.payload -> 'reservation' ->> 'code' is null then raise exception 'FAIL: payload %', c.payload; end if;
  if c.audience <> 'shop' then raise exception 'FAIL: audience'; end if;
  perform public.sf_outbox_done(c.id, true);
  select * into c from public.sf_outbox_claim(10) where kind = 'ready';
  if c.payload ->> 'customer_email' <> 'cora@test.dev' or c.audience <> 'customer' then raise exception 'FAIL: customer payload %', c.payload; end if;
  perform public.sf_outbox_done(c.id, false, 'resend 500');
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count('select count(*) from public.storefront_outbox where sent_at is null and last_error = ''resend 500''', 1, 'failure recorded, still pending');
  perform pg_temp.expect_count('select count(*) from public.storefront_outbox where sent_at is not null', 1, 'sent one');
  update public.storefront_outbox set attempts = 5 where sent_at is null;
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  select count(*) into n from public.sf_outbox_claim(10);
  if n <> 0 then raise exception 'FAIL: rows over the attempt cap are not retried forever'; end if;
  -- shop email falls back to the business contact when the location has none
  perform pg_temp.become('postgres', null);
  update public.locations set email = null where id = lb;
  insert into public.licenses (license_key, tenant_id, kind, name, contact_email) values ('RACKD-TEST-TEST-TEST', t1, 'business', 'Fallback Biz', 'owner@t1.dev');
  insert into public.storefront_outbox (reservation_id, tenant_id, location_id, kind, audience) values (r, t1, lb, 'new_reservation', 'shop');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  select * into c from public.sf_outbox_claim(10);
  if c.payload ->> 'shop_email' <> 'owner@t1.dev' then raise exception 'FAIL: fallback shop email %', c.payload; end if;
  raise notice 'PASS 14: outbox worker';
end $$;

-- ================================================================ 15. UI read helpers
do $$
declare t1 uuid := '11111111-1111-1111-1111-111111111111'; t2 uuid := '22222222-2222-2222-2222-222222222222';
  la uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1'; lb uuid := 'aaaaaaaa-0000-0000-0000-0000000000b1';
  owner jsonb := pg_temp.ck('owner', t1); adm jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000a');
  mgr jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000b'); deny jsonb := pg_temp.ck('manager', t1, 'e0000000-0000-0000-0000-00000000000c');
  mgr2 jsonb := pg_temp.ck('manager', t2, 'e0000000-0000-0000-0000-00000000000d'); j jsonb; n integer; row record;
begin
  perform pg_temp.become('postgres', null);
  update public.inventory_cloud set price = 10.00, quantity = 5 where barcode = 'BC1';
  perform pg_temp.become('authenticated', mgr);
  j := public.sf_my_permissions();
  if (j ->> 'view')::boolean is not true or (j ->> 'settings_edit')::boolean or (j ->> 'owner')::boolean or (j ->> 'manage_staff')::boolean then raise exception 'FAIL: manager permissions %', j; end if;
  perform pg_temp.become('authenticated', adm);
  j := public.sf_my_permissions();
  if not ((j ->> 'admin')::boolean and (j ->> 'fees_view')::boolean and (j ->> 'manage_staff')::boolean) then raise exception 'FAIL: admin permissions %', j; end if;
  perform pg_temp.become('authenticated', owner);
  if not (public.sf_my_permissions() ->> 'owner')::boolean then raise exception 'FAIL: owner'; end if;
  perform pg_temp.become('authenticated', pg_temp.cust('c1000000-0000-0000-0000-000000000001'));
  j := public.sf_my_permissions();
  if (j ->> 'view')::boolean or (j ->> 'owner')::boolean then raise exception 'FAIL: customers have nothing %', j; end if;
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error('select public.sf_my_permissions()', '42501', 'anon');

  -- items list: POS data resolved, read-only flag, tenant guard
  perform pg_temp.become('authenticated', mgr);
  select * into row from public.sf_items_list(la) where pos_product_id = 'BC1';
  if row.name <> 'POS Juice' or row.price <> 10.00 or row.qty <> 5 or not row.read_only or row.pos_missing then raise exception 'FAIL: POS item resolved %', row; end if;
  select * into row from public.sf_items_list(lb) where name = 'Curated Mango';
  if row.read_only or row.source <> 'curated' then raise exception 'FAIL: curated item editable'; end if;
  perform pg_temp.become('postgres', null);
  delete from public.inventory_cloud where barcode = 'BC1';
  perform pg_temp.become('authenticated', mgr);
  if not (select pos_missing from public.sf_items_list(la) where pos_product_id = 'BC1') then raise exception 'FAIL: removed POS product flagged'; end if;
  perform pg_temp.become('postgres', null);
  insert into public.inventory_cloud (tenant_id, location_id, barcode, name, category, price, quantity) values (t1, la, 'BC1', 'POS Juice', 'eliquid', 10.00, 5);
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_error(format('select * from public.sf_items_list(%L)', la), '42501', 'other tenant cannot list items');
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error(format('select * from public.sf_items_list(%L)', la), '42501', 'anon cannot list items');

  -- POS picker
  perform pg_temp.become('authenticated', mgr);
  select count(*) into n from public.sf_pos_products(la, 'glass');
  if n <> 1 then raise exception 'FAIL: POS search by name, got %', n; end if;
  if not (select already_added from public.sf_pos_products(la, 'BC1')) then raise exception 'FAIL: already_added flag'; end if;
  select count(*) into n from public.sf_pos_products(la, null);
  if n <> 2 then raise exception 'FAIL: POS list, got %', n; end if;
  perform pg_temp.become('authenticated', deny);
  perform pg_temp.expect_error(format('select * from public.sf_pos_products(%L)', la), '42501', 'picker needs items.edit');
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_error(format('select * from public.sf_pos_products(%L)', la), '42501', 'other tenant');

  -- staff list: owner/admin only, effective permissions equal sf_can
  perform pg_temp.become('authenticated', mgr);
  perform pg_temp.expect_error('select public.sf_staff_list()', '42501', 'plain managers cannot see the permission editor');
  perform pg_temp.become('authenticated', adm);
  j := public.sf_staff_list();
  if jsonb_array_length(j) <> 3 then raise exception 'FAIL: only this tenant admins and managers (3), got %', jsonb_array_length(j); end if;
  perform pg_temp.expect_count('select 1', 1, 'noop');
  if (select (e -> 'permissions' ->> 'storefront.items.edit')::boolean from jsonb_array_elements(j) e where e ->> 'username' = 'deny') then raise exception 'FAIL: explicit revoke shown'; end if;
  if (select (e -> 'permissions' ->> 'storefront.settings.edit')::boolean from jsonb_array_elements(j) e where e ->> 'username' = 'mgr') then raise exception 'FAIL: default-off shown as on'; end if;
  if not (select (e -> 'permissions' ->> 'storefront.fees.view')::boolean from jsonb_array_elements(j) e where e ->> 'username' = 'adm') then raise exception 'FAIL: admin has everything'; end if;
  if not (select (e ->> 'locked')::boolean from jsonb_array_elements(j) e where e ->> 'username' = 'adm') then raise exception 'FAIL: admin locked'; end if;
  perform pg_temp.become('authenticated', mgr2);
  perform pg_temp.expect_error('select public.sf_staff_list()', '42501', 'other tenant manager');

  -- storefront photo upload policy: owner tokens may write only into their own tenant folder
  perform pg_temp.become('postgres', null);
  insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true) on conflict (id) do nothing;
  perform pg_temp.become('authenticated', owner);
  insert into storage.objects (bucket_id, name) values ('product-images', t1::text || '/storefront/a.jpg');
  perform pg_temp.expect_error(format('insert into storage.objects (bucket_id, name) values (''product-images'', %L)', t2::text || '/storefront/a.jpg'), '42501', 'owner cannot write into another tenant folder');
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error(format('insert into storage.objects (bucket_id, name) values (''product-images'', %L)', t1::text || '/storefront/b.jpg'), '42501', 'anon cannot upload');
  raise notice 'PASS 15: UI read helpers';
end $$;

reset role;
rollback;
select 'ALL STOREFRONT MANAGER TESTS PASSED' as result;
