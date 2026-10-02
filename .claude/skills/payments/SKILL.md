---
name: payments
description: "Taking money through the owner's Stripe account: Checkout for deposits and full payments, payment status from the verified webhook, payments linked to a booking or invoice, and the private payments list. Use for any charge, deposit, refund or payment status. Not for this platform's own billing."
---

# Payments

Payments go through the owner's own Stripe account, by a connection. Every
payment is a row in `payments` that names what it pays for
(`ref_type`, `ref_id`), so the Booking app, the CRM and Quotes & Invoices all
read the same rows by email or by ref.

Version: 0.1.0 (taskandtool/skills)

## The rules

- **Status comes only from the webhook.** The success redirect is a URL
  anyone can open, and it arrives before a delayed payment settles. The
  thanks page says the payment is being confirmed and reads the row; nothing
  but `webhook.ts` changes `status`.
- **Verify the raw body.** The signature covers the exact bytes Stripe sent.
  Read `arrayBuffer()` before any JSON parsing; a body parsed and
  re-serialised never verifies. A bad signature is 400.
- **Each event once.** The event id goes into `stripe_events` in the
  same statement that applies it (`insert … on conflict do nothing`), so a
  redelivery, or the same event sent to a second app's endpoint, is a no-op.
- **Events arrive in any order. A status never moves backwards.** Each change
  names the statuses it may move from, in the SQL: a late
  `checkout.session.completed` after `charge.refunded` leaves the row
  refunded, and `refunded_cents` only rises.
- **Money is an integer in minor units** with a lowercase currency. Yen have
  no minor unit and Kuwaiti dinars have three: use `money.ts`, never `* 100`.
  The amount comes from the server (the booking's deposit, the invoice
  total), never from a form field the payer can edit.
- **Every POST carries an `Idempotency-Key`** derived from the row it is for
  (`checkout-<the row's match_key>`), so a retry never charges twice. Keys are
  per Stripe account and other projects may share the account, so never a
  bare row id. `stripe.ts` refuses a POST without one.
- **An event finds its row by Stripe ids, or by `payment_id` +
  `payment_key` + the refs in the metadata** while the row has no other id of
  that kind. Never by `client_reference_id`: a Payment Link takes it from its
  URL. A paid session marks the row paid only when its `amount_subtotal` and
  currency are the row's; keep that true if you add quantities.
- **You never move money on your own.** A refund, a cancellation of a paid
  payment, or any charge you start needs the owner's go-ahead in chat for
  that exact amount and payment. Never call the admin refund route yourself.
- **Test rows are not revenue.** `livemode = false` marks test-mode payments;
  reports and the CRM leave them out.

## Keys and where they live

The owner connects their own Stripe account by pasting a restricted key
(`rk_…`); a full secret key (`sk_…`) is refused. Ask with
`request_connection("stripe", why, auth="api_key", delivery="edge")` and give
the owner the `review_url`. Suggest a restricted key with Checkout Sessions
and Refunds set to write, and a test-mode key first.

`stripeFrom(envOf(c))` in a route, `stripeFrom(process.env)` in a script on
the machine; it finds the key or the gateway itself.

One grant with `delivery="edge"` serves both:

- **Dev** (the app on its machine) never holds the key: calls go through the
  gateway, which adds it.
- **Production** (the app on Cloudflare) has the key bound into its Worker
  under the connection's `env_name` (`STRIPE_API_KEY` for slug `stripe`) and
  calls Stripe directly, never through Task & Tool. Read the real name in
  `list_connections()` rather than assuming it; for another slug pass it,
  `stripeFrom(envOf(c), fetch, "stripe-eu")`.
- **The webhook signing secret** is an ordinary secret:
  `request_secret("STRIPE_WEBHOOK_SECRET")`. Dev reads it from its env, and
  production gets it as a Worker binding when the app is deployed.

## The webhook

1. Mount `stripeWebhook(getDb)` at the root (`app.route("/", …)`): it
   answers POST `/hooks/stripe` itself (`path` changes that) and reads
   `STRIPE_WEBHOOK_SECRET` (`secret` changes that).
2. Its URL. When production is public: the production site's own URL,
   `https://<production host>/hooks/stripe`; Stripe reaches the Worker
   directly and the machine stays asleep. Otherwise (production for the team
   only, or not deployed): `inbound_url("/hooks/stripe")` from
   `tools/taskandtool.py`, which reaches this machine published or not,
   asleep or not, with the path and body unchanged. Production for the team
   asks for a sign-in, which Stripe cannot do. Both write the same rows, so
   one endpoint per mode is enough.
3. The owner registers it in Stripe: Developers, Webhooks, Add endpoint, that
   URL, and these events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `charge.refunded`, `payment_intent.payment_failed`. Then they copy the
   endpoint's signing secret (`whsec_…`) into the form from
   `request_secret`. Test mode and live mode are separate endpoints with
   separate secrets; going live means a second endpoint and a new secret.
   After an inbound URL rotation, the endpoint URL changes in Stripe too.
4. One endpoint per project is enough: every app reads the same rows.

## Refunds from the private payments page

`admin.tsx` lets a signed-in team member refund. That is a person acting, not
the AI: the guard puts an identified team member behind every request, the
amount is confirmed on its own page (a GET never moves money), the
Idempotency-Key is the payment intent, the refunded total the page saw, and the
amount, so a double submit is one refund, and a refund recorded since the
page opened sends them back to check. `updated_by` records who. The row turns
refunded only when `charge.refunded` arrives. If the owner's restricted key
cannot refund, Stripe's message is shown as is.

When the owner asks you in chat to refund, say exactly what will happen
("refund $50.00 of payment 42 to ann@example.com") and wait for their yes;
then call `POST /v1/refunds` with `payment_intent`, `amount` and an
Idempotency-Key built as the admin route builds it.

## Recipes

**Take a deposit for a booking.** The booking skill makes the booking; this
skill takes the money, in `bookingPages`' `afterBook`, whose URL the booker
is sent to instead of the manage page (`test/deposit.test.ts`, which needs
the booking skill beside this one):

```ts
app.route("/book", bookingPages(getDb, {
  base: "/book", domain, css, source: "website",
  afterBook: async (c, e) => {
    const { url } = await startCheckout(getDb(c), stripeFrom(envOf(c)), {
      kind: "deposit", refType: "booking", refId: e.booking.id,
      amountCents: DEPOSIT_CENTS, currency: "usd", description: `Deposit for your time with ${e.resource.name}`,
      email: e.booking.email, name: e.booking.name, source: "website",
      successUrl: `${e.manageUrl}?new=1`, cancelUrl: `${e.manageUrl}?new=1`,
      expiresAt: new Date(Date.now() + 30 * 60_000),   // an unpaid hold frees after 30 minutes
    });
    return url;
  },
}));
```

Both ways back land on the booking's manage page, which shows the deposit's
status from `payments`. If Checkout cannot start, the booking stands
and the booker sees the manage page. The booking's own status is the booking
skill's; payments never writes to `bookings`. Whether an unpaid
booking holds its slot is the app's rule: read the deposit (below), and
treat an expired (`cancelled`) one as no deposit.

**Show payment status in the CRM, or on a booking.** Read, never copy:

```sql
-- the deposit for one booking: paid, or refunded, or nothing yet
select status, amount_cents, refunded_cents, currency, paid_at
from payments
where ref_type = 'booking' and ref_id = $1 and kind = 'deposit'
order by created_at desc limit 1;

-- what a person has paid, net of refunds, live money only
select currency, sum(amount_cents - refunded_cents) as net_cents
from payments
where email = $1 and status in ('paid', 'partially_refunded') and livemode is not false
group by currency;
```

Sum per currency; never add amounts in different currencies. To list one
booking's payments, link to `/admin/payments?ref_type=booking&ref_id=42`.

## Not handled

`charge.refund.updated` (a refund that later fails), disputes, subscriptions
and Stripe Invoices. Add an event to `planEvent` with the statuses it may
move from, and a test that sends it out of order.

## Files

- `schema.sql`: `payments` and `stripe_events`, additive.
- `stripe.ts`: `stripeFrom(env)`, the caller for dev and production (gateway or bound
  key), Stripe's nested form encoding, `StripeError`.
- Routes take `(getDb, opts)`: `stripeWebhook(getDb, { secret?, path? })`,
  `paymentsAdmin(getDb, { base, css, timeZone, nav?, pageSize?, stripe? })`.
- `checkout.ts`: `startCheckout`, the pending row, then the Checkout Session.
- `webhook.ts`: `stripeWebhook` (the route), `verifyStripeSignature`,
  `planEvent` (what each event may change), `applyEvent` (one statement).
- `money.ts`: minor units per currency, parsing typed amounts, formatting.
- `admin.tsx`: `paymentsAdmin`, the private list, detail, CSV export and
  confirmed refund, built on the admin skill's list, detail and status pieces.
- `test/`: signature vectors, form encoding, the webhook against a scratch
  database (dedupe, out of order), checkout, admin, and the deposit recipe.
  Copy them with the code (`deposit.test.ts` only with the booking skill).
