



select tenant_id, name, count(*) as copies, array_agg(id order by created_at) as location_ids
  from public.locations
 group by tenant_id, name
having count(*) > 1;




