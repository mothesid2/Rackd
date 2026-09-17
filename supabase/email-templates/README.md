# White-labeling Rackd auth emails (Supabase)

The storefront signs customers in with a passwordless email (Supabase `signInWithOtp`).
By default that email is sent by Supabase and its verification **link points at
`<project>.supabase.co`** — which is the branding leak we're fixing. Some of this is
code (the templates in this folder) and some is **dashboard/DNS config only** (marked 🖥️).

## To-do — do these in the Supabase dashboard

1. **Paste the branded templates** — Authentication → **Email Templates**
   - **Magic Link** ← `magic-link.html` (this is the one the storefront actually uses).
     Suggested subject: `Sign in to Rackd`
   - **Confirm signup** ← `confirm-signup.html` (only if "Confirm email" is on).
     Suggested subject: `Confirm your Rackd email`
   - Reuse the same look for **Reset Password / Change Email** if you enable them.

2. 🖥️ **Set a custom sender (SMTP)** — Authentication → **SMTP Settings** → enable custom SMTP.
   Point it at a Rackd domain mailbox (e.g. `no-reply@rackd.io`) via SendGrid / Resend /
   Postmark. **Sender name:** `Rackd`. Without this, mail comes "from" Supabase's shared
   sender, which is another leak.

3. 🖥️ **Custom auth domain (removes `supabase.co` from the link)** — this is the key step.
   Set up a **custom domain** for the project (Project Settings → custom domain, or the
   auth vanity subdomain) so `{{ .ConfirmationURL }}` renders on e.g. `auth.rackd.io`
   instead of `<project>.supabase.co`. Requires a CNAME + the Supabase custom-domain add-on.
   Until this is live, the 6-digit **code** in the Magic Link email (`{{ .Token }}`) is the
   URL-free fallback the customer can type instead of clicking.

4. 🖥️ **Site URL + Redirect URLs** — Authentication → **URL Configuration**
   - **Site URL:** your production storefront (e.g. `https://order.rackd.io`).
   - **Redirect URLs:** add both the production and the staging storefront URLs, so the
     `emailRedirectTo` the storefront sends (`<origin>/account`) is allowed and lands back
     on your domain.

## Optional — the fully URL-free path (no custom domain needed)

If you'd rather not stand up a custom domain, switch the storefront from the magic-**link**
flow to **6-digit code entry** (`verifyOtp`). Then the email contains only a code — no URL
of any kind. This is a small change to `app/account/page.tsx` (add a code input step). Say
the word and I'll wire it.

## Verify it's clean

After steps 1–4: trigger a sign-in from the storefront, open the email, and confirm the
sender, the branding, and the **link host** all read Rackd — no `supabase.co` anywhere in
the signup/verification path.
