



create or replace function public.set_storefront_branding(
  p_location uuid, p_address text default null, p_logo_url text default null,
  p_show_logo boolean default null, p_zip text default null, p_clear_logo boolean default false
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;
  if p_clear_logo then
    update public.locations
       set logo_url = null, show_logo = false
     where id = p_location and tenant_id = public.current_tenant_id()
    returning * into v_row;
  else
    update public.locations
       set logo_url  = coalesce(p_logo_url, logo_url),
           show_logo = coalesce(p_show_logo, show_logo)
     where id = p_location and tenant_id = public.current_tenant_id()
    returning * into v_row;
  end if;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_branding(uuid, text, text, boolean, text, boolean) from public, anon;
grant execute on function public.set_storefront_branding(uuid, text, text, boolean, text, boolean) to authenticated;

drop function if exists public.set_storefront_branding(uuid, text, text, boolean, text);
