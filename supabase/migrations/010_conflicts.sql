-- 010_conflicts.sql
-- Cloud surface for sync conflicts so the manager PWA can review/resolve them.
-- Mirrors the local `conflicts` table (uuid PK here). Tenants read/insert/update
-- their own conflict rows.
--
-- NOTE: the local `conflicts` table is currently in the sync worker's NEVER_SYNC
-- set, so nothing populates this cloud table yet. If conflicts should appear in
-- a cloud PWA, either allow conflicts in the sync policy or have the PWA read
-- them from the local DB. Flagged for follow-up.

create table if not exists public.conflicts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  table_name        text not null,
  record_id         text not null,
  local_updated_at  timestamptz,
  remote_updated_at timestamptz,
  local_payload     jsonb,
  resolved          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_conflicts_tenant   on public.conflicts (tenant_id);
create index if not exists idx_conflicts_created  on public.conflicts (created_at);
create index if not exists idx_conflicts_resolved on public.conflicts (resolved);

alter table public.conflicts enable row level security;

create policy "conflicts_select_own"
  on public.conflicts for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "conflicts_insert_own"
  on public.conflicts for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "conflicts_update_own"
  on public.conflicts for update
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create trigger trg_conflicts_updated_at
  before update on public.conflicts
  for each row execute function public.set_updated_at();
