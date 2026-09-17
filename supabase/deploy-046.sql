





create or replace function public.store_sales_by_location(p_start timestamptz, p_end timestamptz)
returns table (tenant_id uuid, location_id uuid, revenue numeric, txn_count bigint, refund_count bigint)
language sql stable security definer set search_path = public as $$
  select tenant_id, location_id,
         coalesce(sum(total), 0)             as revenue,
         count(*)                            as txn_count,
         count(*) filter (where total < 0)   as refund_count
    from public.transactions_cloud
   where created_at >= p_start and created_at < p_end
   group by tenant_id, location_id;
$$;
grant execute on function public.store_sales_by_location(timestamptz, timestamptz) to service_role;


create table if not exists public.owner_audit_log (
  id           bigint generated always as identity primary key,
  tenant_id    uuid,
  actor        text not null default 'owner_console',
  action       text not null,               
  target_uid   uuid,                         
  target_label text,                         
  detail       jsonb not null default '{}',  
  created_at   timestamptz not null default now()
);
create index if not exists idx_owner_audit_tenant on public.owner_audit_log (tenant_id, created_at desc);
alter table public.owner_audit_log enable row level security;

