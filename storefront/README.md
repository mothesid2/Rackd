# rackd storefront

Customer-facing online store (Next.js App Router). Browse a participating shop's
live menu, verify 21+, pay with Stripe, pick up in store. Talks to the **same
Supabase backend** as the POS.

## Run
```bash
cd storefront
cp .env.example .env.local     # fill NEXT_PUBLIC_SUPABASE_ANON_KEY + NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
npm install
npm run dev                    # http://localhost:3000
```

## Env
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — same RackD project as the POS (anon key is RLS-protected).
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe publishable (pk_...) key.

## Backend it depends on (already built)
- Migrations 031–033 (storefront schema, tax, `storefront_menu` RPC).
- Edge functions: `storefront-checkout`, `storefront-payment-webhook`, `persona-start`, `persona-webhook`, `storefront-order-ready`.
- **Supabase Auth** enabled with email magic-link.

## Flow
`/` pick store → `/store/[id]` menu (polls `storefront_menu` for near-real-time stock) + cart →
`/account` magic-link sign-in + Persona age check → `/checkout` reserve (age-gate + oversell) →
Stripe Payment Element → `/orders` history. Age + oversell are enforced **server-side** in
`reserve_online_order` — the UI only reflects it.

## Deploy
Vercel (or any Next.js host). Set the three `NEXT_PUBLIC_*` env vars in the host.
