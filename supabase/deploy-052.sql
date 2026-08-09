-- Rackd cloud schema — deploy bundle for migration 052 (real per-location merchant fee: credit %, debit %, flat fee).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.
--
-- Supersedes an earlier single-blended-% version of this migration that was
-- never applied (confirmed via live query before this was rewritten) — no
-- data migration needed, this is the first real version to ship.
--
-- Fix (this revision): tenant_location_report's CREATE OR REPLACE was rejected
-- by Postgres (42P13 — cannot change return type of existing function) because
-- this migration adds two new OUT columns to it. Added a DROP FUNCTION first,
-- and re-added the GRANT that the DROP strips (grants attach to the specific
-- function object, not its name).

-- ==================== supabase/migrations/052_merchant_fee_rate.sql ====================
-- 052_merchant_fee_rate.sql
--
-- Replaces the flat, manager-editable "tip pool deduction %" (legally risky —
-- an arbitrary skim booked as owner revenue is not defensible as a processing-
-- cost deduction from pooled tips) with owner-only, per-location REAL
-- merchant/card-processing rates. Same rates also feed an "estimated card
-- processing cost" line in revenue reporting, since card fees eat into
-- product-sale revenue too, not just tips. All default 0 (no deduction) until
-- the owner explicitly sets real numbers — never a guessed default.
--
-- Three fields, not one flat %, since real card processing has a credit rate,
-- a (usually lower) debit rate, and a flat per-transaction fee on top
-- (e.g. "2.6% + $0.10"). NOTE: this build's POS/terminal integration cannot
-- currently distinguish credit from debit on a transaction (the terminal only
-- reports card BRAND — Visa/Mastercard/etc — never an account-type flag), so
-- until that data exists, the lower of the two rates is applied uniformly
-- (never over-deducts from tips, which is the direction that matters
-- legally) — see src/main/ipc/xzout.ts computeTipPool.

alter table public.locations drop column if exists merchant_fee_pct;
alter table public.locations add column if not exists merchant_fee_credit_pct numeric(5,2) not null default 0;
alter table public.locations add column if not exists merchant_fee_debit_pct numeric(5,2) not null default 0;
alter table public.locations add column if not exists merchant_fee_flat_cents integer not null default 0;

-- ── carry the same deduction into Manager Portal revenue (021's report RPCs) ──
-- Card processing fees eat into product-sale revenue exactly as much as they eat
-- into tips — a manager looking at "revenue" who never sees the processing cost
-- is looking at a number that overstates what actually lands in the bank. Adds
-- net_revenue/merchant_fee_amount alongside (not replacing) the existing gross
-- figures, same "lower of credit/debit" fallback as computeTipPool (see above)
-- since this build still can't tell credit from debit per-transaction.
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
  ),
  -- max(...) over a filtered select always returns exactly one row (even when
  -- p_location matches nothing, e.g. a bad id or a cross-tenant lookup blocked
  -- by RLS) — a plain filtered select would return zero rows there and, being
  -- comma-joined below, collapse the entire function's result to nothing.
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

-- Manager dashboard: one summary row per location — now with the same net-of-fee figure.
-- Changing the OUT column list means CREATE OR REPLACE can't be used in place —
-- Postgres rejects a return-type change on an existing function (42P13) — so the
-- old signature must be dropped first. location_report_core above doesn't need
-- this: it returns a single jsonb value, not a table, so its type never changed.
drop function if exists public.tenant_location_report(date, date);
create or replace function public.tenant_location_report(p_start date, p_end date)
returns table (
  location_id uuid, location_name text, revenue numeric, net_revenue numeric,
  merchant_fee_amount numeric, txn_count bigint, refund_count bigint, last_txn_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  with agg as (
    select t.location_id,
           coalesce(loc.name, 'Location')                                     as location_name,
           coalesce(sum(t.total), 0)                                          as revenue,
           count(*)                                                           as txn_count,
           count(*) filter (where t.total < 0)                                as refund_count,
           max(t.created_at)                                                  as last_txn_at,
           coalesce(sum(t.total) filter (where t.payment_method <> 'cash'), 0) as card_total,
           count(*) filter (where t.payment_method <> 'cash')                  as card_txn_count,
           coalesce(loc.merchant_fee_credit_pct, 0)                           as credit_pct,
           coalesce(loc.merchant_fee_debit_pct, 0)                            as debit_pct,
           coalesce(loc.merchant_fee_flat_cents, 0)                           as flat_cents
      from public.transactions_cloud t
      left join public.locations loc on loc.id = t.location_id
     where t.tenant_id = public.current_tenant_id()
       and t.payment_status = 'completed'
       and (t.created_at at time zone 'America/Chicago')::date between p_start and p_end
     group by t.location_id, loc.name, loc.merchant_fee_credit_pct, loc.merchant_fee_debit_pct, loc.merchant_fee_flat_cents
  ),
  computed as (
    select *,
      round(
        card_total * (case
          when credit_pct > 0 and debit_pct > 0 then least(credit_pct, debit_pct)
          when credit_pct > 0 then credit_pct
          when debit_pct > 0 then debit_pct
          else 0
        end) / 100
        + card_txn_count * flat_cents / 100.0
      , 2) as fee_amount
    from agg
  )
  select location_id, location_name, revenue, revenue - fee_amount as net_revenue,
         fee_amount as merchant_fee_amount, txn_count, refund_count, last_txn_at
    from computed
   order by revenue desc;
$$;
-- DROP FUNCTION above also drops its grant (grants attach to the specific
-- object, not the name) — 021 granted this to `authenticated` for the Manager
-- Portal's dashboard call; without re-granting, that call would silently start
-- failing (or returning nothing) even though the function itself is correct.
grant execute on function public.tenant_location_report(date, date) to authenticated;
