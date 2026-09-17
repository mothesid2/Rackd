





update public.customers_cloud set uid = gen_random_uuid() where uid is null;
alter table public.customers_cloud alter column uid set not null;


alter table public.customers_cloud drop constraint if exists customers_cloud_pkey;
alter table public.customers_cloud add primary key (tenant_id, uid);


drop index if exists public.idx_customers_cloud_tenant_uid;
