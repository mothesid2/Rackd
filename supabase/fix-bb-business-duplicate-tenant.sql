

select 'employees' as what, count(*) from public.employees_cloud where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289'
union all
select 'kiosks', count(*) from public.license_registrations where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289'
union all
select 'transactions', count(*) from public.transactions_cloud where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289'
union all
select 'online_orders', count(*) from public.online_orders where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';



begin;

delete from public.employees_cloud   where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';
delete from public.locations         where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';
delete from public.licenses          where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';

commit;


select id, name, license_key, tenant_id, kind from public.licenses where name = 'BB Business LLC';

