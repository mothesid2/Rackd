-- 021_manager_portal.sql
-- Manager portal (spec v3, Phase 6). A manager credential is a license row with
-- kind='manager' and location_id = NULL, so its JWT is tenant-wide (no location
-- claim) and RLS lets it read/write every location in the business. This migration
-- adds that column plus the cross-location report RPCs the portal needs.
--
-- All functions are SECURITY INVOKER, so RLS on the cloud mirrors does the
-- scoping: a manager token (null location) sees the whole tenant; a register token
-- sees only its location. Passing another tenant's location id simply returns
-- nothing (RLS filters to current_tenant_id()).

-- ── manager credential marker ────────────────────────────────────────────────
alter table public.licenses add column if not exists kind text not null default 'register';

-- ── shared report core (parameterized; 020's body factored out) ─────────────
create or replace function public.location_report_core(p_tenant uuid, p_location uuid, p_start date, p_end date)
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
       and (t.created_at at time zone 'America/Chicago')::date between p_start and p_end
  ),
  items as (
    select ti.*
      from public.transaction_items_cloud ti
     where ti.tenant_id = p_tenant and ti.location_id = p_location
       and (ti.created_at at time zone 'America/Chicago')::date between p_start and p_end
  ),
  summary as (
    select
      coalesce(sum(subtotal + discount_amount), 0) as gross,
      coalesce(sum(discount_amount), 0)            as discounts,
      coalesce(sum(subtotal), 0)                   as net_presubtax,
      coalesce(sum(tax_amount), 0)                 as tax,
      coalesce(sum(total), 0)                      as total_collected,
      count(*)                                     as count
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
    select coalesce(nullif(category, ''), 'Uncategorized') as category, sum(qty) as qty, sum(line_total) as revenue
      from items group by 1 order by revenue desc
  ),
  top_products as (
    select coalesce(max(inv.name), max(i.description)) as name, sum(i.qty) as qty, sum(i.line_total) as revenue
      from items i
      left join public.inventory_cloud inv on inv.tenant_id = i.tenant_id and inv.id = i.product_id
     where i.product_id is not null
     group by i.product_id order by revenue desc limit 5
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'gross', s.gross, 'discounts', s.discounts, 'net_presubtax', s.net_presubtax,
      'tax', s.tax, 'total_collected', s.total_collected, 'count', s.count,
      'avg', case when s.count > 0 then s.total_collected / s.count else 0 end,
      'units', u.units,
      'units_per_txn', case when s.count > 0 then u.units::numeric / s.count else 0 end
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
  from summary s, units u, refunds r, pay p;
$$;

-- Register X/Z (020) now delegates to the core with its own JWT scope.
create or replace function public.location_period_report(p_start date, p_end date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select public.location_report_core(public.current_tenant_id(), public.current_location_id(), p_start, p_end);
$$;

-- Manager: full report for ANY location in the caller's business.
create or replace function public.manager_location_report(p_location uuid, p_start date, p_end date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select public.location_report_core(public.current_tenant_id(), p_location, p_start, p_end);
$$;

-- Manager dashboard: one summary row per location in the business.
create or replace function public.tenant_location_report(p_start date, p_end date)
returns table (location_id uuid, location_name text, revenue numeric, txn_count bigint, refund_count bigint, last_txn_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select t.location_id,
         coalesce(loc.name, 'Location')            as location_name,
         coalesce(sum(t.total), 0)                  as revenue,
         count(*)                                   as txn_count,
         count(*) filter (where t.total < 0)        as refund_count,
         max(t.created_at)                          as last_txn_at
    from public.transactions_cloud t
    left join public.locations loc on loc.id = t.location_id
   where t.tenant_id = public.current_tenant_id()
     and t.payment_status = 'completed'
     and (t.created_at at time zone 'America/Chicago')::date between p_start and p_end
   group by t.location_id, loc.name
   order by revenue desc;
$$;

grant execute on function public.location_report_core(uuid, uuid, date, date) to authenticated;
grant execute on function public.manager_location_report(uuid, date, date)     to authenticated;
grant execute on function public.tenant_location_report(date, date)            to authenticated;
