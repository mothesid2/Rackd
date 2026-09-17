



create or replace function public.store_sales_agg(p_start timestamptz, p_end timestamptz)
returns table (tenant_id uuid, revenue numeric, txn_count bigint, refund_count bigint)
language sql stable security definer set search_path = public as $$
  select tenant_id,
         coalesce(sum(total), 0)                     as revenue,
         count(*)                                    as txn_count,
         count(*) filter (where total < 0)           as refund_count
    from public.transactions_cloud
   where created_at >= p_start and created_at < p_end
   group by tenant_id;
$$;


create or replace function public.store_last_activity()
returns table (tenant_id uuid, last_txn_at timestamptz)
language sql stable security definer set search_path = public as $$
  select tenant_id, max(created_at) as last_txn_at
    from public.transactions_cloud
   group by tenant_id;
$$;


create or replace function public.store_top_skus(p_start timestamptz, p_end timestamptz, p_limit int)
returns table (tenant_id uuid, product_id integer, name text, units bigint)
language sql stable security definer set search_path = public as $$
  with agg as (
    select ti.tenant_id,
           ti.product_id,
           coalesce(max(inv.name), max(ti.description)) as name,
           sum(ti.qty)                                  as units,
           row_number() over (partition by ti.tenant_id order by sum(ti.qty) desc) as rn
      from public.transaction_items_cloud ti
      left join public.inventory_cloud inv
             on inv.tenant_id = ti.tenant_id and inv.id = ti.product_id
     where ti.created_at >= p_start and ti.created_at < p_end
     group by ti.tenant_id, ti.product_id
  )
  select tenant_id, product_id, name, units from agg where rn <= p_limit;
$$;

grant execute on function public.store_sales_agg(timestamptz, timestamptz) to service_role;
grant execute on function public.store_last_activity() to service_role;
grant execute on function public.store_top_skus(timestamptz, timestamptz, int) to service_role;
