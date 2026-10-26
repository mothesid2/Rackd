# Onboarding and Hardware Store: Plan

Status: implemented (milestones 1-12). Decisions taken: admin lives at /admin (Supabase Auth + platform_admins); Resend test sender and Turnstile test keys for dev; Cloudflare Pages git-connected; migrations pasted by hand (deploy-081..091.sql). See the README section "Onboarding, hardware store and admin console" for setup, tests and what is stubbed.
Date: 2026-10-24. Branch: main (6 commits ahead of origin; unrelated untracked `incident_*.js` scratch files are left alone).

## 1. What exists today

### Live site (r4ckd.net)
- `https://r4ckd.net` returns 200 from Cloudflare. It is the existing **customer storefront**: title "Rackd - Order & Pickup", hero "Skip the counter. Grab it off the rack.", "Start a new order", "Pick your shop", footer links to Terms, Privacy, Disclaimers, Accessibility.
- `/get-started` and `/hardware` both return 404 today, so the new routes do not collide with anything.
- `www.r4ckd.net` does not resolve.
- Source: `storefront/` in this repo. Next.js 14 app router, `output: 'export'` (fully static, `trailingSlash: true`), Tailwind, `@supabase/supabase-js`, Stripe.js, TanStack Query. Existing routes: `/`, `/store`, `/store/[id]`, `/checkout`, `/account`, `/orders`, `/terms`, `/privacy`, `/disclaimers`, `/accessibility`.
- Because the export is static there is **no server runtime** in Next. Server code must be Cloudflare Pages Functions (a `storefront/functions/` dir, which does not exist yet) or Supabase edge functions.
- `storefront/public/_headers` sets a strict CSP: `script-src 'self' 'unsafe-inline' https://js.stripe.com`, `connect-src` only self, Supabase, api.stripe.com, `frame-src` only Stripe. Turnstile needs `https://challenges.cloudflare.com` added to `script-src`, `frame-src`, and `connect-src`. Stripe Checkout (hosted) is a redirect, so it needs no CSP change.
- Home page is a client component using a Reveal animation and SmokeHero (three.js).

### Design system
- Tokens live in `storefront/tailwind.config.ts`: `ink #f1efec`, `char #0c0d0f`, `paper #17181b`, `steel #232529`, `line`, `accent #b01d2e`, `ember #e0293d`, `smoke #9a9da3` (AA-tuned on the dark ground). Fonts via `--font-display` / `--font-body`.
- Shared components in `storefront/components/ui/`: `Skeleton.tsx` (`SkeletonMenuRow`, `SkeletonOrderCard`, `SkeletonList`) and `Tooltip.tsx`. I will reuse these and add a generic `SkeletonBlock` only if the existing ones do not fit forms.
- Electron apps use `shared-ui/kit.css|kit.js`, synced into each app by `scripts/sync-shared-ui.js`.

### Backend
- Supabase project `zougcsomgqnfumqkwuoj`. Migrations `supabase/migrations/001..080`; each deployed via an idempotent `supabase/deploy-NNN.sql` pasted into the SQL editor (per project convention; `supabase db push` has been blocked in agent sessions before). Next migration number is **081**.
- Tenant model: `licenses` row with `kind='business'`, `tenant_id`, `license_key` (one per business, not per store), `tier`, `features text[]`, `max_registers`. `locations` rows carry `tenant_id`, `stripe_account_id`, tax rate, storefront flags. `employees_cloud` holds staff; `storefront_customers` holds shoppers.
- Provisioning precedent: `admin` edge function action `createBusiness` (supabase/functions/admin/index.ts:165) already creates locations + a business license and rejects duplicate names. Approval provisioning should call the same logic (extract into `_shared/provision.ts`), not duplicate it.
- Edge functions: admin, billing, jwt-issuer, persona-*, rebate-submit, staff-login, staff-change-password, storefront-checkout, storefront-order-ready, storefront-payment-webhook, stripe-connect, stripe-webhook. Shared: `_shared/notify.ts` (**Resend email already wired** via `RESEND_API_KEY` / `RESEND_FROM`; Twilio SMS wrapper also there, gated only by env), `_shared/rateLimit.ts`.
- Forced password change on first login already exists as `must_change_password` on `employees_cloud`, handled by `staff-login` / `staff-change-password`.
- Stripe: existing Connect and platform-billing code is for merchants. Hardware orders are Rackd's own charge on the platform account and must stay separate from the vape-product Connect flow.

### Admin / roles (gap)
- **There is no platform-admin role.** The Owner Console (`owner-console/`) is a private Electron app. It has no user login; it is gated only by the owner key from first activation, and it calls the `admin` edge function with a shared `ADMIN_SECRET`. Part C says "platform-admin role only", which this model cannot express. See open question 1.

### Not present
- Cloudflare Pages Functions, Turnstile, Playwright, any Supabase Storage bucket for documents, application-level encryption helpers, Supabase Auth `app_metadata` roles, `.env.example` at repo root (only `storefront/.env.example` with 3 vars).

## 2. Proposed architecture

- **Public pages**: new routes under `storefront/app/get-started/**` and `storefront/app/hardware/**` (static export; dynamic ids such as `/hardware/order/:id` and `/get-started/resume` use client-side query params/`generateStaticParams` shell with client fetch, since export cannot do runtime dynamic routes). Homepage untouched until you confirm.
- **Server code**: Cloudflare Pages Functions in `storefront/functions/api/**` using the Supabase **service role key as a Pages secret**. Public endpoints: application create/save/submit, upload-URL issue, Turnstile verify, hardware checkout session, Stripe webhook. This matches your requirement for a Pages Function webhook and keeps one deploy target for the public surface. Existing edge functions stay as they are.
- **Anon access model**: anon gets **no direct table grants**. All draft access goes through `SECURITY DEFINER` RPCs / Pages Functions that take the resume token; the DB stores only `sha256(token)`. RLS denies everything else. Tests prove anon cannot read any application or file.
- **EIN**: AES-256-GCM, app-level, key `EIN_ENCRYPTION_KEY` (32 bytes base64) in Pages/edge secrets; ciphertext + iv + last4 stored (`ein_ciphertext`, `ein_last4`); decrypt only inside the admin function for platform-admin, never logged, never in client bundles.
- **Files**: private bucket `onboarding-docs`, PDF/JPG/PNG, 10MB, path `{application_id}/{uuid}`; uploads via short-lived signed upload URLs issued by the function after MIME/size check; reads only via signed URLs (60s) for platform-admin; `virusScanStub()` hook marks `scan_status='pending'` (stub sets `skipped`).
- **Bot protection**: Turnstile on account creation and submit (server-verified), per-IP and per-email rate limiting (table-backed, reusing the `_shared/rateLimit.ts` approach), honeypot field.
- **Feature flags** (all default false): `STRIPE_LIVE_ENABLED`, `PAYMENT_PROCESSOR_CONNECTED`, `SMS_ENABLED`. Code comment at checkout about Stripe restricted-business policy.

## 3. Data model (additive migrations 081+, each with a `down` section)

| Migration | Contents |
|---|---|
| 081 | `platform_admins`, `audit_log`, `app_config` (plans, add-ons, online fee type/value, tax rate), `rate_limits` |
| 082 | `onboarding_applications` (status enum, resume token hash, encrypted EIN, plan, add-ons), `onboarding_locations`, `onboarding_licenses`, `onboarding_owners`, `onboarding_documents`, `application_events`, `application_notes`, `agreement_versions`, `agreement_signatures`, `sms_consents` |
| 083 | Storage bucket + storage policies (deny all, signed URLs only) |
| 084 | Hardware: `hardware_products`, `hardware_bundles`, `hardware_bundle_items`, `shipping_addresses`, `hardware_orders`, `hardware_order_items`, `stripe_events` (idempotency) |
| 085 | RLS policies + RPCs |
| 086 | Provisioning function + `provision_runs` idempotency table; permit-expiry reminder tracking |

RLS tests go in `supabase/tests/onboarding_rls_tests.sql` in the style of the existing `storefront_tests.sql`: anon reads nothing, anon with token A cannot touch application B, one business's JWT cannot read another's orders/data, non-admin cannot read audit log or decrypt EIN.

## 4. Milestones (small commits, in order)

1. Plan doc + `.env.example` skeleton (this file).
2. Migrations 081-086 + RLS tests + `deploy-NNN.sql` bundles.
3. Shared server libs: crypto, token, Turnstile verify, rate limit, Resend wrapper, flags.
4. Wizard steps 1-9 UI + autosave + resume + submitted/status page.
5. Uploads (signed URL flow, scan stub).
6. Hardware catalog, bundle builder, cart, checkout, order page, compatibility checklist.
7. Stripe Checkout + webhook (idempotent) + confirmation email, test-mode banner.
8. Platform-admin API (queue, detail, request-info, approve/reject, audit, config editor, hardware orders, mark shipped).
9. Provisioning job (transactional, idempotent) + welcome email + activation on first login.
10. Owner Console UI additions (see question 1).
11. Daily permit-expiry reminder function (Supabase scheduled function; email only).
12. Seed script, Playwright smoke tests, README section, final summary (done / stubbed / you must configure).

## 5. Things I will not do
- No SSN, DOB, bank numbers, or card data anywhere. KYC placeholder behind `PAYMENT_PROCESSOR_CONNECTED=false`.
- No SMS sent; Twilio path stays behind `SMS_ENABLED=false`.
- No Stripe for vape/tobacco payments. Stripe only for hardware and Rackd software fees, test mode.
- No homepage replacement, no live deploys, and no applying migrations to the live Supabase project without your say-so.

## 6. Open questions (need your answer before milestone 2)

1. **Platform-admin role.** The Owner Console has no user accounts. Choose: (a) add Supabase-Auth-based platform admins (`platform_admins` table) and give the Owner Console an admin sign-in screen for the new Part C panels; (b) build the admin UI as a protected web area (`r4ckd.net/admin`, Supabase Auth + `platform_admins`) and leave the Electron console unchanged; (c) keep `ADMIN_SECRET` gating. I recommend (b): it satisfies "platform-admin role only" with real identities and an audit trail, and avoids touching the Electron release pipeline.
2. **Email sender.** `RESEND_FROM` currently defaults to `onboarding@resend.dev`. Is a verified `r4ckd.net` sending domain set up in Resend?
3. **Cloudflare Pages project.** Is r4ckd.net served from a Pages project I can add `functions/` to (git-connected or `wrangler pages deploy out`)? Memory notes say hosting did not exist in July; it clearly does now.
4. **Turnstile keys.** Can you create a widget and supply the site key and secret, or should I use Cloudflare's always-pass test keys for development?
5. **Supabase migrations.** Same deploy convention as before (I write `deploy-NNN.sql`, you paste it into the SQL editor)?
