-- 095: outbox worker support. A server job (Pages Function) claims pending notifications, sends them (Resend),
-- and marks them done. Service role only. Reverse with supabase/down/095_down.sql.

create or replace function public.sf_outbox_claim(p_limit integer default 20)
returns table (id bigint, kind text, audience text, payload jsonb)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with c as (
    select o.id from public.storefront_outbox o
     where o.sent_at is null and o.attempts < 5
     order by o.id limit greatest(1, least(p_limit, 100)) for update skip locked),
  u as (
    update public.storefront_outbox o set attempts = o.attempts + 1 from c where o.id = c.id returning o.*)
  select u.id, u.kind, u.audience,
         jsonb_build_object(
           'reservation', public.sf_reservation_json(u.reservation_id),
           'location_name', l.name,
           'pickup_instructions', s.pickup_instructions,
           'notify_email', coalesce(s.notify_email, true),
           'customer_email', sc.email,
           'shop_email', coalesce(nullif(trim(l.email), ''), (select nullif(trim(x.contact_email), '') from public.licenses x where x.tenant_id = u.tenant_id and x.kind = 'business' limit 1)))
    from u
    join public.locations l on l.id = u.location_id
    left join public.storefront_settings s on s.location_id = u.location_id
    left join public.storefront_customers sc on sc.id = (select r.customer_id from public.reservations r where r.id = u.reservation_id);
end;
$$;

create or replace function public.sf_outbox_done(p_id bigint, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path = public as $$
  update public.storefront_outbox set sent_at = case when p_ok then now() else sent_at end, last_error = case when p_ok then null else left(p_error, 300) end where id = p_id;
$$;

revoke all on function public.sf_outbox_claim(integer), public.sf_outbox_done(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.sf_outbox_claim(integer), public.sf_outbox_done(bigint, boolean, text) to service_role;
