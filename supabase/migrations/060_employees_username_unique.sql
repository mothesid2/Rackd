

create unique index if not exists idx_employees_cloud_tenant_username
  on public.employees_cloud (tenant_id, username)
  where username is not null;
