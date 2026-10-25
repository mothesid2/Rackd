# Stripe setup for hardware orders (test mode)

Stripe is used only for Rackd's own hardware and software charges. Never route vape or tobacco product
payments through it. Confirm Stripe's restricted-business policy for Rackd before going live.

## Test mode (default)

1. Stripe dashboard, test mode: copy the secret key (`sk_test_...`).
2. Developers > Webhooks > Add endpoint:
   - URL: `https://r4ckd.net/api/stripe/webhook` (or your Pages preview URL)
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`
   - Copy the signing secret (`whsec_...`).
3. Cloudflare Pages > Settings > Environment variables (secrets):
   - `STRIPE_SECRET_KEY=sk_test_...`
   - `STRIPE_WEBHOOK_SECRET=whsec_...`
   - leave `STRIPE_LIVE_ENABLED` unset or `false`
4. Place an order at `/hardware`, pay with card `4242 4242 4242 4242`, any future date, any CVC.
   The order page moves from "Confirming" to "Payment received" and the customer and
   `ADMIN_NOTIFY_EMAIL` get emails.

## Safety guards built in

- With `STRIPE_LIVE_ENABLED` not exactly `true`, only `sk_test_`/`rk_test_` keys work; a live key is refused
  (`stripe_mode_mismatch`). With it `true`, only live keys work.
- The webhook refuses events whose `livemode` does not match the flag, so a live event can never mark an
  order paid while the site is in test mode, and the database repeats that check.
- Webhook events are recorded by id; a duplicate delivery is acknowledged and not reprocessed. A failed
  attempt returns 500 so Stripe retries.
- Stock is decremented in the same database transaction that marks the order paid, once.

## Tax

`app_config.hardware_tax.mode`:
- `flat` (default): the flat percentage shown at checkout is charged as a "Sales tax" line.
- `stripe_tax`: enable Stripe Tax in the dashboard first. Tax is calculated by Stripe at payment and the
  order is updated with the amount actually charged.

## Replaying a webhook locally

`signStripePayload(rawBody, secret)` in `functions/_lib/stripe.ts` builds a valid `Stripe-Signature` header.
Or use `stripe listen --forward-to localhost:8788/api/stripe/webhook` with `wrangler pages dev out`.

## Not covered here

Mark shipped, tracking emails and refund notes in the admin console arrive with milestone 8. Refunds made in
the Stripe dashboard are picked up by the webhook (`charge.refunded`) and flip the order to `refunded`; stock
is not restocked automatically.
