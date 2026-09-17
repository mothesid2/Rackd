


create table if not exists public.diagnostic_reports (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  location_id uuid,
  register_id text not null,
  created_at  timestamptz not null default now(),
  app_version text,
  app_packaged boolean,
  update_channel text,
  report      jsonb not null
);
create index if not exists idx_diagnostic_reports_tenant on public.diagnostic_reports (tenant_id, created_at desc);
alter table public.diagnostic_reports enable row level security;
drop policy if exists "diagnostic_reports_insert" on public.diagnostic_reports;
create policy "diagnostic_reports_insert" on public.diagnostic_reports for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create table if not exists public.error_reports (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  location_id uuid,
  register_id text not null,
  created_at  timestamptz not null default now(),
  app_version text,
  source      text not null,   
  page        text,            
  message     text not null,
  stack       text,
  context     jsonb
);
create index if not exists idx_error_reports_tenant on public.error_reports (tenant_id, created_at desc);
alter table public.error_reports enable row level security;
drop policy if exists "error_reports_insert" on public.error_reports;
create policy "error_reports_insert" on public.error_reports for insert to authenticated
  with check (tenant_id = public.current_tenant_id());
