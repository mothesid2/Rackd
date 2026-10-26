# Storefront Manager: Plan

Status: draft, awaiting confirmation on the decisions in section 9.
Date: 2026-10-26. Branch: `feature/storefront-manager` (cut from `feature/onboarding-hardware`, PR #3, because it builds on
the migrations 081-091 plan fields and the Resend, flag and admin conventions from that work).

## 1. What exists today (verified in code)

### Customer storefront and reservations
- `storefront/` (Next static export): `/store`, `/checkout`, `/orders`, `/account`. Reads the menu through the RPC
  `storefront_menu(location)` and reserves with `reserve_online_order(...)` (migrations 031, 033, 040, 050).
- Tables: `storefront_products` (location_id, barcode, is_visible, override_price), `online_orders`,
  `online_order_items`, `online_order_pickups` (append-only), `storefront_customers` (age verification fields).
- `reserve_online_order` hardcodes a 5% fee (`c_fee_rate`), computes tax on the subtotal and on the fee, and only works when
  `locations.stripe_onboarding_complete` is true. Stock = `inventory_cloud.quantity` minus open orders (`storefront_available`).
- `complete_online_pickup` already requires `id_checked = true`.
- `locations.is_storefront_enabled` gates public visibility (RLS) and `set_storefront_settings` refuses to enable it without
  Stripe Connect onboarding.

### Existing card charging for products (the rule you flagged)
- `supabase/functions/storefront-checkout` creates a Stripe PaymentIntent as a **Connect destination charge** to the shop's
  Stripe account (with `application_fee_amount`). `storefront/app/checkout/page.tsx` collects the card with Stripe Elements.
  `stripe-connect` (payout onboarding), `storefront-payment-webhook` and `stripe-webhook` support it.
- This is exactly "a card charged for vape/tobacco products through Stripe". It will **not be deleted**. It goes behind
  `STRIPE_PRODUCT_PAYMENTS_ENABLED` (default false), enforced server-side in `storefront-checkout` (returns
  `product_payments_disabled`), with the Stripe Elements UI hidden when off. It will be listed in the final report.

### Staff, permissions, sign-in
- `employees_cloud` (uid, tenant_id, username, role admin|manager|cashier, password_hash, must_change_password).
- `employee_permissions_cloud` (employee_uid, `permission_key` text, `is_granted`): key is free text, so new
  `storefront.*` keys need **no schema change**.
- `permission_override_log_cloud`: append-only (trigger blocks update/delete), insert RLS requires tenant match.
- `staff-login` edge function: business key + username + password -> a 12-hour JWT with `kind: 'manager'`,
  `tenant_id`, `employee_uid`, no location claim. `is_manager()` only checks `kind = 'manager'`, so **today every
  manager-kind token has full tenant-wide power in RLS, and `role` and per-user permissions are not visible to the database.**
  Per-user storefront permissions therefore need a new database helper (`sf_can(key)`), not just UI hiding.

### The three host apps
- **Manager Portal** (`manager-portal/`): Electron, vanilla JS (`renderer/portal.js`), no bundler in the renderer. The
  main process holds the JWT and the renderer only sees IPC (`window.portal.*`). It already has a small "Storefront" tab
  (on/off per location, logo, listing).
- **Owner Console** (`owner-console/`): Electron, vanilla JS. It does **not** have a tenant JWT. It calls the `admin` edge
  function with `ADMIN_SECRET`, so RLS cannot identify a business for it. Business dropdown settings exist.
- **POS** (`src/`): Electron + SQLite. `src/main/ipc/storefront.ts` already has a queue of `online_orders`, advance
  and complete-pickup handlers.
- Reusable UI in `storefront/components/ui`: `Skeleton`, `Tooltip`. Design tokens: `storefront/tailwind.config.ts`.

### From the onboarding work (PR #3)
`licenses.plan_type` (`model_a` | `model_b`), `business_fee_settings` (online fee type/value copied from plan config),
`app_config.online_fee`, Resend wrapper, `platform_admins`, audit log, Pages Functions conventions, RLS test runner
(`npm run test:sql`, PGlite) and Playwright + mock-server setup.

## 2. Design principles
1. **Extend, do not rewrite.** The legacy tables and the Stripe flow stay; new tables are additive and reversible.
2. **One module, thin adapters.** `<StorefrontManager mode>` talks only to a `StorefrontApi` interface. Each host supplies
   an implementation, auth, location context and permissions.
3. **The database is the authority.** Permission toggles hide/disable UI, but RLS and RPCs enforce the same rules.
4. **No card path for products.** Pay-at-pickup is the only implemented payment mode. `PrepayProvider` throws `not_configured`.
5. Flags default off: `STRIPE_PRODUCT_PAYMENTS_ENABLED`, `PAYMENT_PROCESSOR_CONNECTED`, `SMS_ENABLED`, `STRIPE_LIVE_ENABLED`.

## 3. Architecture

### 3.1 Shared package `packages/storefront-admin`
- React 18 + TypeScript strict + Tailwind (same tokens). Exports `StorefrontManager({ mode: 'location' | 'business', ... })`,
  hooks (`useItems`, `useReservations`, `useSettings`, `useReports`, ...), and the `StorefrontApi` interface.
- Build targets: (a) an ES module for the standalone Next/Vite app, (b) a self-contained IIFE bundle + CSS
  (`storefront-admin.js`, `.css`) that the **vanilla Electron renderers load with a script tag** and mount via
  `window.RackdStorefront.mount(el, options)`. No React is added to the Electron apps themselves. A build step
  (`npm run build:storefront-admin`) is added to portal/console `prestart`/`dist` and to Pages.
- Host contract: `{ api: StorefrontApi, locations, activeLocationId, permissions, session, onToast, onLockRequest }`.

### 3.2 Data access (`StorefrontApi`)
Implemented once on Supabase (`createSupabaseApi(client)`), with realtime via `postgres_changes`.
- **Standalone and Manager Portal:** the tenant JWT from `staff-login`. The Portal main process exposes it to its renderer
  through a preload method (`portal.getStorefrontToken()`); it is held in memory only and expires in 12 h like today.
- **Owner Console:** a new `admin` edge function action `mintOwnerToken {tenant_id}` signs a short-lived (1 h) JWT with
  `kind: 'owner'`, `tenant_id`, no location, using the same `JWT_SECRET` as `staff-login`. New helper `sf_is_owner()`
  grants full storefront rights for that tenant only. RLS therefore behaves identically in all three hosts. The console
  already trusts `ADMIN_SECRET`, so this does not widen access.

### 3.3 Inventory
```ts
interface InventorySource {
  mode: 'pos_sync' | 'curated';
  list(locationId): Promise<StorefrontItem[]>;
  canEdit(field: 'name'|'price'|'qty'|'status'|...): boolean;
  add?(...): Promise<...>; // pos: "Add from my POS" picker; curated: free-form
}
```
- `PosInventorySource`: items are `storefront_items` with `source='pos'`, `pos_product_id` = POS barcode. Name, price,
  quantity are **read from `inventory_cloud`** (live join in the menu view, so they sync automatically); only visibility
  (`status`), `sort_order` and category label are editable. Quantity-aware.
- `CuratedInventorySource`: fully editable, optional `qty` (null = unlimited).
- Per-location `inventory_mode` lives in `storefront_settings`.

### 3.4 Payments
```ts
interface PaymentProvider { id; label; enabled(cfg): boolean; /* reservation hooks */ }
PayAtPickupProvider   // default, implemented: records payment_status 'paid_at_register'
PrepayProvider        // stub: every method throws not_configured; UI shows it disabled with a tooltip
                      // until PAYMENT_PROCESSOR_CONNECTED=true (and a gateway is chosen)
```
The `reservations` RPCs never accept a card token. The legacy Stripe flow keeps using `online_orders` only.

### 3.5 Customer-facing contract (minimal storefront change)
- New RPC `storefront_menu_v2(location)`: items with status `available` (and `sold_out`, labelled), never `hidden`, plus
  a `paused/enabled` flag. Falls back to the legacy menu only for locations with no `storefront_items`.
- New RPC `create_reservation(location, items, notes)`: validates enabled/paused, hours cutoff, limits
  (`max_items_per_order`, `max_qty_per_item`), customer age flag (existing `storefront_customers` rules), per-customer rate
  limit, stock **with row locks** (last-unit race), snapshots fee type/value, returns the reservation. Default
  payment mode `pay_at_pickup`.
- Realtime: customer storefront subscribes to `storefront_items` changes for the location and re-fetches (target < 5 s).
- Emails (Resend): shop on new reservation; customer on confirmed / ready / cancelled. Templates are editable constants.

## 4. Data model (additive migrations 092+)

New tables (all RLS, tests, down scripts): `storefront_settings`, `storefront_items`, `reservations`, `reservation_items`,
`reservation_events`, `fee_ledger`, `fee_statements`, plus `business_storefront_defaults` (business-level defaults and
fee override/waiver). Field lists follow your spec. Notes on choices:

| Topic | Decision |
|---|---|
| Relation to `online_orders` | `reservations` is a **new** table. `online_orders` stays for the dormant card flow and history. The POS Pickups tab reads `reservations`. |
| Relation to `storefront_products` | Backfilled once into `storefront_items(source='pos')` for locations that already use it. The legacy table is left in place. |
| Enable gate | New RPC `set_storefront_enabled` does **not** require Stripe onboarding when `payment_mode = pay_at_pickup`. It keeps `locations.is_storefront_enabled` in sync (`enabled AND NOT paused`) so the existing public-location RLS keeps working. |
| Fee snapshot | `fee_type` (`percent`\|`flat`), `fee_value`, `fee_amount` copied at creation; percent math rounds half-up to the cent on the subtotal. First-order waiver is evaluated at creation and recorded. |
| Fee source | business override -> `business_fee_settings` (from onboarding) -> `app_config.online_fee`. Placeholder default 5%. |
| Tax | Not computed on a reservation. Pay at pickup rings up normally at the register, where tax applies. The customer sees "tax added at the register". |
| Statements | `fee_statements` per business per `YYYY-MM`; PDF and CSV generated by a scheduled Pages Function and emailed. Stripe Invoice link only behind `STRIPE_LIVE_ENABLED`. |

### Permissions
New keys: `storefront.view`, `storefront.items.edit`, `storefront.orders.manage`, `storefront.settings.edit`,
`storefront.reports.view`, `storefront.fees.view`, stored in `employee_permissions_cloud`. A database function
`sf_can(key)` returns true for owner tokens and for `role = 'admin'`, otherwise checks the employee's granted row
(defaults, seeded when a manager is created: view, items.edit, orders.manage, reports.view on; settings.edit and fees.view off).
Every RLS policy and RPC on the new tables calls `sf_can`. Toggling a permission writes to
`permission_override_log_cloud` (new `event_type = 'storefront_permission'`).

### Scheduled jobs (Pages Functions, bearer `CRON_SECRET`, like permit reminders)
- Hold expiry (every 5 minutes): `expire_reservation_holds()` -> no-show/cancelled per `auto_cancel_no_show`, releases stock.
- Monthly statements (1st of the month): build, email, `dry_run=1` supported.

## 5. Storefront Manager features (module)
Dashboard, Items (filters, one-tap status chips, bulk select, drag reorder with keyboard alternative, duplicate, CSV import,
photo upload with client-side compression to the existing `product-images` bucket, optimistic updates with rollback toast),
Orders board (realtime columns, sound + visual alert after one "Enable alerts" tap, ID-checked checklist at pickup,
no-show, cancel with reason, item-unavailable replace/remove flow with recalculation), Settings (address and tax are
read-only, from the Owner Console; ID check locked on for tobacco/vape categories), Reports (with CSV export),
Fees & statements, Staff permissions (toggles). Multi-location switcher and roll-up in `mode='business'`.
WCAG AA, mobile-first, reuse `Skeleton` and `Tooltip`.

## 6. Mounting
1. **manage.r4ckd.net**: new small Next static app `manage/` (own Cloudflare Pages project) importing the package.
   Login reuses `staff-login` (see decision D2), plus a 5-minute idle PIN lock using the existing PIN hashes.
2. **Manager Portal**: new "Online Storefront" nav item mounting `mode='location'` (the current Storefront tab's toggles
   fold into it); location and permissions come from the signed-in session.
3. **Owner Console**: "Storefront" tab in the business settings: enable/disable, `inventory_mode` per location,
   fee override and waiver, allowed payment modes, all-location stats, force sold out / pause, ledger and statements, mark paid.
4. **POS (Model A)**: a "Pickups" tab listing today's reservations. Selecting one loads its items into a new sale
   (normal checkout, barcode scans, ID check) and stores `reservations.sale_id`. A reservation completed this way is an
   ordinary sale and is included in X/Z reconciliation; it is never labelled "Online - Prepaid".

## 7. Flags (all default false)
`STRIPE_PRODUCT_PAYMENTS_ENABLED` (new; gates the existing Stripe product charge), `PAYMENT_PROCESSOR_CONNECTED` (prepay
option), `SMS_ENABLED`, `STRIPE_LIVE_ENABLED` (statement invoice link only).

## 8. Tests
- SQL (PGlite): RLS across businesses, locations and roles (owner token, admin, manager with/without each key, cashier,
  customer, anon); the last-unit race (two reservations, one unit, serialized by row lock); hold expiry; fee snapshot math
  for percent (including half-cent rounding) and flat, waiver; statement totals; override log append-only.
- Unit: module logic, `InventorySource` implementations, CSV parser, optimistic rollback, fee math parity with SQL.
- Playwright (mock server): add 10 items, flip one to sold out (customer view updates), reservation alert and
  confirm -> ready -> picked up with the ID checklist, same behaviour in the standalone host and the Electron-style host
  harness, prepay shown disabled. Not runnable: the real Electron apps and real realtime against Supabase.

## 9. Milestones
1. This plan. 2. Migrations + RLS + SQL tests (settings, items, reservations, fees, statements, permissions, `sf_can`).
3. Customer contract (`storefront_menu_v2`, `create_reservation`, realtime, legacy gate `STRIPE_PRODUCT_PAYMENTS_ENABLED`, emails).
4. Shared package: api client, inventory sources, Items. 5. Orders board + alerts. 6. Dashboard, Settings, Reports, Fees.
7. Standalone `manage/` app + auth + PIN lock. 8. Manager Portal mount. 9. Owner Console mount + `mintOwnerToken`.
10. Jobs: hold expiry, monthly statements (PDF/CSV/email). 11. POS Pickups tab. 12. Playwright, README, final report.

## 10. Decisions needed (recommendations first)

- **D1. Fee timing.** Recommend the fee accrues to `fee_ledger` when a reservation is **picked up**, and is voided for
  cancelled and no-show reservations (the shop never completed the sale). Alternative: accrue at creation regardless.
- **D2. Standalone login.** Recommend reusing `staff-login` (business key remembered on the device, then email as
  username + password), so there is one sign-in model and one set of permissions. Alternative: new Supabase Auth
  accounts linked to employees (more moving parts, duplicate user management).
- **D3. Existing data.** Recommend leaving `online_orders`/`storefront_products` in place and backfilling
  `storefront_items` once; the old Stripe flow stays dormant behind the flag.
- **D4. Electron mounting.** Recommend bundling the module to a script for the vanilla renderers (no React inside the
  Electron apps), with the Portal handing its JWT to the renderer in memory.
- **D5. Default manager permissions** as listed in section 4.
- **Assumption.** The two Electron apps cannot be run or visually checked in this environment; their mounts are verified
  through a host-harness page and the module's own tests, and need a manual check on a real install before release.
