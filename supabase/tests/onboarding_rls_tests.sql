-- RLS / access tests for migrations 081-087. Run after the migrations in a scratch database
-- (scripts/run-sql-tests.js does this with an embedded Postgres), or paste into the Supabase SQL
-- editor on a non-production project. Everything runs in one transaction and rolls back.
-- Any failure raises an exception; success ends with "ALL ONBOARDING RLS TESTS PASSED".

begin;

create or replace function pg_temp.become(p_role text, p_claims jsonb) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  if p_role <> 'postgres' then execute format('set local role %I', p_role); end if;
end $$;

create or replace function pg_temp.expect_error(p_sql text, p_code text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_code then return; end if;
    raise exception 'FAIL %: expected SQLSTATE % but got % (%)', p_label, p_code, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL %: expected SQLSTATE % but statement succeeded', p_label, p_code;
end $$;

create or replace function pg_temp.expect_count(p_sql text, p_expected bigint, p_label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql into n;
  if n is distinct from p_expected then
    raise exception 'FAIL %: expected % rows but got %', p_label, p_expected, n;
  end if;
end $$;

-- ================================================================ fixtures (as service/superuser)
do $$
declare
  admin_id uuid := 'aaaaaaaa-1111-1111-1111-111111111111';
  plain_id uuid := 'bbbbbbbb-2222-2222-2222-222222222222';
  ra record; rb record;
  tos uuid; mer uuid;
  locA uuid := 'a0a0a0a0-0000-0000-0000-00000000000a';
  ownA uuid := 'a1a1a1a1-0000-0000-0000-00000000000a';
  docL1 uuid; docL2 uuid; docO uuid;
  pathpfx text; code text; res jsonb;
begin
  insert into auth.users (id, email) values (admin_id, 'admin@test.dev'), (plain_id, 'plain@test.dev');
  insert into public.platform_admins (user_id, email) values (admin_id, 'admin@test.dev');

  select * into ra from public.app_create('Alice Applicant', 'alice@test.dev', '5125550100', 'owner');
  select * into rb from public.app_create('Bob Applicant',   'bob@test.dev',   '5125550101', 'manager');
  perform set_config('t.appA', ra.application_id::text, false);
  perform set_config('t.tokA', ra.resume_token, false);
  perform set_config('t.appB', rb.application_id::text, false);
  perform set_config('t.tokB', rb.resume_token, false);

  insert into public.agreement_versions (kind, version, body_sha256) values ('terms_of_service', '2026-01', repeat('a', 64)) returning id into tos;
  insert into public.agreement_versions (kind, version, body_sha256) values ('merchant_agreement', '2026-01', repeat('b', 64)) returning id into mer;
  perform set_config('t.tos', tos::text, false);
  perform set_config('t.mer', mer::text, false);

  -- private config row (must stay hidden from anon)
  insert into public.app_config (key, value, is_public) values ('secret_cfg', '{"x":1}', false);

  -- build a complete, valid application for A
  perform public.app_save(ra.resume_token, jsonb_build_object(
    'legal_name', 'Alice Vapes LLC', 'entity_type', 'llc', 'years_in_business', 3,
    'mailing_address', jsonb_build_object('street', '1 Main', 'city', 'Austin', 'state', 'TX', 'zip', '78701'),
    'plan_model', 'model_a', 'addons', jsonb_build_array('sms_marketing', 'multi_location'),
    'operations', jsonb_build_object('registers', 2), 'current_step', 9));
  perform public.app_set_ein(ra.resume_token, 'Y2lwaGVydGV4dA==', 'aXY=', '6789');
  perform public.app_save_locations(ra.resume_token, jsonb_build_array(jsonb_build_object(
    'id', locA, 'name', 'Main St', 'street', '1 Main', 'city', 'Austin', 'state', 'TX', 'zip', '78701', 'licenses', '[]'::jsonb)));
  pathpfx := ra.application_id::text || '/';
  docL1 := public.app_register_document(ra.resume_token, 'license_tx_ecig', locA, null, pathpfx || 'ecig.pdf', 'ecig.pdf', 'application/pdf', 1000);
  docL2 := public.app_register_document(ra.resume_token, 'license_sales_tax', locA, null, pathpfx || 'tax.pdf', 'tax.pdf', 'application/pdf', 1000);
  perform public.app_save_locations(ra.resume_token, jsonb_build_array(jsonb_build_object(
    'id', locA, 'name', 'Main St', 'street', '1 Main', 'city', 'Austin', 'state', 'TX', 'zip', '78701',
    'licenses', jsonb_build_array(
      jsonb_build_object('kind', 'tx_ecig', 'number', 'EC-1', 'expiry', (current_date + 20)::text, 'document_id', docL1),
      jsonb_build_object('kind', 'sales_tax', 'number', 'ST-1', 'document_id', docL2)))));
  perform public.app_save_owners(ra.resume_token, jsonb_build_array(jsonb_build_object(
    'id', ownA, 'full_name', 'Alice Applicant', 'title', 'Owner', 'ownership_pct', 100, 'is_control_person', true)));
  docO := public.app_register_document(ra.resume_token, 'owner_id', null, ownA, pathpfx || 'id.jpg', 'id.jpg', 'image/jpeg', 2000);

  perform public.app_record_agreements(ra.resume_token, tos, mer, 'Alice Applicant', false, 'sms-v1', repeat('c', 64),
    true, 'ack-v1', '203.0.113.9', 'test-agent');
  code := public.app_email_code_issue(ra.resume_token);
  if not public.app_email_code_verify(ra.resume_token, code) then raise exception 'FAIL setup: email code verify'; end if;

  -- tenant fixtures for cross-business tests
  insert into public.hardware_orders (tenant_id, email, subtotal_cents, total_cents)
    values ('11111111-1111-1111-1111-111111111111', 't1@test.dev', 1000, 1000),
           ('22222222-2222-2222-2222-222222222222', 't2@test.dev', 2000, 2000),
           (null, 'guest@test.dev', 3000, 3000);
  insert into public.locations (id, tenant_id, name) values
    ('f1f1f1f1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'T1 store'),
    ('f2f2f2f2-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'T2 store');
  insert into public.business_permits (tenant_id, location_id, kind, number, expiry) values
    ('11111111-1111-1111-1111-111111111111', 'f1f1f1f1-0000-0000-0000-000000000001', 'tx_ecig', 'P1', current_date + 5),
    ('22222222-2222-2222-2222-222222222222', 'f2f2f2f2-0000-0000-0000-000000000002', 'tx_ecig', 'P2', current_date + 5);
end $$;

-- ================================================================ 1. anonymous: no table access
do $$
declare t text;
begin
  perform pg_temp.become('anon', null);
  foreach t in array array[
    'onboarding_applications','onboarding_locations','onboarding_owners','onboarding_documents',
    'onboarding_licenses','application_events','application_notes','agreement_signatures','sms_consents',
    'audit_log','platform_admins','hardware_orders','hardware_order_items','shipping_addresses',
    'stripe_events','rate_limits','provision_runs','owner_invites','business_fee_settings',
    'business_permits','permit_notices'] loop
    perform pg_temp.expect_error(format('select count(*) from public.%I', t), '42501', 'anon select ' || t);
  end loop;
  perform pg_temp.expect_error('insert into public.onboarding_applications (resume_token_hash, full_name, email) values (''x'',''x'',''x@x.dev'')', '42501', 'anon insert application');
  perform pg_temp.expect_error('update public.onboarding_applications set status = ''approved''', '42501', 'anon update application');
  perform pg_temp.expect_error('delete from public.onboarding_applications', '42501', 'anon delete application');
  perform pg_temp.expect_error('insert into public.hardware_orders (email, subtotal_cents, total_cents) values (''x@x.dev'',1,1)', '42501', 'anon insert order');
  perform pg_temp.expect_error('insert into public.app_config (key, value) values (''k'', ''{}'')', '42501', 'anon insert config');
  perform pg_temp.expect_error('update public.hardware_products set price_cents = 1', '42501', 'anon update product');
  raise notice 'PASS 1: anon has no access to application, file, order, or admin tables';
end $$;

-- ================================================================ 2. anon cannot call applicant RPCs directly
do $$
begin
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error(format('select public.app_get(%L)', current_setting('t.tokA')), '42501', 'anon app_get');
  perform pg_temp.expect_error('select * from public.app_create(''a'',''a@a.dev'',null,null)', '42501', 'anon app_create (bot bypass of Turnstile)');
  perform pg_temp.expect_error(format('select public.app_save(%L, ''{}''::jsonb)', current_setting('t.tokA')), '42501', 'anon app_save');
  perform pg_temp.expect_error(format('select public.app_submit(%L)', current_setting('t.tokA')), '42501', 'anon app_submit');
  perform pg_temp.expect_error('select public.rate_limit_hit(''x'', 60, 5)', '42501', 'anon rate_limit_hit');
  perform pg_temp.expect_error('select public.onb_provision(gen_random_uuid(), null)', '42501', 'anon onb_provision');
  perform pg_temp.expect_error('select public.write_audit(''a'',''b'',''c'',null,null)', '42501', 'anon write_audit');
  perform pg_temp.become('authenticated', jsonb_build_object('sub', 'bbbbbbbb-2222-2222-2222-222222222222', 'role', 'authenticated'));
  perform pg_temp.expect_error(format('select public.app_get(%L)', current_setting('t.tokA')), '42501', 'authenticated app_get');
  perform pg_temp.expect_error('select public.onb_provision(gen_random_uuid(), null)', '42501', 'authenticated onb_provision');
  raise notice 'PASS 2: applicant RPCs and provisioning are service-role only';
end $$;

-- ================================================================ 3. anon public reads are limited to public data
do $$
begin
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_count('select count(*) from public.app_config where key = ''secret_cfg''', 0, 'anon cannot see private config');
  perform pg_temp.expect_count('select count(*) from public.app_config where key = ''plans''', 1, 'anon sees public plans config');
  perform pg_temp.expect_count('select count(*) from public.agreement_versions', 2, 'anon reads agreement versions');
  perform pg_temp.expect_count('select count(*) from public.hardware_products where sku = ''POS-FULL''', 1, 'anon reads active products');
  perform pg_temp.expect_count('select count(*) from public.hardware_bundle_items', 16, 'anon reads bundle items');
  raise notice 'PASS 3: anon reads only public config, agreements and catalog';
end $$;

-- ================================================================ 4. non-admin authenticated sees no applications
do $$
begin
  perform pg_temp.become('authenticated', jsonb_build_object('sub', 'bbbbbbbb-2222-2222-2222-222222222222', 'role', 'authenticated'));
  perform pg_temp.expect_count('select count(*) from public.onboarding_applications', 0, 'non-admin applications');
  perform pg_temp.expect_count('select count(*) from public.onboarding_locations', 0, 'non-admin locations');
  perform pg_temp.expect_count('select count(*) from public.onboarding_documents', 0, 'non-admin documents');
  perform pg_temp.expect_count('select count(*) from public.application_events', 0, 'non-admin events');
  perform pg_temp.expect_count('select count(*) from public.audit_log', 0, 'non-admin audit log');
  perform pg_temp.expect_count('select count(*) from public.app_config where key = ''secret_cfg''', 0, 'non-admin private config');
  perform pg_temp.expect_error('select count(*) from public.owner_invites', '42501', 'non-admin owner_invites');
  perform pg_temp.expect_error('select public.admin_set_status(gen_random_uuid(), ''in_review'', null)', '42501', 'non-admin admin_set_status is rejected inside the function');
  raise notice 'PASS 4: non-admin authenticated users see no application data';
end $$;

-- ================================================================ 5. admin sees data, but never secret columns
do $$
begin
  perform pg_temp.become('authenticated', jsonb_build_object('sub', 'aaaaaaaa-1111-1111-1111-111111111111', 'role', 'authenticated'));
  perform pg_temp.expect_count('select count(*) from public.onboarding_applications', 2, 'admin applications');
  perform pg_temp.expect_count('select count(*) from public.onboarding_documents', 3, 'admin documents');
  perform pg_temp.expect_count('select count(ein_last4) from public.onboarding_applications', 1, 'admin sees EIN last4');
  perform pg_temp.expect_error('select ein_ciphertext from public.onboarding_applications', '42501', 'admin cannot read EIN ciphertext');
  perform pg_temp.expect_error('select ein_iv from public.onboarding_applications', '42501', 'admin cannot read EIN iv');
  perform pg_temp.expect_error('select resume_token_hash from public.onboarding_applications', '42501', 'admin cannot read token hashes');
  perform pg_temp.expect_error('select email_code_hash from public.onboarding_applications', '42501', 'admin cannot read email code hash');
  perform pg_temp.expect_error('select * from public.onboarding_applications', '42501', 'select * is denied because it includes secret columns');
  perform pg_temp.expect_error('select count(*) from public.owner_invites', '42501', 'admin cannot read invite token hashes');
  perform pg_temp.expect_error('update public.onboarding_applications set status = ''approved''', '42501', 'admin cannot write applications directly');
  perform pg_temp.expect_error('update public.audit_log set action = ''x''', '42501', 'audit log is immutable (update)');
  perform pg_temp.expect_error('delete from public.audit_log', '42501', 'audit log is immutable (delete)');
  perform pg_temp.expect_error('insert into public.audit_log (action, entity) values (''a'',''b'')', '42501', 'audit log cannot be forged');
  raise notice 'PASS 5: admin reads applications but not EIN ciphertext or tokens; audit log immutable';
end $$;

-- ================================================================ 6. token isolation between applicants
do $$
declare v jsonb; ownB uuid := 'b1b1b1b1-0000-0000-0000-00000000000b'; locB uuid := 'b0b0b0b0-0000-0000-0000-00000000000b';
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  v := public.app_get(current_setting('t.tokA'));
  if v #>> '{application,full_name}' <> 'Alice Applicant' then raise exception 'FAIL: token A returned wrong application'; end if;
  if v #> '{application,ein_ciphertext}' is not null or v #> '{application,resume_token_hash}' is not null then
    raise exception 'FAIL: app_get leaked secret columns'; end if;
  if (v #>> '{application,ein_last4}') <> '6789' or (v #>> '{application,ein_set}') <> 'true' then
    raise exception 'FAIL: app_get EIN summary wrong'; end if;
  if v::text like '%Y2lwaGVydGV4dA%' then raise exception 'FAIL: ciphertext in app_get payload'; end if;
  v := public.app_get(current_setting('t.tokB'));
  if v #>> '{application,full_name}' <> 'Bob Applicant' then raise exception 'FAIL: token B returned wrong application'; end if;
  if jsonb_array_length(v -> 'locations') <> 0 then raise exception 'FAIL: B sees A locations'; end if;

  perform pg_temp.expect_error('select public.app_get(''deadbeef'')', '28000', 'short token rejected');
  perform pg_temp.expect_error(format('select public.app_get(%L)', repeat('0', 64)), '28000', 'unknown token rejected');
  perform pg_temp.expect_error(format('select public.app_get(%L)', current_setting('t.appA')), '28000', 'application id is not a token');

  -- B cannot attach to A's rows or paths
  perform public.app_save_locations(current_setting('t.tokB'), jsonb_build_array(jsonb_build_object('id', locB, 'name', 'B store')));
  perform pg_temp.expect_error(format('select public.app_save_locations(%L, %L::jsonb)', current_setting('t.tokB'),
    jsonb_build_array(jsonb_build_object('id', 'a0a0a0a0-0000-0000-0000-00000000000a', 'name', 'hijack'))), '42501', 'B cannot overwrite A location');
  perform pg_temp.expect_error(format('select public.app_save_owners(%L, %L::jsonb)', current_setting('t.tokB'),
    jsonb_build_array(jsonb_build_object('id', 'a1a1a1a1-0000-0000-0000-00000000000a', 'full_name', 'hijack', 'ownership_pct', 10))), '42501', 'B cannot overwrite A owner');
  perform pg_temp.expect_error(format('select public.app_register_document(%L, ''owner_id'', null, null, %L, ''x.pdf'', ''application/pdf'', 10)',
    current_setting('t.tokB'), current_setting('t.appA') || '/evil.pdf'), '42501', 'B cannot write into A storage path');
  perform pg_temp.expect_error(format('select public.app_register_document(%L, ''requested_info'', %L, null, %L, ''x.pdf'', ''application/pdf'', 10)',
    current_setting('t.tokB'), 'a0a0a0a0-0000-0000-0000-00000000000a', current_setting('t.appB') || '/x.pdf'), '42501', 'B cannot attach doc to A location');
  perform pg_temp.expect_count(format('select count(*) from public.onboarding_locations where application_id = %L', current_setting('t.appA')), 1, 'A location untouched');

  -- file constraints
  perform pg_temp.expect_error(format('select public.app_register_document(%L, ''requested_info'', null, null, %L, ''x.exe'', ''application/x-msdownload'', 10)',
    current_setting('t.tokB'), current_setting('t.appB') || '/x.exe'), '23514', 'only PDF/JPG/PNG');
  perform pg_temp.expect_error(format('select public.app_register_document(%L, ''requested_info'', null, null, %L, ''big.pdf'', ''application/pdf'', 10485761)',
    current_setting('t.tokB'), current_setting('t.appB') || '/big.pdf'), '23514', '10MB cap');
  raise notice 'PASS 6: one applicant cannot read or touch another''s draft, rows or files';
end $$;

-- ================================================================ 7. EIN protection
do $$
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  perform pg_temp.expect_error(format('select public.app_set_ein(%L, ''12-3456789'', ''iv'', ''6789'')', current_setting('t.tokB')), '23514', 'raw EIN with dash rejected');
  perform pg_temp.expect_error(format('select public.app_set_ein(%L, ''123456789'', ''iv'', ''6789'')', current_setting('t.tokB')), '23514', 'raw EIN digits rejected');
  perform pg_temp.expect_error(format('select public.app_set_ein(%L, ''Y2lwaGVy'', ''iv'', ''67'')', current_setting('t.tokB')), '23514', 'last4 must be 4 digits');
  raise notice 'PASS 7: raw EIN can never be stored';
end $$;

-- ================================================================ 8. submit validation and state locking
do $$
declare r jsonb;
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  r := public.app_submit(current_setting('t.tokB'));
  if (r ->> 'ok')::boolean then raise exception 'FAIL: incomplete application submitted'; end if;
  if jsonb_array_length(r -> 'errors') < 5 then raise exception 'FAIL: expected several validation errors, got %', r; end if;

  r := public.app_submit(current_setting('t.tokA'));
  if not (r ->> 'ok')::boolean then raise exception 'FAIL: valid application rejected: %', r; end if;
  perform pg_temp.expect_count(format('select count(*) from public.onboarding_applications where id = %L and status = ''submitted''', current_setting('t.appA')), 1, 'A is submitted');

  -- submitted applications are locked for the applicant
  perform pg_temp.expect_error(format('select public.app_save(%L, ''{"legal_name":"changed"}''::jsonb)', current_setting('t.tokA')), '28000', 'cannot edit after submit');
  perform pg_temp.expect_error(format('select public.app_set_ein(%L, ''Zm9v'', ''aXY='', ''1111'')', current_setting('t.tokA')), '28000', 'cannot change EIN after submit');
  -- but can still read status
  if public.app_status(current_setting('t.tokA')) ->> 'status' <> 'submitted' then raise exception 'FAIL: status'; end if;
  raise notice 'PASS 8: submit validates, then locks the application';
end $$;

-- ================================================================ 9. owner rules (25% owners need ID, one control person)
do $$
declare r jsonb; o1 uuid := 'c1c1c1c1-0000-0000-0000-0000000000c1'; o2 uuid := 'c2c2c2c2-0000-0000-0000-0000000000c2';
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  perform public.app_save_owners(current_setting('t.tokB'), jsonb_build_array(
    jsonb_build_object('id', o1, 'full_name', 'Bob', 'ownership_pct', 60, 'is_control_person', true),
    jsonb_build_object('id', o2, 'full_name', 'Cara', 'ownership_pct', 40, 'is_control_person', true)));
  r := public.app_submit(current_setting('t.tokB'));
  if not (r -> 'errors')::text like '%exactly one control person%' then raise exception 'FAIL: control person rule not enforced: %', r; end if;
  if not (r -> 'errors')::text like '%Bob: photo ID upload is required%' then raise exception 'FAIL: 25%% owner ID rule not enforced: %', r; end if;
  perform public.app_save_owners(current_setting('t.tokB'), jsonb_build_array(
    jsonb_build_object('id', o1, 'full_name', 'Bob', 'ownership_pct', 70, 'is_control_person', true),
    jsonb_build_object('id', o2, 'full_name', 'Cara', 'ownership_pct', 40, 'is_control_person', false)));
  r := public.app_submit(current_setting('t.tokB'));
  if not (r -> 'errors')::text like '%more than 100%' then raise exception 'FAIL: >100%% not enforced: %', r; end if;
  raise notice 'PASS 9: ownership and control-person rules enforced';
end $$;

-- ================================================================ 10. admin status workflow + audit
do $$
declare admin_claims jsonb := jsonb_build_object('sub', 'aaaaaaaa-1111-1111-1111-111111111111', 'role', 'authenticated'); n bigint;
begin
  perform pg_temp.become('authenticated', admin_claims);
  perform pg_temp.expect_error(format('select public.admin_set_status(%L, ''approved'', null)', current_setting('t.appA')), 'P0001', 'approve is not a plain status change');
  perform pg_temp.expect_error(format('select public.admin_set_status(%L, ''needs_info'', '''')', current_setting('t.appA')), 'P0001', 'needs_info requires a message');
  perform public.admin_set_status(current_setting('t.appA')::uuid, 'in_review', null);
  perform public.admin_set_status(current_setting('t.appA')::uuid, 'needs_info', 'Please upload a clearer tax permit.');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  if public.app_status(current_setting('t.tokA')) ->> 'info_request' <> 'Please upload a clearer tax permit.' then
    raise exception 'FAIL: applicant cannot see info request'; end if;
  -- needs_info reopens the draft for the applicant
  perform public.app_register_document(current_setting('t.tokA'), 'requested_info', null, null,
    current_setting('t.appA') || '/clearer.pdf', 'clearer.pdf', 'application/pdf', 500);
  if not (public.app_submit(current_setting('t.tokA')) ->> 'ok')::boolean then raise exception 'FAIL: resubmit after needs_info'; end if;
  perform pg_temp.become('authenticated', admin_claims);
  perform public.admin_add_note(current_setting('t.appA')::uuid, 'Looks legit.');
  select count(*) into n from public.audit_log where entity = 'onboarding_applications' and entity_id = current_setting('t.appA');
  if n < 3 then raise exception 'FAIL: expected audit rows for status changes and note, got %', n; end if;
  perform pg_temp.become('authenticated', jsonb_build_object('sub', 'bbbbbbbb-2222-2222-2222-222222222222', 'role', 'authenticated'));
  perform pg_temp.expect_count('select count(*) from public.application_notes', 0, 'non-admin cannot read notes');
  raise notice 'PASS 10: admin workflow, applicant-visible messages, audit trail';
end $$;

-- ================================================================ 11. provisioning is idempotent
do $$
declare r1 jsonb; r2 jsonb; tenant uuid; n bigint;
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  r1 := public.onb_provision(current_setting('t.appA')::uuid, 'aaaaaaaa-1111-1111-1111-111111111111');
  r2 := public.onb_provision(current_setting('t.appA')::uuid, 'aaaaaaaa-1111-1111-1111-111111111111');  -- "clicked twice"
  tenant := (r1 ->> 'tenant_id')::uuid;
  if (r1 ->> 'already_provisioned')::boolean then raise exception 'FAIL: first run flagged as repeat'; end if;
  if not (r2 ->> 'already_provisioned')::boolean then raise exception 'FAIL: second run not flagged as repeat'; end if;
  if r2 ? 'invite_token' then raise exception 'FAIL: repeat run leaked the invite token'; end if;
  if r1 ->> 'license_key' <> r2 ->> 'license_key' or r2 ->> 'tenant_id' <> r1 ->> 'tenant_id' then raise exception 'FAIL: repeat run changed ids'; end if;
  if r1 ->> 'license_key' !~ '^RACKD-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' then raise exception 'FAIL: license key format %', r1 ->> 'license_key'; end if;

  perform pg_temp.expect_count(format('select count(*) from public.licenses where tenant_id = %L and kind = ''business''', tenant), 1, 'exactly one business license');
  perform pg_temp.expect_count(format('select count(*) from public.licenses where tenant_id = %L and plan_type = ''model_a'' and tier = ''standard'' and max_registers = 2', tenant), 1, 'plan type, tier, registers');
  perform pg_temp.expect_count(format('select count(*) from public.licenses where tenant_id = %L and features @> array[''web_store'',''rebate_reporting'',''sms_marketing'']', tenant), 1, 'plan + add-on feature flags');
  perform pg_temp.expect_count(format('select count(*) from public.locations where tenant_id = %L and is_storefront_enabled = false', tenant), 1, 'one location, storefront disabled');
  perform pg_temp.expect_count(format('select count(*) from public.business_permits where tenant_id = %L', tenant), 2, 'permits copied');
  perform pg_temp.expect_count(format('select count(*) from public.business_fee_settings where tenant_id = %L and online_fee_type = ''percent''', tenant), 1, 'fee settings copied');
  perform pg_temp.expect_count(format('select count(*) from public.owner_invites where tenant_id = %L', tenant), 1, 'exactly one owner invite');
  perform pg_temp.expect_count(format('select count(*) from public.provision_runs where application_id = %L', current_setting('t.appA')), 1, 'one provision run');
  perform pg_temp.expect_count(format('select count(*) from public.onboarding_applications where id = %L and status = ''approved'' and provisioned_tenant_id = %L', current_setting('t.appA'), tenant), 1, 'status approved');
  perform pg_temp.expect_count(format('select count(*) from public.provision_runs where application_id = %L and result::text like ''%%invite_token%%''', current_setting('t.appA')), 0, 'stored result has no raw invite token');
  perform pg_temp.expect_count(format('select count(*) from public.owner_invites where token_hash = %L', r1 ->> 'invite_token'), 0, 'invite token stored hashed only');

  -- application B is incomplete: cannot be provisioned
  perform pg_temp.expect_error(format('select public.onb_provision(%L::uuid, null)', current_setting('t.appB')), 'P0001', 'draft cannot be provisioned');

  -- invite redeems once
  perform public.onb_redeem_invite(r1 ->> 'invite_token');
  perform pg_temp.expect_error(format('select public.onb_redeem_invite(%L)', r1 ->> 'invite_token'), '28000', 'invite is single-use');
  -- activation
  if not public.onb_mark_activated(tenant) then raise exception 'FAIL: activation'; end if;
  if public.onb_mark_activated(tenant) then raise exception 'FAIL: activation should be once'; end if;
  perform set_config('t.tenantA', tenant::text, false);
  raise notice 'PASS 11: approval provisions exactly once, even when run twice';
end $$;

-- ================================================================ 12. one business cannot read another's data
do $$
declare t1 jsonb := jsonb_build_object('role', 'authenticated', 'tenant_id', '11111111-1111-1111-1111-111111111111');
begin
  perform pg_temp.become('authenticated', t1);
  perform pg_temp.expect_count('select count(*) from public.hardware_orders', 1, 'T1 sees only its own order');
  perform pg_temp.expect_count('select count(*) from public.hardware_orders where tenant_id = ''22222222-2222-2222-2222-222222222222''', 0, 'T1 cannot see T2 order');
  perform pg_temp.expect_count('select count(*) from public.hardware_orders where tenant_id is null', 0, 'T1 cannot see guest orders');
  perform pg_temp.expect_count('select count(*) from public.business_permits', 1, 'T1 sees only its own permits');
  perform pg_temp.expect_count('select count(*) from public.business_permits where tenant_id = ''22222222-2222-2222-2222-222222222222''', 0, 'T1 cannot see T2 permits');
  perform pg_temp.expect_count('select count(*) from public.business_fee_settings', 0, 'T1 has no fee row yet / cannot see others');
  perform pg_temp.expect_count('select count(*) from public.onboarding_applications', 0, 'tenant users cannot see applications');
  perform pg_temp.expect_count('select count(*) from public.audit_log', 0, 'tenant users cannot see audit log');
  perform pg_temp.expect_error('update public.hardware_orders set status = ''shipped''', '42501', 'tenant cannot modify orders');
  perform pg_temp.expect_error('update public.business_permits set expiry = current_date + 900', '42501', 'tenant cannot edit permits');

  -- the newly provisioned business sees its own fee settings and nobody else's
  perform pg_temp.become('authenticated', jsonb_build_object('role', 'authenticated', 'tenant_id', current_setting('t.tenantA')));
  perform pg_temp.expect_count('select count(*) from public.business_fee_settings', 1, 'provisioned tenant sees own fee settings');
  perform pg_temp.expect_count('select count(*) from public.business_permits', 2, 'provisioned tenant sees own permits');
  perform pg_temp.expect_count('select count(*) from public.hardware_orders', 0, 'provisioned tenant sees no foreign orders');

  perform pg_temp.become('authenticated', jsonb_build_object('sub', 'aaaaaaaa-1111-1111-1111-111111111111', 'role', 'authenticated'));
  perform pg_temp.expect_count('select count(*) from public.hardware_orders', 3, 'platform admin sees all orders');
  raise notice 'PASS 12: tenant isolation holds across orders, permits and fee settings';
end $$;

-- ================================================================ 13. config edits: admin only, audited
do $$
declare admin_claims jsonb := jsonb_build_object('sub', 'aaaaaaaa-1111-1111-1111-111111111111', 'role', 'authenticated'); n bigint; b jsonb; a jsonb;
begin
  perform pg_temp.become('authenticated', jsonb_build_object('sub', 'bbbbbbbb-2222-2222-2222-222222222222', 'role', 'authenticated'));
  perform pg_temp.expect_error('insert into public.app_config (key, value) values (''evil'', ''{}'')', '42501', 'non-admin cannot insert config (RLS)');
  update public.app_config set value = '{"type":"flat","value":1}' where key = 'online_fee';
  update public.hardware_products set price_cents = 1 where sku = 'POS-FULL';
  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count('select count(*) from public.app_config where key = ''online_fee'' and value ->> ''type'' = ''percent''', 1, 'non-admin update changed nothing');
  perform pg_temp.expect_count('select count(*) from public.hardware_products where sku = ''POS-FULL'' and price_cents = 129900', 1, 'non-admin price update changed nothing');

  perform pg_temp.become('authenticated', admin_claims);
  update public.app_config set value = '{"type":"flat","value":250,"paid_by":"customer"}' where key = 'online_fee';
  update public.hardware_products set price_cents = 119900, is_placeholder = false where sku = 'POS-FULL';
  select before, after into b, a from public.audit_log where entity = 'app_config' and entity_id = 'online_fee' order by id desc limit 1;
  if b ->> 'type' <> 'percent' or a ->> 'type' <> 'flat' then raise exception 'FAIL: config audit before/after wrong: % / %', b, a; end if;
  select before, after into b, a from public.audit_log where entity = 'hardware_products' and action = 'hardware_products.update' order by id desc limit 1;
  if (b ->> 'price_cents')::int <> 129900 or (a ->> 'price_cents')::int <> 119900 then raise exception 'FAIL: product audit wrong'; end if;
  select count(*) into n from public.audit_log where actor = 'aaaaaaaa-1111-1111-1111-111111111111';
  if n < 2 then raise exception 'FAIL: audit rows missing actor'; end if;
  raise notice 'PASS 13: only admins edit config/prices, and every edit is audit-logged with before and after';
end $$;

-- ================================================================ 14. misc: rate limit, storage bucket, magic link, email codes
do $$
declare ok1 boolean; ok2 boolean; ok3 boolean; r record; newtok text; code text; tokC text; appC uuid;
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  ok1 := public.rate_limit_hit('test:ip', 60, 2); ok2 := public.rate_limit_hit('test:ip', 60, 2); ok3 := public.rate_limit_hit('test:ip', 60, 2);
  if not (ok1 and ok2) or ok3 then raise exception 'FAIL: rate limit (% % %)', ok1, ok2, ok3; end if;

  perform pg_temp.become('postgres', null);
  perform pg_temp.expect_count('select count(*) from storage.buckets where id = ''onboarding-docs'' and public = false and file_size_limit = 10485760 and allowed_mime_types = array[''application/pdf'',''image/jpeg'',''image/png'']', 1, 'private 10MB PDF/JPG/PNG bucket');
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_count('select count(*) from storage.objects', 0, 'anon sees no storage objects');

  -- email code: wrong code fails, attempts cap, right code works
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  select resume_token, application_id into tokC, appC from public.app_create('Cara C', 'cara@test.dev', null, 'other') as t(application_id, resume_token);
  code := public.app_email_code_issue(tokC);
  perform pg_temp.expect_error(format('select public.app_email_code_issue(%L)', tokC), 'P0001', 'code re-issue is throttled');
  for i in 1..5 loop
    if public.app_email_code_verify(tokC, '000000') and code <> '000000' then raise exception 'FAIL: wrong code accepted'; end if;
  end loop;
  if public.app_email_code_verify(tokC, code) then raise exception 'FAIL: code accepted after 5 failed attempts'; end if;

  -- magic link verifies email, rotates token, is single-use; unknown email yields nothing
  select * into r from public.app_magic_issue('CARA@test.dev');
  if r.magic_token is null then raise exception 'FAIL: magic issue'; end if;
  newtok := public.app_magic_redeem(r.magic_token);
  perform pg_temp.expect_error(format('select public.app_get(%L)', tokC), '28000', 'old resume token dead after redeem');
  perform pg_temp.expect_error(format('select public.app_magic_redeem(%L)', r.magic_token), '28000', 'magic link is single-use');
  if (public.app_get(newtok) #>> '{application,email_verified_at}') is null then raise exception 'FAIL: email not verified by magic link'; end if;
  perform pg_temp.expect_count('select count(*) from public.app_magic_issue(''nobody@test.dev'')', 0, 'unknown email returns no row');
  raise notice 'PASS 14: rate limit, private bucket, email code and magic link behave';
end $$;

-- ================================================================ 15. permit reminders
do $$
declare n bigint; r record;
begin
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  -- tenant A provisioned with owner invite; its tx_ecig permit expires in 20 days -> 30-day bucket
  select count(*) into n from public.permits_due_for_notice() where tenant_id = current_setting('t.tenantA')::uuid and days_before = 30;
  if n <> 1 then raise exception 'FAIL: expected a 30-day reminder, got %', n; end if;
  select * into r from public.permits_due_for_notice() where tenant_id = current_setting('t.tenantA')::uuid limit 1;
  perform public.permit_notice_mark(r.permit_id, r.days_before, r.expiry);
  select count(*) into n from public.permits_due_for_notice() where tenant_id = current_setting('t.tenantA')::uuid;
  if n <> 0 then raise exception 'FAIL: reminder repeated after being marked sent'; end if;
  raise notice 'PASS 15: permit reminders sent once per expiry date';
end $$;

-- ================================================================ 16. agreement versions are immutable once published
do $$
declare a uuid; b uuid;
begin
  perform pg_temp.become('anon', null);
  perform pg_temp.expect_error('select public.onb_ensure_agreement(''terms_of_service'', ''v9'', ''x'')', '42501', 'anon cannot register agreements');
  perform pg_temp.become('service_role', jsonb_build_object('role', 'service_role'));
  a := public.onb_ensure_agreement('terms_of_service', 'v9', repeat('d', 64));
  b := public.onb_ensure_agreement('terms_of_service', 'v9', repeat('d', 64));
  if a <> b then raise exception 'FAIL: ensure not idempotent'; end if;
  perform pg_temp.expect_error('select public.onb_ensure_agreement(''terms_of_service'', ''v9'', repeat(''e'', 64))', 'P0001', 'changed text under same version is refused');
  raise notice 'PASS 16: agreement versions are idempotent and immutable';
end $$;

reset role;
rollback;
select 'ALL ONBOARDING RLS TESTS PASSED' as result;
