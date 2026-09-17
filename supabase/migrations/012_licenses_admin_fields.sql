


alter table public.licenses add column if not exists name text;
alter table public.licenses add column if not exists display_config jsonb not null default '{}'::jsonb;
