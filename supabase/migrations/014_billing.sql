-- 014_billing.sql
-- Subscription billing (spec v2 §6). Processor = Stripe, run entirely in Edge
-- Functions (billing + stripe-webhook) — NOT in the POS. Billing state lives on
-- the existing `licenses` row so the existing license enforcement
-- (licenseCheck.ts) drives POS read-only when a subscription lapses:
--   licenses.active = false  ->  POS goes read-only automatically.
-- The webhook is the single writer of these fields; the POS never writes billing.

alter table public.licenses
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status    text,          -- trialing|active|past_due|suspended|canceled
  add column if not exists plan                   text,          -- core|standard|pro
  add column if not exists billing_cycle          text,          -- monthly|annual
  add column if not exists trial_ends_at          timestamptz,
  add column if not exists current_period_end     timestamptz,
  add column if not exists grace_until            timestamptz,   -- 7-day past_due grace before restriction
  add column if not exists cancel_at              timestamptz,
  add column if not exists canceled_at            timestamptz,
  add column if not exists purge_after            timestamptz;   -- 90-day data-retention marker after cancel

create index if not exists idx_licenses_stripe_customer on public.licenses (stripe_customer_id);
create index if not exists idx_licenses_stripe_sub      on public.licenses (stripe_subscription_id);

-- Append-only billing audit trail (invoices, dunning transitions, webhook events).
create table if not exists public.billing_events (
  id         bigint generated always as identity primary key,
  license_key text,
  tenant_id  uuid,
  type       text not null,
  data       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_billing_events_key on public.billing_events (license_key, created_at desc);
