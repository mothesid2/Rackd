


alter table public.licenses
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status    text,          
  add column if not exists plan                   text,          
  add column if not exists billing_cycle          text,          
  add column if not exists trial_ends_at          timestamptz,
  add column if not exists current_period_end     timestamptz,
  add column if not exists grace_until            timestamptz,   
  add column if not exists cancel_at              timestamptz,
  add column if not exists canceled_at            timestamptz,
  add column if not exists purge_after            timestamptz;   

create index if not exists idx_licenses_stripe_customer on public.licenses (stripe_customer_id);
create index if not exists idx_licenses_stripe_sub      on public.licenses (stripe_subscription_id);


create table if not exists public.billing_events (
  id         bigint generated always as identity primary key,
  license_key text,
  tenant_id  uuid,
  type       text not null,
  data       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_billing_events_key on public.billing_events (license_key, created_at desc);
