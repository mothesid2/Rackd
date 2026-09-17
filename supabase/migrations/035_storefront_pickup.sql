



create table if not exists public.online_order_pickups (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.online_orders(id),
  tenant_id     uuid not null,
  location_id   uuid not null,
  register_id   text,
  employee_uid  text,
  employee_name text,
  id_checked    boolean not null,
  at            timestamptz not null default now()
);
create index if not exists idx_oop_order on public.online_order_pickups (order_id);
create index if not exists idx_oop_store on public.online_order_pickups (tenant_id, location_id, at);
alter table public.online_order_pickups enable row level security;

drop policy if exists "oop_select_staff" on public.online_order_pickups;
create policy "oop_select_staff" on public.online_order_pickups for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));

drop trigger if exists trg_oop_immutable on public.online_order_pickups;
create trigger trg_oop_immutable
  before update or delete on public.online_order_pickups
  for each row execute function public.block_mutation();


create or replace function public.complete_online_pickup(
  p_order uuid, p_employee_uid text, p_employee_name text, p_id_checked boolean
)
returns public.online_orders
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ord public.online_orders%rowtype;
begin
  if v_tenant is null then raise exception 'not_staff'; end if;
  if p_id_checked is not true then raise exception 'id_check_required'; end if;

  select * into v_ord from public.online_orders where id = p_order;
  if v_ord.id is null then raise exception 'order_not_found'; end if;
  
  if v_ord.tenant_id <> v_tenant
     or not (public.is_manager() or v_ord.location_id = public.current_location_id()) then
    raise exception 'not_authorized';
  end if;
  if v_ord.status not in ('new', 'preparing', 'ready') then
    raise exception 'not_pickable:%', v_ord.status;   
  end if;

  update public.online_orders
     set status = 'picked_up', picked_up_at = now(),
         picked_up_by_employee_uid = p_employee_uid, id_checked_at_pickup = true
   where id = p_order
  returning * into v_ord;

  insert into public.online_order_pickups
    (order_id, tenant_id, location_id, register_id, employee_uid, employee_name, id_checked)
  values
    (p_order, v_ord.tenant_id, v_ord.location_id,
     nullif(auth.jwt() ->> 'register_id', ''), p_employee_uid, p_employee_name, true);

  return v_ord;
end;
$$;
revoke all on function public.complete_online_pickup(uuid, text, text, boolean) from public, anon;
grant execute on function public.complete_online_pickup(uuid, text, text, boolean) to authenticated;
