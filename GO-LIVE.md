# Rackd — Go-Live Checklist

Everything needed to take this batch live. Roughly in dependency order: backend →
Stripe → storefront → email → desktop apps → provisioning. `[x]` = already done.

---

## 1. Supabase backend  (do this first — everything depends on it)

### 1a. SQL migrations (Supabase → SQL Editor → paste the `deploy-*.sql` file → Run)
- [x] `supabase/deploy-037.sql`  (storefront customer name)
- [x] `supabase/deploy-038.sql`  (business-key model)
- [x] `supabase/deploy-039.sql`  (remote kiosk reset)
- [ ] `supabase/deploy-040.sql`  (Stripe Connect columns + 5% online fee + onboarding gate)
- [ ] `supabase/deploy-041.sql`  (online receipt auto-print flag)
- [ ] `supabase/deploy-042.sql`  (product images table **+ creates the `product-images` storage bucket + policies**)

### 1b. Edge functions (Dashboard → Edge Functions → paste, or `supabase functions deploy … --use-api`)
- [x] `jwt-issuer`  (business-key + list_locations)
- [ ] **`admin`** — redeploy (gained `onlineOrders` / `publishStatus` / `publish` since the item-5 deploy)
- [ ] **`stripe-connect`** — new function, deploy it (self-contained, dashboard paste OK)
- [ ] **`storefront-checkout`** — redeploy (now a Connect destination charge; imports `_shared/`, so use CLI `--use-api`)

### 1c. Function secrets (Dashboard → Edge Functions → Secrets)
- [ ] `STRIPE_SECRET_KEY`  (`sk_test_…` first, then `sk_live_…`)
- [ ] `STRIPE_CONNECT_RETURN_URL`  *(optional; where Stripe onboarding returns, e.g. `https://rackd.com/connect`)*
- [ ] `STOREFRONT_DEPLOY_HOOK`  *(optional; your Cloudflare/Vercel deploy hook, used by the Owner Console "Publish → Storefront")*
- Already set (leave as-is): `JWT_SECRET`, `ADMIN_SECRET`, Twilio creds.

---

## 2. Stripe (Connect)
- [ ] In the Stripe Dashboard, **enable Connect** and choose **Express** accounts.
- [ ] Keep everything in **Test mode** until the storefront checkout is verified (step 3), then switch to live keys.

---

## 3. Web storefront — Cloudflare Pages
- [ ] Code is pushed on branch **`feature/foundation-local-cloud`**. Either point Pages' **Production branch** at it, or open a PR → `main` (step 8) and use `main`.
- [ ] Build config: **Root dir** `storefront` · **Build command** `npx next build` · **Output dir** `out` (Node pinned to 20 via `.node-version`).
- [ ] Env vars (all public/client — **no** server keys here):
  - Production: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (live)
  - Preview: same, but sandbox Supabase + `pk_test_…` + `NEXT_PUBLIC_DEMO=1`
- [ ] Re-run the deployment; confirm the `*.pages.dev` URL loads.
- [ ] Add the **custom domain** (auto-DNS + auto-SSL, since the domain is on Cloudflare); confirm the padlock.
- [ ] Run a **test-mode checkout** end-to-end before flipping Stripe/Supabase to live.

---

## 4. White-label the auth emails  (Supabase → Authentication)
- [ ] Email Templates → **Magic Link** ← `supabase/email-templates/magic-link.html`; **Confirm signup** ← `confirm-signup.html`.
- [ ] SMTP Settings → custom sender on a Rackd domain (e.g. Resend/Postmark), sender name **Rackd**.
- [ ] Custom **auth domain** (e.g. `auth.rackd.com`) so the verify link isn't a `supabase.co` URL.
- [ ] URL Configuration → **Site URL** = storefront domain; add prod + preview URLs to **Redirect URLs**.

---

## 5. Desktop apps — build & install
- [ ] `npm install` in **owner-console/** and **storefront-desktop/** (manager-portal already has deps).
- [ ] From repo root: `npm run fleet:all`  → 8 installers (`release/` for POS, `dist/` for the others).
- [ ] Run each `*-Setup-*.exe`; Demo + Production install side-by-side.
- [ ] Edit `storefront-desktop/config.js` → set `PROD_URL` / `DEMO_URL` to the deployed storefront (from step 3).
- *(Demo cloud isolation is badge-only for now. To isolate demos to a sandbox Supabase project later: create the project, then rebuild demos with `SANDBOX_SUPABASE_URL` + `SANDBOX_SUPABASE_ANON_KEY` set.)*

---

## 6. First-run provisioning  (after backend is live)
- [ ] **Owner Console**: launch → activate with your owner key (ADMIN_SECRET) → set a username + password.
- [ ] Owner Console → **Businesses → New business** (name + locations) → note the **business key** it issues.
- [ ] **POS kiosk(s)**: launch → activate with the business key → pick the location once (locks the kiosk).
- [ ] **Manager Portal**: sign in with the business key → Storefront tab → **Set up payouts (Stripe)** per location → complete Express onboarding → **Refresh** until "Ready".
- [ ] Manager Portal → turn each location's storefront **On** (only allowed once payouts are Ready) → set its **tax rate**.
- [ ] Manager Portal → menu → tick products to sell online + **upload product photos**.

---

## 7. Auto-update / publish plumbing
- [ ] The POS update feed moved to `app-updates/pos/production` (was `app-updates/production`). Publish the **first** production POS build to the new path (`npm run release`) so installed registers keep updating.
- [ ] For the Owner Console **Publish hub** to have something to promote, upload initial **staging** builds to `app-updates/<app>/staging/` (`npm run release:staging` in POS / manager-portal).

---

## 8. Git / release
- [ ] Open a PR: `feature/foundation-local-cloud` → `main` (review the 4 commits), then set Cloudflare's production branch back to `main`.
- [ ] Decide on the pre-existing unstaged changes (deleted sample `assets/*`, `.env.example`, `valor_test_server.py`) — commit or discard.

---

## 9. Verify end-to-end
- [ ] POS: open the day (manager login) → PIN sign-in → ring a sale → X/Z shows totals, online excluded from the drawer.
- [ ] Storefront (test mode): create account → "Welcome back" on return → order → 5% fee line → pay (Stripe test) → pickup receipt auto-prints at the store → order shows in Owner Console + POS Receipts (Online — Prepaid).
- [ ] Owner Console: reset a test kiosk remotely → confirm it returns to setup after close-out.
