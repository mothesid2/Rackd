

alter table public.pos_layout_config_cloud add column if not exists cloud_id bigint generated always as identity;
create index if not exists idx_pos_layout_config_cloud_pull_order on public.pos_layout_config_cloud (updated_at, cloud_id);
