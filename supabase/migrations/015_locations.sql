



create or replace function public.current_location_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'location_id', '')::uuid;
$$;


create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  name       text not null default 'Store',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_locations_tenant on public.locations (tenant_id);

alter table public.locations enable row level security;


drop policy if exists "locations_select_own" on public.locations;
create policy "locations_select_own"
  on public.locations for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

drop trigger if exists trg_locations_updated_at on public.locations;
create trigger trg_locations_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();


alter table public.licenses add column if not exists location_id uuid;

create index if not exists idx_licenses_location on public.licenses (location_id);


do $$
declare
  lic record;
  new_loc uuid;
begin
  for lic in select id, tenant_id, name from public.licenses where location_id is null loop
    insert into public.locations (tenant_id, name)
    values (lic.tenant_id, coalesce(lic.name, 'Store'))
    returning id into new_loc;

    update public.licenses set location_id = new_loc where id = lic.id;
  end loop;
end $$;
