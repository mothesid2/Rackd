



alter table public.locations add column if not exists batch_time time;

create or replace function public.set_location_batch_time(
  p_location uuid, p_batch_time time
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;
  update public.locations
     set batch_time = p_batch_time
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_location_batch_time(uuid, time) from public, anon;
grant execute on function public.set_location_batch_time(uuid, time) to authenticated;
