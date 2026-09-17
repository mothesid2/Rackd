



alter table public.online_orders add column if not exists customer_name  text;
alter table public.online_orders add column if not exists customer_phone text;

create or replace function public.fill_online_order_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_name is null or new.customer_phone is null then
    select
      coalesce(new.customer_name, nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')),
      coalesce(new.customer_phone, c.phone)
      into new.customer_name, new.customer_phone
      from public.storefront_customers c
     where c.id = new.customer_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_fill_online_order_customer on public.online_orders;
create trigger trg_fill_online_order_customer
  before insert on public.online_orders
  for each row execute function public.fill_online_order_customer();


update public.online_orders o
   set customer_name  = nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
       customer_phone = c.phone
  from public.storefront_customers c
 where c.id = o.customer_id
   and (o.customer_name is null or o.customer_phone is null);
