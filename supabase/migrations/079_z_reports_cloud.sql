

create table if not exists public.z_reports_cloud (
  id              bigint not null,
  tenant_id       uuid not null,
  location_id     uuid,
  register_id     text not null,
  generated_at    timestamptz not null,
  shift_opened_at timestamptz,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, register_id, id)
);
create index if not exists idx_z_reports_cloud_location on public.z_reports_cloud (tenant_id, location_id, generated_at);
alter table public.z_reports_cloud enable row level security;
drop policy if exists "z_reports_cloud_insert" on public.z_reports_cloud;
create policy "z_reports_cloud_insert" on public.z_reports_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id());
drop policy if exists "z_reports_cloud_select" on public.z_reports_cloud;
create policy "z_reports_cloud_select" on public.z_reports_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());



create or replace function public.location_today_overview(p_tenant uuid, p_location uuid, p_start timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select greatest(
      p_start,
      coalesce(
        (select max(generated_at) from public.z_reports_cloud
          where tenant_id = p_tenant and location_id = p_location and generated_at > p_start),
        p_start
      )
    ) as start_ts
  ),
  txns as (
    select t.*
      from public.transactions_cloud t, bounds b
     where t.tenant_id = p_tenant and t.location_id = p_location
       and t.payment_status = 'completed'
       and t.created_at >= b.start_ts
  ),
  items as (
    select ti.*
      from public.transaction_items_cloud ti, bounds b
     where ti.tenant_id = p_tenant and ti.location_id = p_location
       and ti.created_at >= b.start_ts
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

create or replace function public.location_report_core_window(p_tenant uuid, p_location uuid, p_start timestamptz, p_end timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select greatest(
      p_start,
      coalesce(
        (select max(generated_at) from public.z_reports_cloud
          where tenant_id = p_tenant and location_id = p_location
            and generated_at > p_start and generated_at < p_end),
        p_start
      )
    ) as start_ts
  ),
  txns as (
    select t.*
      from public.transactions_cloud t, bounds b
     where t.tenant_id = p_tenant and t.location_id = p_location
       and t.payment_status = 'completed'
       and t.created_at >= b.start_ts and t.created_at < p_end
  ),
  items as (
    select ti.*
      from public.transaction_items_cloud ti, bounds b
     where ti.tenant_id = p_tenant and ti.location_id = p_location
       and ti.created_at >= b.start_ts and ti.created_at < p_end
  ),
  summary as (
    select
      coalesce(sum(subtotal + discount_amount), 0) as gross,
      coalesce(sum(discount_amount), 0)            as discounts,
      coalesce(sum(subtotal), 0)                   as net_presubtax,
      coalesce(sum(tax_amount), 0)                 as tax,
      coalesce(sum(total), 0)                      as total_collected,
      count(*)                                     as count,
      coalesce(sum(total) filter (where payment_method = 'split'), 0)     as split_total,
      coalesce(sum(total) filter (where order_source = 'online'), 0)      as online_total
    from txns
  ),
  units as ( select coalesce(sum(qty), 0) as units from items where qty > 0 ),
  refunds as ( select count(*) as count, coalesce(sum(total), 0) as total from txns where total < 0 ),
  pay as (
    select
      coalesce(sum(total) filter (where payment_method = 'cash'), 0)                                             as cash,
      count(*)            filter (where payment_method = 'cash')                                                 as cash_count,
      coalesce(sum(total) filter (where payment_method <> 'cash' and card_type ilike '%visa%'), 0)              as visa_amt,
      count(*)            filter (where payment_method <> 'cash' and card_type ilike '%visa%')                   as visa_cnt,
      coalesce(sum(total) filter (where payment_method <> 'cash' and (card_type ilike '%master%' or card_type = 'MC')), 0) as mc_amt,
      count(*)            filter (where payment_method <> 'cash' and (card_type ilike '%master%' or card_type = 'MC'))      as mc_cnt,
      coalesce(sum(total) filter (where payment_method <> 'cash' and card_type ilike '%disc%'), 0)              as disc_amt,
      count(*)            filter (where payment_method <> 'cash' and card_type ilike '%disc%')                   as disc_cnt,
      coalesce(sum(total) filter (where payment_method <> 'cash' and (card_type ilike '%amex%' or card_type ilike '%american%')), 0) as amex_amt,
      count(*)            filter (where payment_method <> 'cash' and (card_type ilike '%amex%' or card_type ilike '%american%'))      as amex_cnt,
      coalesce(sum(total) filter (where payment_method <> 'cash'
        and coalesce(card_type,'') !~* 'visa|master|disc|amex|american' and coalesce(card_type,'') <> 'MC'), 0) as other_amt,
      count(*)            filter (where payment_method <> 'cash'
        and coalesce(card_type,'') !~* 'visa|master|disc|amex|american' and coalesce(card_type,'') <> 'MC')     as other_cnt
    from txns
  ),
  by_category as (
    select coalesce(nullif(inv.category, ''), nullif(i.category, ''), 'Uncategorized') as category,
           sum(i.qty) as qty, sum(i.line_total) as revenue
      from items i
      left join public.inventory_cloud inv
             on inv.tenant_id = i.tenant_id and inv.register_id = i.register_id and inv.id = i.product_id
     group by 1 order by revenue desc
  ),
  top_products as (
    select coalesce(max(inv.name), max(i.description)) as name, sum(i.qty) as qty, sum(i.line_total) as revenue
      from items i
      left join public.inventory_cloud inv
             on inv.tenant_id = i.tenant_id and inv.register_id = i.register_id and inv.id = i.product_id
     where i.product_id is not null
     group by i.product_id order by revenue desc limit 5
  ),
  fee_cfg as (
    select coalesce(max(merchant_fee_credit_pct), 0) as credit_pct,
           coalesce(max(merchant_fee_debit_pct), 0)  as debit_pct,
           coalesce(max(merchant_fee_flat_cents), 0) as flat_cents
      from public.locations where id = p_location
  ),
  fees as (
    select
      case
        when f.credit_pct > 0 and f.debit_pct > 0 then least(f.credit_pct, f.debit_pct)
        when f.credit_pct > 0 then f.credit_pct
        when f.debit_pct > 0 then f.debit_pct
        else 0
      end                                                                as effective_pct,
      f.flat_cents                                                       as flat_cents,
      (p.visa_amt + p.mc_amt + p.disc_amt + p.amex_amt + p.other_amt)    as card_total,
      (p.visa_cnt + p.mc_cnt + p.disc_cnt + p.amex_cnt + p.other_cnt)    as card_txn_count
    from fee_cfg f, pay p
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'gross', s.gross, 'discounts', s.discounts, 'net_presubtax', s.net_presubtax,
      'tax', s.tax, 'total_collected', s.total_collected, 'count', s.count,
      'avg', case when s.count > 0 then s.total_collected / s.count else 0 end,
      'units', u.units,
      'units_per_txn', case when s.count > 0 then u.units::numeric / s.count else 0 end,
      'split_total', s.split_total,
      'online_total', s.online_total,
      'merchant_fee_pct', fe.effective_pct,
      'merchant_fee_flat_cents', fe.flat_cents,
      'merchant_fee_amount', round(fe.card_total * fe.effective_pct / 100 + fe.card_txn_count * fe.flat_cents / 100.0, 2),
      'net_revenue', s.total_collected - round(fe.card_total * fe.effective_pct / 100 + fe.card_txn_count * fe.flat_cents / 100.0, 2)
    ),
    'payments', jsonb_build_object(
      'cash', p.cash, 'cash_count', p.cash_count,
      'brands', jsonb_build_array(
        jsonb_build_object('brand','Visa','amount',p.visa_amt,'count',p.visa_cnt),
        jsonb_build_object('brand','Mastercard','amount',p.mc_amt,'count',p.mc_cnt),
        jsonb_build_object('brand','Discover','amount',p.disc_amt,'count',p.disc_cnt),
        jsonb_build_object('brand','Amex','amount',p.amex_amt,'count',p.amex_cnt)
      ),
      'other_card', jsonb_build_object('amount', p.other_amt, 'count', p.other_cnt),
      'card_total', p.visa_amt + p.mc_amt + p.disc_amt + p.amex_amt + p.other_amt
    ),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category',category,'qty',qty,'revenue',revenue)) from by_category), '[]'::jsonb),
    'top_products', coalesce((select jsonb_agg(jsonb_build_object('name',name,'qty',qty,'revenue',revenue)) from top_products), '[]'::jsonb),
    'refunds', jsonb_build_object('count', r.count, 'total', r.total)
  )
  from summary s, units u, refunds r, pay p, fees fe;
$$;
grant execute on function public.location_report_core_window(uuid, uuid, timestamptz, timestamptz) to authenticated;
