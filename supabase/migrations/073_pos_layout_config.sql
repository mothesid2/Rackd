

create table if not exists public.pos_layout_config_cloud (
  uid          uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  role         text not null check (role in ('cashier', 'manager', 'admin')),
  report_slots jsonb,          
  tile_order   jsonb,          
  updated_at   timestamptz not null default now(),
  unique (tenant_id, role)
);
create index if not exists idx_pos_layout_config_tenant on public.pos_layout_config_cloud (tenant_id);

alter table public.pos_layout_config_cloud enable row level security;
create policy pos_layout_config_tenant_rw on public.pos_layout_config_cloud
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);


drop function if exists public.location_today_overview(uuid, uuid, timestamptz);

create or replace function public.location_today_overview(p_tenant uuid, p_location uuid, p_start timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with txns as (
    select t.*
      from public.transactions_cloud t
     where t.tenant_id = p_tenant and t.location_id = p_location
       and t.payment_status = 'completed'
       and t.created_at >= p_start
  ),
  items as (
    select ti.*
      from public.transaction_items_cloud ti
     where ti.tenant_id = p_tenant and ti.location_id = p_location
       and ti.created_at >= p_start
  ),
  cogs as (
    select coalesce(sum(i.qty * coalesce(inv.cost, 0)), 0) as total
      from items i
      left join public.inventory_cloud inv
             on inv.tenant_id = i.tenant_id and inv.register_id = i.register_id and inv.id = i.product_id
  )
  select jsonb_build_object(
    'revenue', coalesce((select sum(total) from txns), 0),
    'sale_count', (select count(*) from txns),
    'profit', coalesce((select sum(total) from txns), 0) - (select total from cogs),
    'avg_ticket', case when (select count(*) from txns) > 0
                    then coalesce((select sum(total) from txns), 0) / (select count(*) from txns)
                    else 0 end,
    'tax_collected', coalesce((select sum(tax_amount) from txns), 0),
    'discounts_given', coalesce((select sum(discount_amount) from txns), 0),
    'refunds_today', (select count(*) from txns where original_txn_id is not null)
  );
$$;
grant execute on function public.location_today_overview(uuid, uuid, timestamptz) to authenticated;
