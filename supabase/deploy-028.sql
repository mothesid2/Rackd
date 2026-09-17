



create or replace function public.rebate_set_secret(p_value text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  sid uuid;
begin
  select id into sid from vault.secrets where name = p_name;
  if sid is null then
    sid := vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(sid, p_value);
  end if;
  return sid;
end;
$$;
revoke all on function public.rebate_set_secret(text, text) from public, anon, authenticated;
grant execute on function public.rebate_set_secret(text, text) to service_role;
