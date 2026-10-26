-- 085: onboarding RPCs. Reverse with supabase/down/085_down.sql.
--
-- Applicant functions are SECURITY DEFINER and gated by a capability token (the resume token);
-- only its SHA-256 is stored. They are executable by service_role ONLY: the Pages Function
-- verifies Turnstile and rate-limits first, so a bot cannot reach them by calling Supabase
-- directly with the public anon key. Anonymous users therefore can only create/update their own
-- draft, and only by presenting its token; they can read nothing else.
--
-- EIN never passes through SQL in plaintext: app_set_ein receives ciphertext produced server-side.

-- ---------------------------------------------------------------- helpers
create or replace function public.onb_hash(p text)
returns text
language sql immutable
set search_path = public, extensions
as $$ select encode(extensions.digest(p, 'sha256'), 'hex'); $$;

create or replace function public.onb_app_for_token(p_token text, p_editable boolean default false)
returns uuid
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare v_id uuid;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'invalid_token' using errcode = '28000';
  end if;
  select id into v_id from public.onboarding_applications
   where resume_token_hash = public.onb_hash(p_token)
     and (not p_editable or status in ('draft', 'needs_info'));
  if v_id is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;
  return v_id;
end;
$$;

create or replace function public.onb_event(p_app uuid, p_type text, p_actor text, p_visible boolean, p_detail jsonb)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.application_events (application_id, type, actor, visible_to_applicant, detail)
  values (p_app, p_type, p_actor, p_visible, p_detail);
$$;

-- ---------------------------------------------------------------- create / read
create or replace function public.app_create(
  p_full_name text, p_email text, p_phone text, p_role text, p_ip_hash text default null)
returns table (application_id uuid, resume_token text)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  if coalesce(trim(p_full_name), '') = '' then raise exception 'full_name_required'; end if;
  if p_email is null or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email_invalid'; end if;
  insert into public.onboarding_applications
    (resume_token_hash, full_name, email, phone, contact_role, created_ip_hash)
  values
    (public.onb_hash(v_token), trim(p_full_name), lower(trim(p_email)), nullif(trim(p_phone), ''),
     nullif(p_role, ''), p_ip_hash)
  returning id into v_id;
  perform public.onb_event(v_id, 'created', 'applicant', false, null);
  return query select v_id, v_token;
end;
$$;

create or replace function public.app_get(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_id uuid := public.onb_app_for_token(p_token);
  a public.onboarding_applications;
begin
  select * into a from public.onboarding_applications where id = v_id;
  return jsonb_build_object(
    'application',
      (to_jsonb(a) - array['resume_token_hash','magic_token_hash','magic_expires_at','email_code_hash',
                           'email_code_expires_at','email_code_attempts','ein_ciphertext','ein_iv','created_ip_hash'])
      || jsonb_build_object('ein_set', a.ein_ciphertext is not null),
    'locations', coalesce((
      select jsonb_agg(to_jsonb(l) || jsonb_build_object('licenses', coalesce((
          select jsonb_agg(to_jsonb(x)) from public.onboarding_licenses x where x.location_id = l.id), '[]'::jsonb))
        order by l.sort_order, l.created_at)
      from public.onboarding_locations l where l.application_id = v_id), '[]'::jsonb),
    'owners', coalesce((
      select jsonb_agg(to_jsonb(o) order by o.created_at) from public.onboarding_owners o
       where o.application_id = v_id), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'location_id', d.location_id,
               'owner_id', d.owner_id, 'original_name', d.original_name, 'mime', d.mime,
               'size_bytes', d.size_bytes, 'scan_status', d.scan_status,
               'requested_by_admin', d.requested_by_admin, 'uploaded_at', d.uploaded_at)
             order by d.uploaded_at)
      from public.onboarding_documents d where d.application_id = v_id), '[]'::jsonb),
    'signatures', coalesce((
      select jsonb_agg(jsonb_build_object('agreement_version_id', s.agreement_version_id,
               'kind', v.kind, 'version', v.version, 'typed_name', s.typed_name, 'signed_at', s.signed_at))
      from public.agreement_signatures s join public.agreement_versions v on v.id = s.agreement_version_id
      where s.application_id = v_id), '[]'::jsonb),
    'sms_consent', (
      select jsonb_build_object('consented', c.consented, 'text_version', c.consent_text_version,
                                'created_at', c.created_at)
      from public.sms_consents c where c.application_id = v_id order by c.created_at desc limit 1)
  );
end;
$$;

create or replace function public.app_status(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_id uuid := public.onb_app_for_token(p_token);
  a public.onboarding_applications;
begin
  select * into a from public.onboarding_applications where id = v_id;
  return jsonb_build_object(
    'status', a.status, 'full_name', a.full_name, 'legal_name', a.legal_name,
    'submitted_at', a.submitted_at, 'info_request', case when a.status = 'needs_info' then a.info_request end,
    'reject_reason', case when a.status = 'rejected' then a.reject_reason end,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('type', e.type, 'at', e.created_at, 'message', e.detail ->> 'message')
                       order by e.created_at)
      from public.application_events e where e.application_id = v_id and e.visible_to_applicant), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- drafts
create or replace function public.app_save(p_token text, p_patch jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_id uuid := public.onb_app_for_token(p_token, true);
begin
  update public.onboarding_applications set
    full_name         = case when p_patch ? 'full_name' then coalesce(nullif(trim(p_patch ->> 'full_name'), ''), full_name) else full_name end,
    phone             = case when p_patch ? 'phone' then nullif(trim(p_patch ->> 'phone'), '') else phone end,
    contact_role      = case when p_patch ? 'contact_role' then nullif(p_patch ->> 'contact_role', '') else contact_role end,
    legal_name        = case when p_patch ? 'legal_name' then nullif(trim(p_patch ->> 'legal_name'), '') else legal_name end,
    dba               = case when p_patch ? 'dba' then nullif(trim(p_patch ->> 'dba'), '') else dba end,
    entity_type       = case when p_patch ? 'entity_type' then nullif(p_patch ->> 'entity_type', '') else entity_type end,
    years_in_business = case when p_patch ? 'years_in_business' then nullif(p_patch ->> 'years_in_business', '')::numeric else years_in_business end,
    business_email    = case when p_patch ? 'business_email' then nullif(trim(p_patch ->> 'business_email'), '') else business_email end,
    business_phone    = case when p_patch ? 'business_phone' then nullif(trim(p_patch ->> 'business_phone'), '') else business_phone end,
    website           = case when p_patch ? 'website' then nullif(trim(p_patch ->> 'website'), '') else website end,
    mailing_address   = case when p_patch ? 'mailing_address' then p_patch -> 'mailing_address' else mailing_address end,
    location_count    = case when p_patch ? 'location_count' then nullif(p_patch ->> 'location_count', '')::integer else location_count end,
    operations        = case when p_patch ? 'operations' then coalesce(p_patch -> 'operations', '{}'::jsonb) else operations end,
    plan_model        = case when p_patch ? 'plan_model' then nullif(p_patch ->> 'plan_model', '') else plan_model end,
    addons            = case when p_patch ? 'addons' then array(select jsonb_array_elements_text(p_patch -> 'addons')) else addons end,
    hardware_selection= case when p_patch ? 'hardware_selection' then p_patch -> 'hardware_selection' else hardware_selection end,
    current_step      = case when p_patch ? 'current_step' then least(9, greatest(1, (p_patch ->> 'current_step')::integer)) else current_step end
  where id = v_id;
end;
$$;

create or replace function public.app_set_ein(p_token text, p_ciphertext text, p_iv text, p_last4 text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_id uuid := public.onb_app_for_token(p_token, true);
begin
  update public.onboarding_applications
     set ein_ciphertext = p_ciphertext, ein_iv = p_iv, ein_last4 = p_last4
   where id = v_id;
end;
$$;

create or replace function public.app_save_locations(p_token text, p_locations jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_app uuid := public.onb_app_for_token(p_token, true);
  loc jsonb; lic jsonb; ord integer := 0;
  v_loc uuid; v_doc uuid;
  v_loc_ids uuid[] := '{}'; v_kinds text[];
begin
  if jsonb_typeof(p_locations) <> 'array' or jsonb_array_length(p_locations) > 100 then
    raise exception 'locations_invalid';
  end if;
  for loc in select * from jsonb_array_elements(p_locations) loop
    ord := ord + 1;
    v_loc := (loc ->> 'id')::uuid;
    insert into public.onboarding_locations (id, application_id, name, street, city, state, zip, phone, hours, sort_order)
    values (v_loc, v_app, coalesce(nullif(trim(loc ->> 'name'), ''), 'Location ' || ord),
            nullif(trim(loc ->> 'street'), ''), nullif(trim(loc ->> 'city'), ''), nullif(trim(loc ->> 'state'), ''),
            nullif(trim(loc ->> 'zip'), ''), nullif(trim(loc ->> 'phone'), ''),
            coalesce(loc -> 'hours', '{}'::jsonb), ord)
    on conflict (id) do update set
      name = excluded.name, street = excluded.street, city = excluded.city, state = excluded.state,
      zip = excluded.zip, phone = excluded.phone, hours = excluded.hours, sort_order = excluded.sort_order
      where public.onboarding_locations.application_id = v_app;
    if not exists (select 1 from public.onboarding_locations where id = v_loc and application_id = v_app) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_loc_ids := v_loc_ids || v_loc;

    v_kinds := '{}';
    for lic in select * from jsonb_array_elements(coalesce(loc -> 'licenses', '[]'::jsonb)) loop
      v_doc := nullif(lic ->> 'document_id', '')::uuid;
      if v_doc is not null and not exists (
           select 1 from public.onboarding_documents where id = v_doc and application_id = v_app) then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      insert into public.onboarding_licenses (application_id, location_id, kind, number, expiry, document_id)
      values (v_app, v_loc, lic ->> 'kind', nullif(trim(lic ->> 'number'), ''),
              nullif(lic ->> 'expiry', '')::date, v_doc)
      on conflict (location_id, kind) do update set
        number = excluded.number, expiry = excluded.expiry, document_id = excluded.document_id;
      v_kinds := v_kinds || (lic ->> 'kind');
    end loop;
    delete from public.onboarding_licenses where location_id = v_loc and kind <> all (v_kinds);
  end loop;
  delete from public.onboarding_locations where application_id = v_app and id <> all (v_loc_ids);
end;
$$;

create or replace function public.app_save_owners(p_token text, p_owners jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_app uuid := public.onb_app_for_token(p_token, true);
  o jsonb; v_id uuid; v_doc uuid; v_ids uuid[] := '{}';
begin
  if jsonb_typeof(p_owners) <> 'array' or jsonb_array_length(p_owners) > 50 then
    raise exception 'owners_invalid';
  end if;
  for o in select * from jsonb_array_elements(p_owners) loop
    v_id := (o ->> 'id')::uuid;
    v_doc := nullif(o ->> 'id_document_id', '')::uuid;
    if v_doc is not null and not exists (
         select 1 from public.onboarding_documents where id = v_doc and application_id = v_app) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    insert into public.onboarding_owners (id, application_id, full_name, title, ownership_pct, is_control_person, id_document_id)
    values (v_id, v_app, coalesce(nullif(trim(o ->> 'full_name'), ''), 'Owner'), nullif(trim(o ->> 'title'), ''),
            coalesce(nullif(o ->> 'ownership_pct', '')::numeric, 0),
            coalesce((o ->> 'is_control_person')::boolean, false), v_doc)
    on conflict (id) do update set
      full_name = excluded.full_name, title = excluded.title, ownership_pct = excluded.ownership_pct,
      is_control_person = excluded.is_control_person, id_document_id = excluded.id_document_id
      where public.onboarding_owners.application_id = v_app;
    if not exists (select 1 from public.onboarding_owners where id = v_id and application_id = v_app) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_ids := v_ids || v_id;
  end loop;
  delete from public.onboarding_owners where application_id = v_app and id <> all (v_ids);
end;
$$;

-- Registers an uploaded file (already placed in the private bucket by a signed upload URL).
-- Also allowed while needs_info so the applicant can supply requested documents.
create or replace function public.app_register_document(
  p_token text, p_kind text, p_location_id uuid, p_owner_id uuid,
  p_storage_path text, p_original_name text, p_mime text, p_size integer)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_app uuid := public.onb_app_for_token(p_token, true);
  v_id uuid;
  v_requested boolean;
begin
  if p_kind not in ('license_tx_ecig','license_tobacco','license_sales_tax','license_tabc','owner_id','requested_info') then
    raise exception 'document_kind_invalid';
  end if;
  if p_storage_path not like v_app::text || '/%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_location_id is not null and not exists (
       select 1 from public.onboarding_locations where id = p_location_id and application_id = v_app) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_owner_id is not null and not exists (
       select 1 from public.onboarding_owners where id = p_owner_id and application_id = v_app) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select status = 'needs_info' into v_requested from public.onboarding_applications where id = v_app;
  insert into public.onboarding_documents
    (application_id, location_id, owner_id, kind, storage_path, original_name, mime, size_bytes, requested_by_admin)
  values (v_app, p_location_id, p_owner_id, p_kind, p_storage_path, left(p_original_name, 200), p_mime, p_size,
          coalesce(v_requested, false) and p_kind = 'requested_info')
  returning id into v_id;
  if p_kind = 'owner_id' and p_owner_id is not null then
    update public.onboarding_owners set id_document_id = v_id where id = p_owner_id;
  end if;
  perform public.onb_event(v_app, 'document_uploaded', 'applicant', false, jsonb_build_object('kind', p_kind, 'document_id', v_id));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- email verification / magic link
create or replace function public.app_email_code_issue(p_token text)
returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := public.onb_app_for_token(p_token);
  v_code text;
  v_exp timestamptz;
begin
  select email_code_expires_at into v_exp from public.onboarding_applications where id = v_id;
  if v_exp is not null and v_exp > now() + interval '14 minutes' then
    raise exception 'too_soon';
  end if;
  v_code := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  update public.onboarding_applications
     set email_code_hash = public.onb_hash(v_id::text || v_code),
         email_code_expires_at = now() + interval '15 minutes', email_code_attempts = 0
   where id = v_id;
  return v_code;
end;
$$;

create or replace function public.app_email_code_verify(p_token text, p_code text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid := public.onb_app_for_token(p_token);
  a public.onboarding_applications;
begin
  select * into a from public.onboarding_applications where id = v_id for update;
  if a.email_verified_at is not null then return true; end if;
  if a.email_code_hash is null or a.email_code_expires_at < now() or a.email_code_attempts >= 5 then
    return false;
  end if;
  if a.email_code_hash = public.onb_hash(v_id::text || coalesce(p_code, '')) then
    update public.onboarding_applications
       set email_verified_at = now(), email_code_hash = null where id = v_id;
    perform public.onb_event(v_id, 'email_verified', 'applicant', false, jsonb_build_object('via', 'code'));
    return true;
  end if;
  update public.onboarding_applications set email_code_attempts = email_code_attempts + 1 where id = v_id;
  return false;
end;
$$;

-- Issue a resume link for the newest open application of this email. Returns zero rows when there
-- is none; callers must respond identically either way so emails cannot be enumerated.
create or replace function public.app_magic_issue(p_email text)
returns table (application_id uuid, full_name text, email text, magic_token text)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  a public.onboarding_applications;
begin
  select * into a from public.onboarding_applications
   where lower(onboarding_applications.email) = lower(trim(p_email))
     and status in ('draft', 'needs_info', 'submitted', 'in_review', 'approved', 'activated')
   order by created_at desc limit 1;
  if a.id is null then return; end if;
  update public.onboarding_applications
     set magic_token_hash = public.onb_hash(v_token), magic_expires_at = now() + interval '7 days'
   where id = a.id;
  return query select a.id, a.full_name, a.email, v_token;
end;
$$;

-- Redeeming proves mailbox ownership: marks the email verified and rotates the resume token.
create or replace function public.app_magic_redeem(p_magic text)
returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_new text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  if p_magic is null or length(p_magic) < 32 then raise exception 'invalid_token' using errcode = '28000'; end if;
  update public.onboarding_applications
     set resume_token_hash = public.onb_hash(v_new), magic_token_hash = null, magic_expires_at = null,
         email_verified_at = coalesce(email_verified_at, now())
   where magic_token_hash = public.onb_hash(p_magic) and magic_expires_at > now()
   returning id into v_id;
  if v_id is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  perform public.onb_event(v_id, 'resumed', 'applicant', false, jsonb_build_object('via', 'magic_link'));
  return v_new;
end;
$$;

-- ---------------------------------------------------------------- agreements + submit
create or replace function public.app_record_agreements(
  p_token text, p_tos_version uuid, p_merchant_version uuid, p_typed_name text,
  p_sms_consented boolean, p_sms_text_version text, p_sms_text_sha256 text,
  p_compliance_ack boolean, p_compliance_version text, p_ip text, p_user_agent text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_app uuid := public.onb_app_for_token(p_token, true);
  v_vid uuid;
  v_last record;
begin
  if coalesce(trim(p_typed_name), '') = '' then raise exception 'typed_name_required'; end if;
  if not coalesce(p_compliance_ack, false) then raise exception 'compliance_ack_required'; end if;
  if not exists (select 1 from public.agreement_versions where id = p_tos_version and kind = 'terms_of_service')
     or not exists (select 1 from public.agreement_versions where id = p_merchant_version and kind = 'merchant_agreement') then
    raise exception 'agreement_version_invalid';
  end if;
  foreach v_vid in array array[p_tos_version, p_merchant_version] loop
    insert into public.agreement_signatures (application_id, agreement_version_id, typed_name, signed_on, ip, user_agent)
    values (v_app, v_vid, trim(p_typed_name), current_date, p_ip, left(p_user_agent, 400))
    on conflict (application_id, agreement_version_id) do update set
      typed_name = excluded.typed_name, signed_on = excluded.signed_on, signed_at = now(),
      ip = excluded.ip, user_agent = excluded.user_agent;
  end loop;
  update public.onboarding_applications
     set compliance_ack_at = now(), compliance_ack_version = p_compliance_version where id = v_app;

  -- SMS consent: separate, opt-in, append-only; record only when the decision or text version changes.
  select consented, consent_text_version into v_last
    from public.sms_consents where application_id = v_app order by created_at desc limit 1;
  if v_last is null or v_last.consented is distinct from coalesce(p_sms_consented, false)
     or v_last.consent_text_version is distinct from p_sms_text_version then
    insert into public.sms_consents (application_id, consented, consent_text_version, consent_text_sha256, ip, user_agent)
    values (v_app, coalesce(p_sms_consented, false), p_sms_text_version, p_sms_text_sha256, p_ip, left(p_user_agent, 400));
  end if;
end;
$$;

-- Returns {ok:true} or {ok:false, errors:[...]} so the UI can show every problem at once.
create or replace function public.app_submit(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_app uuid := public.onb_app_for_token(p_token, true);
  a public.onboarding_applications;
  errs text[] := '{}';
  l record; o record;
  v_ctrl integer;
  v_sum numeric;
  v_resub boolean;
begin
  select * into a from public.onboarding_applications where id = v_app for update;
  if a.email_verified_at is null then errs := errs || 'Verify your email address.'::text; end if;
  if a.legal_name is null or a.entity_type is null or a.mailing_address is null then
    errs := errs || 'Complete the business details.'::text;
  end if;
  if a.ein_ciphertext is null then errs := errs || 'Enter the business EIN.'::text; end if;
  if a.plan_model is null then errs := errs || 'Choose a plan.'::text; end if;
  if a.compliance_ack_at is null then errs := errs || 'Acknowledge the 21+ and compliance statement.'::text; end if;
  if (select count(distinct v.kind) from public.agreement_signatures s
        join public.agreement_versions v on v.id = s.agreement_version_id
       where s.application_id = v_app) < 2 then
    errs := errs || 'Sign both agreements.'::text;
  end if;

  if not exists (select 1 from public.onboarding_locations where application_id = v_app) then
    errs := errs || 'Add at least one location.'::text;
  end if;
  for l in select * from public.onboarding_locations where application_id = v_app loop
    if l.street is null or l.city is null or l.state is null or l.zip is null then
      errs := errs || format('%s: complete the address.', l.name);
    end if;
    if not exists (select 1 from public.onboarding_licenses
                    where location_id = l.id and kind = 'tx_ecig' and number is not null and expiry is not null and document_id is not null) then
      errs := errs || format('%s: Texas E-Cigarette Retailer Permit number, expiry and upload are required.', l.name);
    end if;
    if not exists (select 1 from public.onboarding_licenses
                    where location_id = l.id and kind = 'sales_tax' and number is not null and document_id is not null) then
      errs := errs || format('%s: sales tax permit number and upload are required.', l.name);
    end if;
    if exists (select 1 from public.onboarding_licenses where location_id = l.id and expiry is not null and expiry < current_date) then
      errs := errs || format('%s: a permit is expired. Permits must be current.', l.name);
    end if;
  end loop;

  if not exists (select 1 from public.onboarding_owners where application_id = v_app) then
    errs := errs || 'Add at least one owner.'::text;
  else
    select count(*) filter (where is_control_person), coalesce(sum(ownership_pct), 0)
      into v_ctrl, v_sum from public.onboarding_owners where application_id = v_app;
    if v_ctrl <> 1 then errs := errs || 'Designate exactly one control person.'::text; end if;
    if v_sum > 100 then errs := errs || 'Ownership percentages add up to more than 100.'::text; end if;
    for o in select * from public.onboarding_owners
              where application_id = v_app and (ownership_pct >= 25 or is_control_person) and id_document_id is null loop
      errs := errs || format('%s: photo ID upload is required.', o.full_name);
    end loop;
  end if;

  if array_length(errs, 1) is not null then
    return jsonb_build_object('ok', false, 'errors', to_jsonb(errs));
  end if;

  v_resub := a.status = 'needs_info';
  update public.onboarding_applications
     set status = 'submitted', submitted_at = coalesce(submitted_at, now()), info_request = null
   where id = v_app;
  perform public.onb_event(v_app, case when v_resub then 'info_provided' else 'submitted' end, 'applicant', true,
    jsonb_build_object('message', case when v_resub then 'You sent the requested information.' else 'Application received.' end));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------- admin (platform_admins only)
create or replace function public.admin_set_status(p_app uuid, p_status text, p_message text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare a public.onboarding_applications;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into a from public.onboarding_applications where id = p_app for update;
  if a.id is null then raise exception 'not_found'; end if;
  if not ((a.status = 'submitted'  and p_status in ('in_review', 'needs_info', 'rejected'))
       or (a.status = 'in_review'  and p_status in ('needs_info', 'rejected'))
       or (a.status = 'needs_info' and p_status in ('in_review', 'rejected'))) then
    raise exception 'invalid_transition: % -> %', a.status, p_status;
  end if;
  if p_status in ('needs_info', 'rejected') and coalesce(trim(p_message), '') = '' then
    raise exception 'message_required';
  end if;
  update public.onboarding_applications set
    status = p_status,
    info_request  = case when p_status = 'needs_info' then trim(p_message) else info_request end,
    reject_reason = case when p_status = 'rejected'   then trim(p_message) else reject_reason end,
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_app;
  perform public.onb_event(p_app, 'status_' || p_status, 'admin:' || auth.uid()::text,
    p_status in ('needs_info', 'rejected'), jsonb_build_object('message', p_message, 'from', a.status));
  perform public.write_audit('application.status', 'onboarding_applications', p_app::text,
    jsonb_build_object('status', a.status), jsonb_build_object('status', p_status, 'message', p_message));
end;
$$;

create or replace function public.admin_add_note(p_app uuid, p_body text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'note_empty'; end if;
  insert into public.application_notes (application_id, author, body) values (p_app, auth.uid(), trim(p_body));
  perform public.onb_event(p_app, 'note', 'admin:' || auth.uid()::text, false, null);
  perform public.write_audit('application.note', 'onboarding_applications', p_app::text, null, jsonb_build_object('body', trim(p_body)));
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function
  public.onb_hash(text), public.onb_app_for_token(text, boolean),
  public.onb_event(uuid, text, text, boolean, jsonb),
  public.app_create(text, text, text, text, text), public.app_get(text), public.app_status(text),
  public.app_save(text, jsonb), public.app_set_ein(text, text, text, text),
  public.app_save_locations(text, jsonb), public.app_save_owners(text, jsonb),
  public.app_register_document(text, text, uuid, uuid, text, text, text, integer),
  public.app_email_code_issue(text), public.app_email_code_verify(text, text),
  public.app_magic_issue(text), public.app_magic_redeem(text),
  public.app_record_agreements(text, uuid, uuid, text, boolean, text, text, boolean, text, text, text),
  public.app_submit(text), public.admin_set_status(uuid, text, text), public.admin_add_note(uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.onb_hash(text), public.onb_app_for_token(text, boolean),
  public.onb_event(uuid, text, text, boolean, jsonb),
  public.app_create(text, text, text, text, text), public.app_get(text), public.app_status(text),
  public.app_save(text, jsonb), public.app_set_ein(text, text, text, text),
  public.app_save_locations(text, jsonb), public.app_save_owners(text, jsonb),
  public.app_register_document(text, text, uuid, uuid, text, text, text, integer),
  public.app_email_code_issue(text), public.app_email_code_verify(text, text),
  public.app_magic_issue(text), public.app_magic_redeem(text),
  public.app_record_agreements(text, uuid, uuid, text, boolean, text, text, boolean, text, text, text),
  public.app_submit(text)
  to service_role;

-- Admin RPCs are called with the admin's own JWT; they re-check is_platform_admin() internally.
grant execute on function public.admin_set_status(uuid, text, text), public.admin_add_note(uuid, text)
  to authenticated, service_role;
