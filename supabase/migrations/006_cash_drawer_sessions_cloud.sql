


create table if not exists public.cash_drawer_sessions_cloud (
  id            bigint not null,   
  tenant_id     uuid not null,
  employee_id   integer,           
  cashier_name  text,
  event         text not null,     
  amount        numeric(12,2) not null default 0,
  note          text,
  opened_at     timestamptz,       
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists idx_cash_drawer_sessions_cloud_tenant  on public.cash_drawer_sessions_cloud (tenant_id);
create index if not exists idx_cash_drawer_sessions_cloud_created on public.cash_drawer_sessions_cloud (created_at);

alter table public.cash_drawer_sessions_cloud enable row level security;

create policy "cash_drawer_sessions_cloud_insert_own"
  on public.cash_drawer_sessions_cloud for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "cash_drawer_sessions_cloud_select_own"
  on public.cash_drawer_sessions_cloud for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create trigger trg_cash_drawer_sessions_cloud_updated_at
  before update on public.cash_drawer_sessions_cloud
  for each row execute function public.set_updated_at();
