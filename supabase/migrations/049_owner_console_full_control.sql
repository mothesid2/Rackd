



alter table public.locations add column if not exists phone text;
alter table public.locations add column if not exists email text;


alter table public.licenses add column if not exists contact_email text;
alter table public.licenses add column if not exists contact_phone text;


create or replace function public.set_location_contact(
  p_location uuid, p_phone text, p_email text
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  update public.locations
     set phone = coalesce(p_phone, phone),
         email = coalesce(p_email, email)
   where id = p_location
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_location_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_location_contact(uuid, text, text) to service_role;
