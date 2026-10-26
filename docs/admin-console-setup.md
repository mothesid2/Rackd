# Admin console (r4ckd.net/admin) setup

The console is for platform administrators only. Who counts as an admin is decided by the database:
a user must exist in Supabase Auth **and** have a row in `public.platform_admins`. There is no shared
admin password and no admin secret in the browser.

## Create the first admin

1. Supabase dashboard > Authentication > Users > Add user (use your real email; tick auto-confirm).
2. Copy that user's id, then in the SQL editor:

```sql
insert into public.platform_admins (user_id, email)
values ('<the user id>', 'you@yourdomain.com');
```

3. Open `https://r4ckd.net/admin/`, enter the email, then the 6-digit code from the email (or click the link).
   The page never creates accounts (`shouldCreateUser: false`), so a stranger who types an email gets nothing.

A signed-in storefront customer who opens `/admin` sees "Not authorized": a valid login is not enough.

## Recommended hardening

- Turn on MFA for admin users in Supabase Auth, and keep the admin list to as few people as possible.
- Remove an admin with `delete from platform_admins where user_id = '...'`. Access ends on their next request.

## What the console does

| Screen | Reads | Actions |
|---|---|---|
| Applications | queue by status, plan, dates, search; permit expiry flags (red = expired or within 30 days) | start review, request info (emails applicant), approve (provisions once), reject with reason (emails applicant), internal notes |
| Application detail | everything submitted, files via 60-second signed links, EIN masked | reveal EIN (decrypted server-side, audit-logged), resend owner invite |
| Hardware orders | list and detail | mark fulfilled, mark shipped with tracking (emails customer), cancel (paid orders restock, refund in Stripe), manual refund notes |
| Pricing & config | plans, add-ons, online fee, hardware tax/shipping, product prices and stock, bundles, placeholder flags | edits are validated by the database and audit-logged with before and after |
| Audit log | append-only, filterable | none (cannot be edited, even by admins) |

## Approval and owner activation

Approve runs `onb_provision` once (one transaction, row-locked). A second click returns the same business and
sends nothing. The owner then gets a welcome email with their business activation key and a link to
`/get-started/activate`, where they choose their own password. No temporary password is ever emailed.
The application becomes `activated` when they finish that step.

Their login is created in `employees_cloud` with role `admin`, the same table `staff-login` reads, using bcrypt.
The register PIN is left unset; the POS asks them to set it on first use (verify this on a real POS).

## Cloudflare Pages requirements

- Secrets: `SUPABASE_SERVICE_ROLE_KEY`, `EIN_ENCRYPTION_KEY`, `ORDER_LINK_SECRET` (falls back to the EIN key), `RESEND_API_KEY`.
- The activation endpoint hashes passwords with bcrypt, which needs more CPU than the free Workers plan
  allows (about 10 ms). Use the Workers Paid plan for the Pages project, or move that single step to a Supabase Edge Function.
