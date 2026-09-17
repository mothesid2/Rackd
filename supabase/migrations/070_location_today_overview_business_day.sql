

drop function if exists public.location_today_overview(uuid, uuid);

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
    'profit', coalesce((select sum(total) from txns), 0) - (select total from cogs)
  );
$$;
grant execute on function public.location_today_overview(uuid, uuid, timestamptz) to authenticated;
