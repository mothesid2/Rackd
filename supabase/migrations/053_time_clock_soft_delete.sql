

alter table public.time_clock_cloud add column if not exists deleted boolean not null default false;
create index if not exists idx_time_clock_cloud_deleted on public.time_clock_cloud (deleted) where deleted;
