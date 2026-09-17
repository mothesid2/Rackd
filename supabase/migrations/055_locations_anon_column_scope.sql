

revoke select (
  stripe_account_id, stripe_onboarding_complete,
  merchant_fee_credit_pct, merchant_fee_debit_pct, merchant_fee_flat_cents,
  phone, email, created_at, updated_at
) on public.locations from anon;
grant select (
  id, tenant_id, name, address, zip, logo_url, show_logo,
  is_storefront_enabled, tax_rate
) on public.locations to anon;
