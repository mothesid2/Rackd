



alter table public.locations add column if not exists timezone text not null default 'America/Chicago';

create or replace function public.set_location_timezone(
  p_location uuid, p_timezone text
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;
  update public.locations
     set timezone = p_timezone
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_location_timezone(uuid, text) from public, anon;
grant execute on function public.set_location_timezone(uuid, text) to authenticated;
