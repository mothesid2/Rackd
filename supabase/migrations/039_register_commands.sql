-- 039_register_commands.sql
-- Remote kiosk control (spec item 5): the Owner Console can remotely reset a POS
-- kiosk's location lock. There is NO local reset path — the command originates in
-- the cloud, keyed by the kiosk's machine_id, and the POS applies it on its next
-- sync cycle.
--
-- Local-first / offline behavior: an offline kiosk keeps running on its cached
-- lock (never bricks); the command simply waits. On reconnect the POS applies it
-- under two guards (enforced client-side): FLUSH-THEN-RESET (drain the sync outbox
-- first; hold + report if anything dead-lettered) and DEFER past an open business
-- day/shift (apply only when idle / after close-out, never mid-sale).

create table if not exists public.register_commands (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  machine_id   text not null,                 -- target kiosk (license_registrations.machine_id)
  command      text not null default 'reset', -- 'reset' (relock to a new location)
  status       text not null default 'pending', -- pending -> acked -> done | blocked | cancelled
  note         text,                          -- e.g. "blocked: 3 unsynced records need attention"
  created_at   timestamptz not null default now(),
  acked_at     timestamptz,                   -- kiosk received it (may still be deferring)
  completed_at timestamptz
);

create index if not exists idx_register_commands_target
  on public.register_commands (tenant_id, machine_id, status);

alter table public.register_commands enable row level security;

-- A kiosk reads + acks ONLY its own commands (register_id claim = its machine_id),
-- scoped to its tenant. Inserts are service_role only (the Owner Console via the
-- admin Edge Function) — so there is deliberately no INSERT policy here.
drop policy if exists "regcmd_select_own" on public.register_commands;
create policy "regcmd_select_own" on public.register_commands for select to authenticated
  using (tenant_id = public.current_tenant_id() and machine_id = (auth.jwt() ->> 'register_id'));

drop policy if exists "regcmd_update_own" on public.register_commands;
create policy "regcmd_update_own" on public.register_commands for update to authenticated
  using (tenant_id = public.current_tenant_id() and machine_id = (auth.jwt() ->> 'register_id'))
  with check (tenant_id = public.current_tenant_id() and machine_id = (auth.jwt() ->> 'register_id'));
