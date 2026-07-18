-- 025_rebates.sql
-- Manufacturer rebate / scan-data programs (Altria, RJR, ITG) — cloud side.
--
-- Config (manufacturers, rebate_rules) is TENANT-scoped and read by every register
-- + manager; rules are authored from the POS manager screen (writes scoped to the
-- tenant). Audit (applied_rebates, missed_rebates) is LOCATION+REGISTER scoped,
-- insert-only, and feeds the weekly report. SFTP credentials and the submission
-- log are cloud-only: credentials are service-role-only (secret in Supabase Vault);
-- the submission log is written by the scheduled job and read by the dashboard.

-- ── config: manufacturers (owner-authored → pulled down) ────────────────────
create table if not exists public.manufacturers_cloud (
  uid                 uuid not null,
  tenant_id           uuid not null,
  name                text not null,
  parent_company_code text,                 -- 'PM' | 'RJRT' | 'ITG'
  batch_end_dow       integer,              -- 0=Sun … 6=Sat
  due_dow             integer,
  due_offset_weeks    integer not null default 1,
  timezone            text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, uid)
);
create index if not exists idx_manufacturers_cloud_upd on public.manufacturers_cloud (tenant_id, updated_at);
alter table public.manufacturers_cloud enable row level security;
-- Read by anyone in the tenant (registers need it offline; managers for the dashboard).
drop policy if exists "manufacturers_cloud_select" on public.manufacturers_cloud;
create policy "manufacturers_cloud_select" on public.manufacturers_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());
-- No client write policy: manufacturers are provisioned by the owner console (service role).
create trigger trg_manufacturers_cloud_updated_at before update on public.manufacturers_cloud
  for each row execute function public.set_updated_at();

-- ── config: rebate_rules (manager-authored on POS → up + down) ───────────────
create table if not exists public.rebate_rules_cloud (
  uid                    uuid not null,
  tenant_id              uuid not null,
  manufacturer_uid       uuid,
  name                   text not null,
  rule_type              text not null,       -- bogo_discount | multi_pack_discount | flat_discount
  qualifying_skus        jsonb not null default '[]'::jsonb,
  qualifying_quantity    integer not null default 1,
  discount_amount        numeric(12,2) not null default 0,
  discount_type          text not null default 'flat',   -- flat | percent
  is_manufacturer_funded boolean not null default true,
  active_start_date      date,
  active_end_date        date,
  is_active              boolean not null default true,
  register_id            text,                -- author (advisory)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (tenant_id, uid)
);
create index if not exists idx_rebate_rules_cloud_upd on public.rebate_rules_cloud (tenant_id, updated_at);
alter table public.rebate_rules_cloud enable row level security;
-- Read + author within the tenant (the POS gates the CRUD screen to managers).
drop policy if exists "rebate_rules_cloud_select" on public.rebate_rules_cloud;
create policy "rebate_rules_cloud_select" on public.rebate_rules_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists "rebate_rules_cloud_insert" on public.rebate_rules_cloud;
create policy "rebate_rules_cloud_insert" on public.rebate_rules_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id());
drop policy if exists "rebate_rules_cloud_update" on public.rebate_rules_cloud;
create policy "rebate_rules_cloud_update" on public.rebate_rules_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create trigger trg_rebate_rules_cloud_updated_at before update on public.rebate_rules_cloud
  for each row execute function public.set_updated_at();

-- ── audit: applied_rebates (register → up, insert-only) ──────────────────────
create table if not exists public.applied_rebates_cloud (
  uid                    uuid primary key,
  tenant_id              uuid not null,
  location_id            uuid,
  register_id            text,
  transaction_id         bigint,
  rebate_rule_uid        uuid,
  manufacturer_uid       uuid,
  barcode                text,
  discount_amount        numeric(12,2) not null default 0,
  is_manufacturer_funded boolean not null default true,
  was_auto_applied       boolean not null default false,
  applied_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_applied_rebates_report on public.applied_rebates_cloud (tenant_id, manufacturer_uid, applied_at);
alter table public.applied_rebates_cloud enable row level security;
drop policy if exists "applied_rebates_cloud_insert" on public.applied_rebates_cloud;
create policy "applied_rebates_cloud_insert" on public.applied_rebates_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());
drop policy if exists "applied_rebates_cloud_select" on public.applied_rebates_cloud;
create policy "applied_rebates_cloud_select" on public.applied_rebates_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- ── audit: missed_rebates (register → up, insert-only) ───────────────────────
create table if not exists public.missed_rebates_cloud (
  uid                uuid primary key,
  tenant_id          uuid not null,
  location_id        uuid,
  register_id        text,
  transaction_id     bigint,
  rebate_rule_uid    uuid,
  manufacturer_uid   uuid,
  barcode            text,
  potential_discount numeric(12,2) not null default 0,
  detected_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_missed_rebates_report on public.missed_rebates_cloud (tenant_id, manufacturer_uid, detected_at);
alter table public.missed_rebates_cloud enable row level security;
drop policy if exists "missed_rebates_cloud_insert" on public.missed_rebates_cloud;
create policy "missed_rebates_cloud_insert" on public.missed_rebates_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and location_id = public.current_location_id());
drop policy if exists "missed_rebates_cloud_select" on public.missed_rebates_cloud;
create policy "missed_rebates_cloud_select" on public.missed_rebates_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

-- ── cloud-only: SFTP credentials (service-role only; secret in Vault) ───────
-- The actual password/key lives in Supabase Vault; this table only references it,
-- so credentials never sit in a normal table or on a register.
create table if not exists public.manufacturer_credentials (
  tenant_id        uuid not null,
  manufacturer_uid uuid not null,
  sftp_host        text,
  sftp_port        integer not null default 22,
  sftp_user        text,
  vault_secret_id  uuid,                    -- -> vault.secrets (SFTP password / private key)
  remote_dir       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, manufacturer_uid)
);
alter table public.manufacturer_credentials enable row level security;
-- Intentionally NO policies: only the service role (submission job / owner console) touches this.

-- ── cloud-only: submission audit log (job writes; dashboard reads) ──────────
create table if not exists public.manufacturer_submissions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  manufacturer_uid uuid,
  period_start     date,
  period_end       date,
  status           text not null default 'pending',  -- pending | success | failed
  row_count        integer,
  file_hash        text,
  error            text,
  retry_count      integer not null default 0,
  submitted_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_manufacturer_submissions_tenant on public.manufacturer_submissions (tenant_id, period_end);
alter table public.manufacturer_submissions enable row level security;
-- Read-only for the tenant's dashboard; only the service-role job writes.
drop policy if exists "manufacturer_submissions_select" on public.manufacturer_submissions;
create policy "manufacturer_submissions_select" on public.manufacturer_submissions for select to authenticated
  using (tenant_id = public.current_tenant_id());
create trigger trg_manufacturer_submissions_updated_at before update on public.manufacturer_submissions
  for each row execute function public.set_updated_at();
