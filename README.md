# Rackd POS

A full-featured Point of Sale and business-management desktop application for specialty retail shops — vape, smoke, adult, and general retail — built with Electron + TypeScript + SQLite. Branding and the minimum purchase age are configurable per store, so the same build serves any vertical.

---

## Quick Start

### Prerequisites
- Node.js 18+ and npm
- Windows 10/11 (primary target)

### Setup

```bash
cd "SEI VAPES"
npm install
npm run seed        # Creates DB and loads sample data
npm start           # Launches the app
```

### Default Credentials
| Role    | Username  | Password     |
|---------|-----------|--------------|
| Manager | `admin`   | `admin123`   |
| Cashier | `cashier1`| `cashier123` |

> **You will be prompted to change your password on first login.**

---

## Build (Windows Installer)

```bash
npm run build
```

Produces a Windows NSIS installer in `release/`.

---

## Configuration

### Receipt Printer
Navigate to **Settings** in the app, or set `printer_interface` in settings:
- `printer` — uses the Windows default printer
- A specific printer name (e.g. `"EPSON TM-T20III"`)
- A network path (e.g. `\\server\printer`)

If the printer is offline, receipts are automatically saved as `.txt` files in:
`%APPDATA%\sei-vape-pos\receipts\`

### Card Terminal
In **Settings**:
1. Set **Terminal Type**: `Mock` (testing), `PAX`, or `Dejavoo`
2. Set the terminal's **IP Address** and **Port**
   - PAX default port: `10009`
   - Dejavoo default port: `9100`

The **Mock terminal** approves 80% of transactions automatically — perfect for testing.

### Twilio SMS
In **Settings** → Twilio SMS section:
1. Enter your **Twilio Account SID**
2. Enter your **Auth Token**
3. Enter your **From Number** (must be a Twilio number, e.g. `+15550001234`)

If not configured, the SMS blast UI is hidden.

---

## Project Structure

```
src/
  main/
    index.ts              ← Electron main process
    preload.ts            ← Context bridge (IPC bridge to renderer)
    db/
      schema.ts           ← SQLite schema initialization
      seed.ts             ← Sample data seeder
    ipc/                  ← IPC handlers (auth, products, transactions, etc.)
    services/
      cardTerminal.ts     ← PAX / Dejavoo / Mock terminal
      printer.ts          ← Thermal printer (node-thermal-printer)
      twilio.ts           ← Twilio SMS client
    windows/
      main.ts             ← Main BrowserWindow
      customerDisplay.ts  ← Second-monitor customer display
  renderer/
    login/                ← Login screen
    main-menu/            ← Dashboard + Today Overview
    pos/                  ← New Transaction / POS
    receipts/             ← Previous Transactions
    merchandise/          ← Inventory sub-menu + sub-screens
    customer-lookup/      ← Customer CRM + SMS
    xz-out/               ← X/Z Reports
    customer-display/     ← Second screen (dark theme)
    settings/             ← App configuration
assets/
  icon.svg                ← App icon
```

---

## Database

SQLite database is stored at:
`%APPDATA%\sei-vape-pos\seivapes.db`

### Re-seeding
```bash
npm run seed
```

This will **add** the sample data if it doesn't exist (uses `INSERT OR IGNORE`).

---

## Receipt Format

```
My Store
123 Main St | (555) 000-0000
----------------------------------------
Txn #42  4/23/2024  2:34 PM
Cashier: admin
----------------------------------------
Disposable Vape - Mint
  2 x $14.99                      $29.98
----------------------------------------
Subtotal:                          $29.98
Tax (8.25%):                        $2.47
TOTAL:                             $32.45
----------------------------------------
Cash
Tendered: $40.00  Change: $7.55
----------------------------------------
Thank you for your purchase!
Must be 21+ to purchase.        (only if a minimum age is set)
Thank you for shopping My Store!
```

> Store name, address, phone, footer, tax rate, and **minimum purchase age** are all set under **Settings → Receipt Configuration**.

---

## Features

| Feature               | Notes                                              |
|-----------------------|----------------------------------------------------|
| POS / New Sale        | Barcode scanner, product search, cart management   |
| Cash payment          | Change calculator                                  |
| Card payment          | PAX / Dejavoo TCP/IP or Mock terminal              |
| Discounts             | % or $ — >10% requires manager PIN                |
| Customer attachment   | Attach customer to sale                            |
| Inventory             | Stock levels, low stock alerts, CSV import         |
| Receive Invoice       | Update stock from supplier invoices                |
| Receipts              | Full transaction history with reprint              |
| Customer CRM          | Profile, transaction history, SMS opt-in           |
| SMS Blast             | Twilio-powered bulk SMS to opted-in customers      |
| X/Z Reports           | Shift totals, end-of-day close                     |
| Customer Display      | Second-monitor display (dark navy theme)           |
| Settings              | Terminal, printer, Twilio, receipt config          |


---

## Onboarding, hardware store and admin console (r4ckd.net)

New public routes and a private admin area, all in `storefront/` (Next.js static export on Cloudflare Pages)
with server code in Cloudflare Pages Functions (`storefront/functions/`) and the database in Supabase.
The existing customer storefront and the Electron apps are unchanged, and the homepage is untouched.

| Route | What it is |
|---|---|
| `/get-started` | 9-step application wizard: autosave, resume by emailed link, inline validation |
| `/get-started/resume?token=` | one-time link from the email; restores the draft |
| `/get-started/submitted` | plain-language status, timeline, upload area when we ask for more info |
| `/get-started/activate?token=` | approved owner chooses their own password |
| `/hardware`, `/hardware/product`, `/hardware/build`, `/hardware/cart`, `/hardware/checkout` | catalog, bundle builder, persisted cart, checkout |
| `/hardware/order/<id>#t=<code>` | order status (served by a Pages rewrite in `public/_redirects`) |
| `/hardware/compatibility` | bring-your-own-hardware checklist |
| `/admin/*` | platform-admin console (applications, orders, pricing, audit log) |
| `/api/onboarding/*`, `/api/hardware/*`, `/api/admin/*`, `/api/stripe/webhook`, `/api/cron/permit-reminders` | Pages Functions |

### Safety defaults

Three flags exist and **all default to false**: `STRIPE_LIVE_ENABLED` (Stripe stays in test mode and a live key is
refused), `PAYMENT_PROCESSOR_CONNECTED` (the owner KYC step is only a placeholder; no date of birth or SSN is
ever collected here), `SMS_ENABLED` (Twilio is never called; SMS consent is recorded but nothing is sent).
Stripe is used only for Rackd's own hardware and software charges, never for vape or tobacco product payments.
Confirm Stripe's restricted-business policy before `STRIPE_LIVE_ENABLED=true`.

Sensitive data: the EIN is encrypted in the server (AES-256-GCM, key from `EIN_ENCRYPTION_KEY`) and only shown to a platform
admin by an audit-logged "Reveal". Licenses and IDs go to a private bucket and are read only through 60-second signed
links. Every table has row level security; anonymous users cannot read anything and can only act on their own draft
through a secret token held by the server-side functions.

### Set it up (in this order)

1. **Database.** In the Supabase SQL editor run, in order: `supabase/deploy-081.sql` ... `deploy-091.sql`
   (081 admin/audit/config, 082 application tables, 083 private bucket, 084 hardware, 085 applicant functions,
   086 provisioning and permits, 087 placeholder catalog, 088 agreements, 089-090 orders and payments, 091 admin console).
   Each has a reverse script in `supabase/down/`.
2. **First admin.** Follow `docs/admin-console-setup.md` (create a Supabase Auth user, add them to `platform_admins`).
3. **Secrets** in Cloudflare Pages (names and meanings are in `.env.example`, under "Onboarding"):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EIN_ENCRYPTION_KEY`, `ORDER_LINK_SECRET`, `IP_HASH_SALT`,
   `TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `RESEND_API_KEY` + `RESEND_FROM`, `ADMIN_NOTIFY_EMAIL`,
   `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (test keys), `CRON_SECRET`. The activation endpoint needs the Workers Paid plan (bcrypt).
4. **Stripe test mode and the webhook**: `docs/stripe-hardware-setup.md`.
5. **Daily permit reminders**: `docs/permit-reminders.md` (schedule one call a day).
6. **Redeploy `staff-login`** (`supabase functions deploy staff-login`) so an owner's first sign-in marks the application activated.
7. The Content-Security-Policy in `storefront/public/_headers` already allows Turnstile.

### Demo data

```text
supabase/seed/onboarding_demo.sql          # 6 applications in every status, a provisioned demo business, 3 hardware orders
supabase/seed/onboarding_demo_cleanup.sql  # removes it all
```
Paste into the SQL editor of a **development or staging** project only. Demo rows use `@demo.rackd.test`. EIN reveal
and "View file" do not work on demo rows (the encrypted EIN and files are fake).

### Tests

```bash
npm run test:sql                       # migrations 081-091 + 19 row-level-security test groups + seed/cleanup, on an embedded Postgres
cd storefront
npm test                               # 187 unit tests (crypto, pricing, endpoints, Stripe, reminders, admin)
npm run test:e2e                       # builds against a local mock server, then Playwright smoke tests on desktop and phone
                                       # (uses your installed Chrome; includes axe WCAG 2 A/AA checks)
npm run mock                           # the mock server alone, to click around at http://localhost:3111
```

### What is stubbed or not done

- **Virus scan** for uploads is a hook that marks files `skipped` (set `DOC_SCAN_HOOK_URL` to connect a scanner).
- **SMS**, **processor KYC** and **live Stripe** are off by design (see flags above).
- **Legal text** (Terms, Merchant Agreement, SMS and 21+ wording) is draft text in `storefront/lib/onboarding/legal.ts` and needs counsel review.
- **Placeholder** prices, specs, fees and tax are flagged and editable in `/admin/config`.
- No screen yet for an owner or admin to enter a renewed permit's new expiry date.
- Stripe Tax mode is supported but untested against real Stripe; flat tax is the default.
- The Electron Owner Console was intentionally not changed; admin lives at `/admin`.
- Nothing here has been run against a live Supabase, Stripe, Resend or Cloudflare project; the test suites use mocks and an embedded Postgres.

Plan and decisions: `docs/plans/onboarding-hardware.md`.

## Storefront Manager (online storefront admin)

One React module, `packages/storefront-admin`, mounted in three places:

| Host | Mode | How it gets the module |
| --- | --- | --- |
| `manage/` (manage.r4ckd.net, shops with no POS) | one location | esbuild bundle of the package source (`cd manage && npm run build`, publish `manage/dist`, copy `config.example.js` to `config.js`) |
| Manager Portal, "Online Storefront" | one location | IIFE bundle copied to `renderer/vendor` by `scripts/sync-storefront-bundle.js` (runs on `npm run dist`) |
| Owner Console, "Storefront" | all locations plus business controls | same bundle; token minted by the `admin` edge action `mintOwnerToken` |

- **Inventory:** `inventory_mode` per location. `pos_sync` is read-only price and quantity from the POS; `curated` is a hand-made list.
- **Payments:** pay at pickup only. `PrepayProvider` is a visible, disabled stub. Stripe is not used for vape or tobacco product payments; the old product-card flow in `storefront-checkout` returns 403 unless `STRIPE_PRODUCT_PAYMENTS_ENABLED=true` (default false).
- **Fees:** snapshot on each reservation, accrued on pickup, voided on cancel or no-show. Monthly statements: `POST /api/cron/storefront-statements` with `Authorization: Bearer $CRON_SECRET` on the 1st (body `{"period":"2026-09","dry_run":true}` previews without writing or sending). Every-minute job: `POST /api/cron/storefront-jobs` (hold expiry and the email outbox).
- **Migrations:** `supabase/migrations/092` to `097`, each with `supabase/down/` and `supabase/deploy-09N.sql`. Tests: `npm run test:sql`, `cd packages/storefront-admin && npm test`, `cd storefront && npm test`.
- **Env:** `MANAGE_BASE_URL`, `STRIPE_PRODUCT_PAYMENTS_ENABLED`, `PAYMENT_PROCESSOR_CONNECTED`, `SMS_ENABLED`, `STRIPE_LIVE_ENABLED` (all default false). Redeploy the `admin`, `staff-login` and `storefront-checkout` edge functions after applying the migrations.
