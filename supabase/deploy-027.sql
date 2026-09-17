




create or replace function public.tenant_rebate_summary(p_start date, p_end date)
returns table (
  manufacturer_uid   uuid,
  manufacturer_name  text,
  applied_count      bigint,
  applied_auto       bigint,
  applied_manual     bigint,
  applied_amount     numeric,
  missed_count       bigint,
  missed_amount      numeric,
  last_submission_at timestamptz,
  last_submission_status text,
  last_period_end    date
)
language sql
stable
security invoker
set search_path = public
as $$
  with mfr as (
    select uid, name from public.manufacturers_cloud where tenant_id = public.current_tenant_id()
  ),
  applied as (
    select manufacturer_uid,
           count(*) as cnt,
           count(*) filter (where was_auto_applied) as auto_cnt,
           count(*) filter (where not was_auto_applied) as manual_cnt,
           coalesce(sum(discount_amount), 0) as amt
      from public.applied_rebates_cloud
     where tenant_id = public.current_tenant_id()
       and (applied_at at time zone 'America/Chicago')::date between p_start and p_end
     group by manufacturer_uid
  ),
  missed as (
    select manufacturer_uid, count(*) as cnt, coalesce(sum(potential_discount), 0) as amt
      from public.missed_rebates_cloud
     where tenant_id = public.current_tenant_id()
       and (detected_at at time zone 'America/Chicago')::date between p_start and p_end
     group by manufacturer_uid
  ),
  last_sub as (
    select distinct on (manufacturer_uid) manufacturer_uid, submitted_at, status, period_end
      from public.manufacturer_submissions
     where tenant_id = public.current_tenant_id() and status = 'success'
     order by manufacturer_uid, period_end desc
  )
  select m.uid, m.name,
         coalesce(a.cnt, 0), coalesce(a.auto_cnt, 0), coalesce(a.manual_cnt, 0), coalesce(a.amt, 0),
         coalesce(ms.cnt, 0), coalesce(ms.amt, 0),
         ls.submitted_at, ls.status, ls.period_end
    from mfr m
    left join applied a  on a.manufacturer_uid = m.uid
    left join missed ms  on ms.manufacturer_uid = m.uid
    left join last_sub ls on ls.manufacturer_uid = m.uid
   order by m.name;
$$;

grant execute on function public.tenant_rebate_summary(date, date) to authenticated;
