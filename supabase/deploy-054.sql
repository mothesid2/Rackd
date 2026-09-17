



alter table public.inventory_cloud add column if not exists vendor text;
alter table public.inventory_cloud add column if not exists age_restricted boolean not null default false;
