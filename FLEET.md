# Rackd desktop fleet — build & run

Four desktop apps, each buildable as **Production** and **Demo** side-by-side (8 installers total). The Demo of an app installs alongside its Production copy — separate app icon, separate app data — and watermarks itself **DEMO**.

| App | Dir | Prod name / appId | Demo name / appId | Output |
|-----|-----|-------------------|-------------------|--------|
| Point of Sale | `.` (root) | Rackd POS · `com.rackd.pos` | Rackd POS (Demo) · `com.rackd.pos.demo` | `release/` |
| Manager Portal | `manager-portal/` | rackd Manager Portal · `com.rackd.manager` | …(Demo) · `com.rackd.manager.demo` | `dist/` |
| Owner Console | `owner-console/` | Rackd Owner Console · `com.rackd.owner` | …(Demo) · `com.rackd.owner.demo` | `dist/` |
| Storefront (wrapper) | `storefront-desktop/` | Rackd Storefront · `com.rackd.storefront` | …(Demo) · `com.rackd.storefront.demo` | `dist/` |

## One-time setup
Install deps in each app (the POS is the repo root):
```bash
npm install                         # POS (root)
cd manager-portal && npm install
cd ../owner-console && npm install
cd ../storefront-desktop && npm install
```

## Build
From the repo root:
```bash
npm run fleet:demo      # all 4 apps, Demo installers
npm run fleet:prod      # all 4 apps, Production installers
npm run fleet:all       # both variants of all 4 (8 installers)
```
Or one app at a time:
```bash
npm run desktop:prod                              # POS production
npm run desktop:demo                              # POS demo
node scripts/build-desktop.js manager-portal demo # any app + variant
```
Installers land in each app's output dir (`release/` for the POS, `dist/` for the others). Run each `*-Setup-*.exe` to install; Demo and Production coexist as separate apps.

## What "Demo" means (current: badge-only isolation)
A demo build:
- **Watermarks every screen with a red "DEMO" badge.**
- **Keeps its own local data** — Electron derives the data dir from the product name, so "Rackd POS (Demo)" never shares the production POS's SQLite/settings.
- Is flagged at build time via electron-builder `extraMetadata.rackdDemo=true`; the app reads that at startup (no separate source).

**Cloud isolation is opt-in and not yet active.** To point demo builds at a separate sandbox Supabase project (so demo sessions never touch real cloud data), set `SANDBOX_SUPABASE_URL` + `SANDBOX_SUPABASE_ANON_KEY` before building — the apps route all cloud traffic there when in demo mode. Until then, demos share the production project (the badge + separate local data are the only isolation).

## Storefront wrapper
The storefront is a **web** app (deployed to Cloudflare Pages). `storefront-desktop/` is a thin Electron shell that loads it in a phone-shaped window, mainly for demoing. Set the URLs in `storefront-desktop/config.js` after the web deploy:
- `PROD_URL` → production storefront
- `DEMO_URL` → preview/sandbox storefront

## Auto-update
Production POS + Manager Portal auto-update on launch from their per-app channels (`app-updates/pos|manager/production`). Demo builds set `publish: null` — they never auto-update from a production channel. Owner Console + Storefront wrapper are not on the auto-update trio.
