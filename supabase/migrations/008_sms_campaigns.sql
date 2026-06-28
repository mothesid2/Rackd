-- 008_sms_campaigns.sql
-- Twilio SMS marketing campaigns. Cloud-native (not mirrored from local); uuid
-- PK. Tenants can read and insert their own campaigns; deletes are service_role
-- only (no delete policy). `status` is the campaign/sync state.

create table if not exists public.sms_campaigns (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  name         text not null,
  message      text not null,
  status       text not null default 'draft' check (status in ('draft','scheduled','sending','sent','failed')),
  scheduled_at timestamptz,
  sent_count   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_sms_campaigns_tenant  on public.sms_campaigns (tenant_id);
create index if not exists idx_sms_campaigns_created on public.sms_campaigns (created_at);
create index if not exists idx_sms_campaigns_status  on public.sms_campaigns (status);

alter table public.sms_campaigns enable row level security;

create policy "sms_campaigns_select_own"
  on public.sms_campaigns for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "sms_campaigns_insert_own"
  on public.sms_campaigns for insert
  to authenticated
  with check (tenant_id = public.current_tenant_id());

-- No delete policy: only the service_role (bypasses RLS) may delete campaigns.

create trigger trg_sms_campaigns_updated_at
  before update on public.sms_campaigns
  for each row execute function public.set_updated_at();
