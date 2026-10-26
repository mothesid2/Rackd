-- 082: onboarding application tables. Additive. Reverse with supabase/down/082_down.sql.
-- Access model: anon and authenticated get NO direct table access except platform admins (select).
-- Applicants work through token-checked SECURITY DEFINER functions (083/085), called only by the
-- server (service_role) after Turnstile + rate limiting.
-- Never stored: SSN, DOB, bank numbers, card data. EIN only as AES-GCM ciphertext.

create table if not exists public.onboarding_applications (
  id                     uuid primary key default gen_random_uuid(),
  status                 text not null default 'draft'
    check (status in ('draft','submitted','in_review','needs_info','approved','rejected','activated')),
  -- capability tokens: only SHA-256 hashes are stored
  resume_token_hash      text not null unique,
  magic_token_hash       text unique,
  magic_expires_at       timestamptz,
  email_code_hash        text,
  email_code_expires_at  timestamptz,
  email_code_attempts    integer not null default 0,
  email_verified_at      timestamptz,
  -- step 1
  full_name              text not null,
  email                  text not null,
  phone                  text,
  contact_role           text check (contact_role in ('owner','manager','other')),
  -- step 2
  legal_name             text,
  dba                    text,
  entity_type            text check (entity_type in ('llc','corporation','sole_proprietor','partnership')),
  ein_ciphertext         text,   -- base64 AES-256-GCM (app-level, key from env)
  ein_iv                 text,
  ein_last4              text check (ein_last4 is null or ein_last4 ~ '^[0-9]{4}$'),
  years_in_business      numeric(5,1),
  business_email         text,
  business_phone         text,
  website                text,
  mailing_address        jsonb,
  location_count         integer check (location_count is null or location_count between 1 and 500),
  -- step 5-7
  operations             jsonb not null default '{}'::jsonb,
  plan_model             text check (plan_model in ('model_a','model_b')),
  addons                 text[] not null default '{}',
  hardware_selection     jsonb,
  -- step 8
  compliance_ack_at      timestamptz,
  compliance_ack_version text,
  -- processor KYC placeholder (PAYMENT_PROCESSOR_CONNECTED=false): no DOB/SSN collected here
  kyc_status             text not null default 'not_started' check (kyc_status in ('not_started','pending','complete')),
  -- workflow
  current_step           integer not null default 1 check (current_step between 1 and 9),
  info_request           text,
  reject_reason          text,
  submitted_at           timestamptz,
  reviewed_by            uuid,
  reviewed_at            timestamptz,
  provisioned_tenant_id  uuid,
  created_ip_hash        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- belt and braces: a raw EIN can never land in the ciphertext column
  constraint ein_not_plaintext check (ein_ciphertext is null or ein_ciphertext !~ '^[0-9]{2}-?[0-9]{7}$')
);
create index if not exists idx_onb_app_email  on public.onboarding_applications (lower(email));
create index if not exists idx_onb_app_status on public.onboarding_applications (status, submitted_at desc);

create table if not exists public.onboarding_locations (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.onboarding_applications(id) on delete cascade,
  name           text not null,
  street         text,
  city           text,
  state          text,
  zip            text,
  phone          text,
  hours          jsonb not null default '{}'::jsonb,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_onb_loc_app on public.onboarding_locations (application_id);

create table if not exists public.onboarding_owners (
  id               uuid primary key default gen_random_uuid(),
  application_id   uuid not null references public.onboarding_applications(id) on delete cascade,
  full_name        text not null,
  title            text,
  ownership_pct    numeric(5,2) not null check (ownership_pct >= 0 and ownership_pct <= 100),
  is_control_person boolean not null default false,
  id_document_id   uuid,
  created_at       timestamptz not null default now()
);
create index if not exists idx_onb_owner_app on public.onboarding_owners (application_id);

create table if not exists public.onboarding_documents (
  id                 uuid primary key default gen_random_uuid(),
  application_id     uuid not null references public.onboarding_applications(id) on delete cascade,
  location_id        uuid references public.onboarding_locations(id) on delete cascade,
  owner_id           uuid references public.onboarding_owners(id) on delete cascade,
  kind               text not null,
  storage_path       text not null unique,
  original_name      text,
  mime               text not null check (mime in ('application/pdf','image/jpeg','image/png')),
  size_bytes         integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  scan_status        text not null default 'pending' check (scan_status in ('pending','clean','infected','skipped')),
  requested_by_admin boolean not null default false,
  uploaded_at        timestamptz not null default now()
);
create index if not exists idx_onb_doc_app on public.onboarding_documents (application_id);

alter table public.onboarding_owners
  drop constraint if exists onboarding_owners_id_document_fk;
alter table public.onboarding_owners
  add constraint onboarding_owners_id_document_fk
  foreign key (id_document_id) references public.onboarding_documents(id) on delete set null;

create table if not exists public.onboarding_licenses (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.onboarding_applications(id) on delete cascade,
  location_id    uuid not null references public.onboarding_locations(id) on delete cascade,
  kind           text not null check (kind in ('tx_ecig','tobacco','sales_tax','tabc')),
  number         text,
  expiry         date,
  document_id    uuid references public.onboarding_documents(id) on delete set null,
  unique (location_id, kind)
);
create index if not exists idx_onb_lic_app on public.onboarding_licenses (application_id);

create table if not exists public.application_events (
  id                    bigint generated always as identity primary key,
  application_id        uuid not null references public.onboarding_applications(id) on delete cascade,
  type                  text not null,
  actor                 text not null default 'system',   -- applicant | admin:<uuid> | system
  visible_to_applicant  boolean not null default false,
  detail                jsonb,
  created_at            timestamptz not null default now()
);
create index if not exists idx_app_events_app on public.application_events (application_id, created_at);

create table if not exists public.application_notes (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.onboarding_applications(id) on delete cascade,
  author         uuid,
  body           text not null,
  created_at     timestamptz not null default now()
);

create table if not exists public.agreement_versions (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('terms_of_service','merchant_agreement')),
  version      text not null,
  body_sha256  text not null,
  body_url     text,
  effective_at timestamptz not null default now(),
  unique (kind, version)
);

create table if not exists public.agreement_signatures (
  id                   uuid primary key default gen_random_uuid(),
  application_id       uuid not null references public.onboarding_applications(id) on delete cascade,
  agreement_version_id uuid not null references public.agreement_versions(id),
  typed_name           text not null,
  signed_on            date not null,
  signed_at            timestamptz not null default now(),
  ip                   text,
  user_agent           text,
  unique (application_id, agreement_version_id)
);

-- Append-only record of SMS consent decisions (separate from agreements).
create table if not exists public.sms_consents (
  id                   uuid primary key default gen_random_uuid(),
  application_id       uuid not null references public.onboarding_applications(id) on delete cascade,
  consented            boolean not null,
  consent_text_version text not null,
  consent_text_sha256  text not null,
  ip                   text,
  user_agent           text,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------- touch + RLS
create or replace function public.onb_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists trg_onb_app_touch on public.onboarding_applications;
create trigger trg_onb_app_touch before update on public.onboarding_applications
  for each row execute function public.onb_touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array[
    'onboarding_applications','onboarding_locations','onboarding_owners','onboarding_documents',
    'onboarding_licenses','application_events','application_notes','agreement_versions',
    'agreement_signatures','sms_consents']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_admin', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_platform_admin())',
      t || '_select_admin', t);
  end loop;
end $$;

-- Agreement versions are public text; anon may read which versions are current.
grant select on public.agreement_versions to anon;
drop policy if exists agreement_versions_select_public on public.agreement_versions;
create policy agreement_versions_select_public on public.agreement_versions
  for select to anon, authenticated using (true);

-- The ciphertext columns are never exposed to any client role, admin included: decryption
-- happens only server-side with the service role.
-- (a column revoke is a no-op after a table-level grant, so drop the table grant and re-grant by column list)
revoke select on public.onboarding_applications from authenticated;
grant select (
  id, status, magic_expires_at, email_verified_at, full_name, email, phone, contact_role, legal_name, dba,
  entity_type, ein_last4, years_in_business, business_email, business_phone, website, mailing_address,
  location_count, operations, plan_model, addons, hardware_selection, compliance_ack_at,
  compliance_ack_version, kyc_status, current_step, info_request, reject_reason, submitted_at,
  reviewed_by, reviewed_at, provisioned_tenant_id, created_at, updated_at
) on public.onboarding_applications to authenticated;
