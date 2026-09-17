# Storefront auth, email & SMS — setup checklist

The code for social login, phone login, transactional email, and the age gate is
done. These are the **dashboard/DNS** steps that make them work end-to-end. None of
these secrets ever go in the Cloudflare Pages env — only the 4 `NEXT_PUBLIC_*` keys
do. Server secrets live as Supabase **function secrets**.

## 1. Apple + Google OAuth (bug 2)

Supabase → **Authentication → Providers**.

**Google**
1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID** (Web).
2. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Paste the Client ID + Secret into Supabase → Providers → Google → enable.

**Apple**
1. Apple Developer → Certificates, IDs & Profiles → an **App ID** + a **Services ID**.
2. Services ID return URL: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Create a Sign in with Apple **key**, generate the client secret (JWT), paste into
   Supabase → Providers → Apple → enable.

Supabase → **Authentication → URL Configuration**:
- **Site URL** = the storefront domain (e.g. `https://rackd.com`).
- **Redirect URLs**: add `https://rackd.com/account/` and the Cloudflare
  `*.pages.dev/account/` preview URL. (Trailing slash matters — the app uses PKCE and
  redirects to `/account/` to match `trailingSlash: true`.)

## 2. Phone / SMS login (bug 1)

Supabase → **Authentication → Providers → Phone** → enable, and configure the SMS
provider (Twilio works — reuse the Twilio creds already used for pickup texts).
- The storefront accepts a bare 10-digit US number and normalizes to `+1XXXXXXXXXX`
  before calling `signInWithOtp`, so customers don't type `+1`.

## 3. Resend transactional email (bug 3)

Two layers of email:

**a) App-owned order email (now implemented in code)** — order confirmed / ready /
cancelled go out via Resend from the edge functions. Set function secrets:
```
supabase secrets set RESEND_API_KEY=re_xxx   --project-ref <ref>
supabase secrets set RESEND_FROM="Rackd <orders@rackd.com>"  --project-ref <ref>
```
- In Resend, **verify the sending domain** (`rackd.com`) — add the DKIM/SPF/return-path
  DNS records Resend shows. Until verified, use the sandbox `onboarding@resend.dev`
  (default) which only delivers to your own address.
- Redeploy `storefront-payment-webhook` and `storefront-order-ready` (they import the
  shared `sendEmail`).

**b) Supabase Auth email (signup confirmation / magic link)** — Supabase →
Authentication → **SMTP Settings** → point to Resend SMTP (host `smtp.resend.com`,
port 465, user `resend`, pass = Resend API key), sender on the verified domain.
Without custom SMTP, Supabase's built-in email is rate-limited (~2–3/hour) and often
looks like "not sending" — this is the usual cause. Templates are in
`supabase/email-templates/`.

## 4. Age gate (feature 5)

No config. The signup form blocks account creation under 21 (email path pre-checks
DOB; social/phone paths are signed out if DOB attests under 21). `self_attest_age`
enforces it server-side at checkout as the compliance backstop.
