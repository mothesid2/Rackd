



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
