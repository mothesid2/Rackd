# rackd Manager Portal

A separate desktop app for a **business owner/manager** to see and lightly manage
**all locations** of their business — reports, per-location X/Z, inventory, and
customers. It is **not a POS**: it never rings sales.

It talks to the same Supabase project as the POS. Sign-in uses a **manager code**
(a `kind='manager'` license), which the `jwt-issuer` turns into a **tenant-wide**
JWT (no `location_id`), so RLS scopes it to the whole business and lets it read
every location and push light edits down to the registers.

## Issue a manager code
In the POS **Owner Console → “+ Manager Code”**, pick the business and create a
code. Give that code to the manager; they enter it on the portal's sign-in screen.

## Run in development
```bash
cd manager-portal
npm install
npm start
```

## Build the installer
```bash
cd manager-portal
npm install           # once
npm run dist          # -> dist/Rackd-Manager-Portal-Setup-<version>.exe  (Windows, NSIS)
# npm run dist:mac    # -> dist/*.dmg  (build on a Mac)
```
The Windows build is **unsigned** (matches the POS build). To code-sign, add a
certificate and set the electron-builder signing env vars, or remove
`CSC_IDENTITY_AUTO_DISCOVERY=false` from the `dist` script.

## What it shows
- **Dashboard** — revenue / transactions / refunds per location + business totals;
  a “no sales in 24h” flag; click a store for its full X/Z report.
- **Inventory** — stock levels across every location (from the `inventory_cloud`
  reporting mirror), low stock highlighted.
- **Customers** — the shared customer book; edits (name/contact/points/gold) write
  to the cloud tagged `register_id='manager'` so **every register pulls the change
  down** on its next sync.

## Config
`config.js` holds the public Supabase URL + anon key (safe to ship; protected by
RLS). It mirrors `src/main/supabase/publicConfig.ts` in the POS app.
