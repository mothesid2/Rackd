-- Rackd cloud schema — deploy bundle for migration 039 (remote kiosk reset).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/039_register_commands.sql ====================
-- Owner-Console-triggered remote reset of a POS kiosk's location lock. Command is
-- keyed by machine_id; the POS applies it on its sync cycle (flush-then-reset,
-- deferred past an open day). Inserts are service_role only (owner console).
create table if not exists public.register_commands (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  machine_id   text not null,
  command      text not null default 'reset',
  status       text not null default 'pending',
  note         text,
  created_at   timestamptz not null default now(),
  acked_at     timestamptz,
  completed_at timestamptz
);

create index if not exists idx_register_commands_target
  on public.register_commands (tenant_id, machine_id, status);

alter table public.register_commands enable row level security;

drop policy if exists "regcmd_select_own" on public.register_commands;
create policy "regcmd_select_own" on public.register_commands for select to authenticated
  using (tenant_id = public.current_tenant_id() and machine_id = (auth.jwt() ->> 'register_id'));

drop policy if exists "regcmd_update_own" on public.register_commands;
create policy "regcmd_update_own" on public.register_commands for update to authenticated
  using (tenant_id = public.current_tenant_id() and machine_id = (auth.jwt() ->> 'register_id'))
  with check (tenant_id = public.current_tenant_id() and machine_id = (auth.jwt() ->> 'register_id'));
