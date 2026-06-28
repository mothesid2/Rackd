-- 009_settings_backup.sql
-- Cloud backup of local settings (the local `settings` table itself is never
-- synced; this is an explicit, separate backup). One row per (tenant, key).
-- Tenants read/insert/update their own backup rows.

create table if not exists public.settings_backup (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  key        text not null,
  value      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create index if not exists idx_settings_backup_tenant  on public.settings_backup (tenant_id);
create index if not exists idx_settings_backup_created on public.settings_backup (created_at);

alter table public.settings_backup enable row level security;

create policy "settings_backup_select_own"
  on public.settings_backup for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "settings_backup_insert_own"
  on public.settings_backup for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "settings_backup_update_own"
  on public.settings_backup for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create trigger trg_settings_backup_updated_at
  before update on public.settings_backup
  for each row execute function public.set_updated_at();
