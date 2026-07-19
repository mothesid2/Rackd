-- Rackd cloud schema — deploy bundle for migration 043 (unified staff auth).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/043_staff_auth.sql ====================
-- 043_staff_auth.sql
-- Auth model correction (batch 3, item 1): unified staff accounts across the POS
-- and the Manager Portal.
--
--  • employees_cloud gains must_change_password + must_change_pin (forced change
--    on first login) — these sync to every kiosk with the account.
--  • password_hash already exists here; the client sync now carries it (bcrypt) so
--    one username+password works at every kiosk's start-of-day AND the portal.
--  • Staff become BUSINESS-WIDE: the admin (location_id null) and roaming managers
--    must be readable/writable by every one of the business's kiosks, so the RLS
--    is broadened from location-scoped to tenant-scoped. App-layer role checks
--    (only admin/manager may manage staff) still apply.
--  • 'admin' is a new role value (the column is free-text; no constraint change).

alter table public.employees_cloud add column if not exists must_change_password boolean not null default false;
alter table public.employees_cloud add column if not exists must_change_pin      boolean not null default false;

-- Tenant-scoped staff visibility + management (was location-scoped).
drop policy if exists "employees_cloud_select" on public.employees_cloud;
create policy "employees_cloud_select" on public.employees_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists "employees_cloud_insert" on public.employees_cloud;
create policy "employees_cloud_insert" on public.employees_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "employees_cloud_update" on public.employees_cloud;
create policy "employees_cloud_update" on public.employees_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
