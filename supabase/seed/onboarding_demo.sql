-- DEMO DATA for onboarding, hardware orders and the /admin console.
--
-- NOT FOR PRODUCTION. Run on a development or staging Supabase project only (SQL editor, as the project
-- owner). Everything uses the reserved domain @demo.rackd.test so it can be found and removed with
-- supabase/seed/onboarding_demo_cleanup.sql. Needs migrations 081-091 applied.
--
-- It goes through the real database functions (app_create, app_save_locations, onb_provision, hw_mark_paid...),
-- so the demo rows are shaped exactly like real ones. Differences you will notice:
--   * EINs are fake ciphertext: "Reveal EIN" fails on demo rows (re-enter an EIN in the wizard to test it).
--   * Uploaded files do not exist in storage: "View file" shows an error on demo rows.
--   * Re-running while demo data exists does nothing; run the cleanup first.

do $seed$
declare
  v_tos uuid; v_mer uuid;
  a1 uuid; a2 uuid; a3 uuid; a4 uuid; a5 uuid; a6 uuid;
  r record; pid_full uuid; pid_term uuid; pid_scan uuid; o1 record; o2 record; o3 record;
  addr jsonb := '{"full_name":"Demo Shopkeeper","line1":"100 Demo Way","city":"Austin","state":"TX","zip":"78701","phone":"5125550199"}';
begin
  if exists (select 1 from public.onboarding_applications where email like '%@demo.rackd.test') then
    raise notice 'Demo data already present. Run supabase/seed/onboarding_demo_cleanup.sql first.';
    return;
  end if;
  if not exists (select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'onb_provision') then
    raise exception 'Apply migrations 081-091 first.';
  end if;

  -- own agreement version so the real wizard's versions (and their hashes) are never touched
  v_tos := public.onb_ensure_agreement('terms_of_service', 'demo-seed', repeat('d', 64));
  v_mer := public.onb_ensure_agreement('merchant_agreement', 'demo-seed', repeat('e', 64));

  create or replace function pg_temp.demo_app(
    p_full text, p_email text, p_legal text, p_plan text, p_addons text[], p_locs jsonb, p_owners jsonb, p_full_flow boolean default true)
  returns uuid language plpgsql as $f$
  declare t record; tok text; app uuid; l record; li record; o record; did uuid;
  begin
    select * into t from public.app_create(p_full, p_email, '5125550100', 'owner');
    tok := t.resume_token; app := t.application_id;
    perform public.app_save(tok, jsonb_build_object(
      'legal_name', p_legal, 'entity_type', 'llc', 'years_in_business', 3,
      'business_email', 'biz@' || split_part(p_email, '@', 1) || '.demo.rackd.test', 'business_phone', '5125550101',
      'mailing_address', jsonb_build_object('street', '100 Demo Way', 'city', 'Austin', 'state', 'TX', 'zip', '78701'),
      'location_count', greatest(1, jsonb_array_length(p_locs)), 'plan_model', p_plan, 'addons', to_jsonb(p_addons),
      'operations', jsonb_build_object('current_pos', 'Square', 'current_processor', 'Square', 'monthly_sales_range', '25k_50k',
         'card_pct', 70, 'avg_ticket', 24, 'product_mix', jsonb_build_array('vape', 'glass'), 'registers', 2, 'employees', 4),
      'hardware_selection', jsonb_build_object('mode', 'bundle', 'bundle_slug', 'full-pos-bundle'), 'current_step', 9));
    if not p_full_flow then return app; end if;

    perform public.app_set_ein(tok, 'REVNTy1TRUVELU5PVC1SRUFM', 'ZGVtby1pdg==', '0000');
    perform public.app_save_locations(tok, p_locs);
    perform public.app_save_owners(tok, p_owners);

    -- documents + links (rows only; no storage objects)
    for l in select id from public.onboarding_locations where application_id = app loop
      for li in select id, kind from public.onboarding_licenses where location_id = l.id loop
        insert into public.onboarding_documents (application_id, location_id, kind, storage_path, original_name, mime, size_bytes, scan_status)
        values (app, l.id, 'license_' || li.kind, app::text || '/demo-' || li.id::text || '.pdf', li.kind || '-permit.pdf', 'application/pdf', 123456, 'skipped')
        returning id into did;
        update public.onboarding_licenses set document_id = did where id = li.id;
      end loop;
    end loop;
    for o in select id from public.onboarding_owners where application_id = app loop
      insert into public.onboarding_documents (application_id, owner_id, kind, storage_path, original_name, mime, size_bytes, scan_status)
      values (app, o.id, 'owner_id', app::text || '/demo-id-' || o.id::text || '.jpg', 'photo-id.jpg', 'image/jpeg', 234567, 'skipped') returning id into did;
      update public.onboarding_owners set id_document_id = did where id = o.id;
    end loop;

    update public.onboarding_applications set email_verified_at = now() - interval '5 days' where id = app;
    perform public.app_record_agreements(tok, (select id from public.agreement_versions where kind = 'terms_of_service' and version = 'demo-seed'),
      (select id from public.agreement_versions where kind = 'merchant_agreement' and version = 'demo-seed'),
      p_full, false, 'sms-demo', repeat('f', 64), true, 'ack-demo', '203.0.113.50', 'demo-seed/1.0');
    return app;
  end $f$;

  create or replace function pg_temp.loc(p_name text, p_ecig_days integer, p_extra_tabc boolean default false)
  returns jsonb language sql as $f$
    select jsonb_build_object('id', gen_random_uuid(), 'name', p_name, 'street', '1 ' || p_name, 'city', 'Austin', 'state', 'TX', 'zip', '78701',
      'phone', '5125550102', 'licenses', jsonb_build_array(
        jsonb_build_object('kind', 'tx_ecig', 'number', 'EC-' || upper(substr(md5(p_name), 1, 6)), 'expiry', (current_date + p_ecig_days)::text),
        jsonb_build_object('kind', 'sales_tax', 'number', 'ST-' || upper(substr(md5(p_name), 1, 6)))
      ) || case when p_extra_tabc then jsonb_build_array(jsonb_build_object('kind', 'tabc', 'number', 'TB-9', 'expiry', (current_date + 200)::text)) else '[]'::jsonb end);
  $f$;

  create or replace function pg_temp.own(p_name text, p_pct numeric, p_ctrl boolean)
  returns jsonb language sql as $f$
    select jsonb_build_object('id', gen_random_uuid(), 'full_name', p_name, 'title', case when p_ctrl then 'Owner' else 'Partner' end,
                              'ownership_pct', p_pct, 'is_control_person', p_ctrl);
  $f$;

  -- 1. submitted: one permit expires in 12 days (red flag)
  a1 := pg_temp.demo_app('Alice Applicant', 'alice@demo.rackd.test', 'Demo Acme Vapes LLC', 'model_a', array['sms_marketing'],
         jsonb_build_array(pg_temp.loc('Main Street', 12)), jsonb_build_array(pg_temp.own('Alice Applicant', 100, true)));
  update public.onboarding_applications set status = 'submitted', submitted_at = now() - interval '2 days' where id = a1;
  perform public.onb_event(a1, 'submitted', 'applicant', true, jsonb_build_object('message', 'Application received.'));

  -- 2. in review: two locations, one permit already expired, two owners
  a2 := pg_temp.demo_app('Bob Builder', 'bob@demo.rackd.test', 'Demo Vapor Hut Inc', 'model_b', array[]::text[],
         jsonb_build_array(pg_temp.loc('Vapor Hut North', 300, true), pg_temp.loc('Vapor Hut South', -40)),
         jsonb_build_array(pg_temp.own('Bob Builder', 60, true), pg_temp.own('Betty Builder', 40, false)));
  update public.onboarding_applications set status = 'in_review', submitted_at = now() - interval '9 days', reviewed_at = now() - interval '1 day' where id = a2;
  perform public.onb_event(a2, 'submitted', 'applicant', true, jsonb_build_object('message', 'Application received.'));
  perform public.onb_event(a2, 'status_in_review', 'system', false, null);
  insert into public.application_notes (application_id, body) values (a2, 'Demo note: South location permit shows expired. Ask for the renewal.');

  -- 3. needs info
  a3 := pg_temp.demo_app('Sam Signal', 'sam@demo.rackd.test', 'Demo Smoke Signal LLC', 'model_a', array['loyalty_crm'],
         jsonb_build_array(pg_temp.loc('Signal Hill', 120)), jsonb_build_array(pg_temp.own('Sam Signal', 100, true)));
  update public.onboarding_applications set status = 'needs_info', submitted_at = now() - interval '6 days',
         info_request = 'The sales tax permit photo is cut off. Please upload a full-page scan.' where id = a3;
  perform public.onb_event(a3, 'status_needs_info', 'system', true, jsonb_build_object('message', 'The sales tax permit photo is cut off. Please upload a full-page scan.'));

  -- 4. draft (still on step 3)
  a4 := pg_temp.demo_app('Dana Draft', 'dana@demo.rackd.test', 'Demo Half Done Co', 'model_a', array[]::text[], '[]'::jsonb, '[]'::jsonb, false);
  update public.onboarding_applications set current_step = 3 where id = a4;

  -- 5. rejected
  a5 := pg_temp.demo_app('Ray Rejected', 'ray@demo.rackd.test', 'Demo Bad Permit LLC', 'model_a', array[]::text[],
         jsonb_build_array(pg_temp.loc('Nowhere Rd', 30)), jsonb_build_array(pg_temp.own('Ray Rejected', 100, true)));
  update public.onboarding_applications set status = 'rejected', submitted_at = now() - interval '14 days', reviewed_at = now() - interval '12 days',
         reject_reason = 'The e-cigarette permit number could not be verified with the state.' where id = a5;
  perform public.onb_event(a5, 'status_rejected', 'system', true, jsonb_build_object('message', 'The e-cigarette permit number could not be verified with the state.'));

  -- 6. approved and provisioned through the real provisioning function (creates a demo business + key)
  a6 := pg_temp.demo_app('Cara Cloud', 'cara@demo.rackd.test', 'Demo Cloud Nine LLC', 'model_a', array['sms_marketing', 'automated_rebates'],
         jsonb_build_array(pg_temp.loc('Cloud Plaza', 250)), jsonb_build_array(pg_temp.own('Cara Cloud', 100, true)));
  update public.onboarding_applications set status = 'submitted', submitted_at = now() - interval '20 days' where id = a6;
  perform public.onb_provision(a6, null);

  -- hardware orders (needs the placeholder catalog from migration 087)
  select id into pid_full from public.hardware_products where sku = 'POS-FULL';
  select id into pid_term from public.hardware_products where sku = 'ACC-VP100';
  select id into pid_scan from public.hardware_products where sku = 'ACC-SCAN';
  if pid_full is not null then
    -- pending
    select * into o1 from public.hw_create_order('buyer1@demo.rackd.test', a1, null, addr, 'ground', 8900, 0, 1500, 734, 11134, 'Demo: unpaid order', true, repeat('1', 63) || 'a',
      jsonb_build_array(jsonb_build_object('product_id', pid_scan, 'sku', 'ACC-SCAN', 'name', 'Bluetooth barcode scanner', 'unit_price_cents', 8900, 'quantity', 1)));
    -- paid, ready to ship
    select * into o2 from public.hw_create_order('buyer2@demo.rackd.test', a1, null, addr, 'ground', 154800, 10000, 1500, 11946, 158246, 'Demo: please call before delivery', true, repeat('2', 63) || 'b',
      jsonb_build_array(jsonb_build_object('product_id', pid_full, 'sku', 'POS-FULL', 'name', 'Full POS Station', 'unit_price_cents', 129900, 'quantity', 1),
                        jsonb_build_object('product_id', pid_term, 'sku', 'ACC-VP100', 'name', 'Payment terminal (VP100)', 'unit_price_cents', 24900, 'quantity', 1)));
    perform public.hw_set_session(o2.order_id, 'cs_demo_paid');
    perform public.hw_mark_paid(o2.order_id, 'cs_demo_paid', 'pi_demo_paid', 158246, 11946, false);
    -- shipped
    select * into o3 from public.hw_create_order('buyer3@demo.rackd.test', null, null, addr, 'ground', 8900, 0, 1500, 734, 11134, null, true, repeat('3', 63) || 'c',
      jsonb_build_array(jsonb_build_object('product_id', pid_scan, 'sku', 'ACC-SCAN', 'name', 'Bluetooth barcode scanner', 'unit_price_cents', 8900, 'quantity', 1)));
    perform public.hw_set_session(o3.order_id, 'cs_demo_shipped');
    perform public.hw_mark_paid(o3.order_id, 'cs_demo_shipped', 'pi_demo_shipped', 11134, 734, false);
    perform public.hw_admin_transition(o3.order_id, 'shipped', 'UPS', '1ZDEMO0000000001', null, null);
  else
    raise notice 'Hardware catalog not found (migration 087); skipped demo hardware orders.';
  end if;

  raise notice 'Demo data created: 6 applications (submitted, in review, needs info, draft, rejected, approved) and 3 hardware orders.';
end
$seed$;
