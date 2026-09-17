

alter table public.categories_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_categories_cloud_pull_order on public.categories_cloud (updated_at, cloud_id);
