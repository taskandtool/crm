---
name: payments
description: "Takes money through the owner's own Stripe: Checkout for an order, a deposit or a paid booking, status from the verified webhook, refunds and tax rates. Use when a form or booking takes payment, for the Stripe key or webhook, or a refund. Not for quotes and invoices (invoices) or Task & Tool billing."
---

# Payments

Money goes through the owner's own Stripe account, by their connection.
Every payment is a row in `payments` naming what it pays for (`ref_type`,
`ref_id`), so every app reads the same rows.

Version: 0.3.0 (taskandtool/skills)

## The rules

- **Status comes only from the webhook.** A success redirect is a URL
  anyone can open, and arrives before a delayed payment settles: the thanks
  page says the payment is being confirmed. Only `webhook.ts` changes
  `status`, and never backwards.
- **The amount comes from the server** (the form's definition, the booking
  type, the invoice), never from the page. Money is minor units with a
  lowercase currency, through `money.ts`; never `* 100`, never two
  currencies added.
- **You never move money on your own.** A charge, a refund or a
  cancellation of a paid payment needs the owner's go-ahead in chat for
  that exact amount and payment. Never call the admin refund route yourself.
- **Test rows are not revenue.** `livemode = false` is test mode; reports
  and the CRM leave it out.
- **Changing `webhook.ts` or `checkout.ts`** keeps their guarantees (the
  raw-body signature, each event once, statuses only forward, an
  Idempotency-Key from the row's random key on every POST); `test/` checks
  each. Adding an event: `references/recipes.md`.

## Submissions, bookings and payments

How every app takes an order, a paid booking or an invoice:

```
submission (what they told us)   forms     submissions
   ^ submission_id
booking (when)                    booking   bookings
   ^ ref_type 'submission' | 'booking', ref_id
payment (money)                   payments  payments
```

- An order is never a new table: up to three rows, each in the table that
  owns it, linked from the later row to the earlier, with the person's
  email on each. "My orders" is a form's submissions. No skill writes another's
  table; showing them together is a read (forms `linked.ts`).
- Three ways to ask for money, all rows in `payments`:
  - **Pay now** on our page (an order, a paid booking, a deposit): a form's
    `payment` step (`form-step.tsx`), which opens Checkout with the form's
    lines and tax rate.
  - **Pay later** from an email (an invoice, a proposal's Pay button): a
    Stripe invoice, the invoices skill.
  - **A standing link** (a bio, a flyer): a one-page form with a `payment`
    step, at `/forms/<key>/start`; each click opens a fresh Checkout.
  Never make Stripe Payment Links: their payments name nothing here. A link
  the owner made in Stripe can sit on a page; tell the owner its payments
  will not show beside a form.
- **Every app that takes payments has its own webhook.** The Website and
  the CRM never know of each other, so each mounts `stripeWebhook` and gets
  its own Stripe endpoint and its own `STRIPE_WEBHOOK_SECRET`. An event both
  receive is applied once (`stripe_events`); one an app's skills do not
  handle is answered 200 and left for the app that does.

## The key and the webhook

The owner pastes a restricted key (`rk_…`) as a connection delivered to
the edge; ask with `python3 ~/tools/taskandtool.py request-connection
stripe --why "take payments" --auth api_key --delivery edge`. Call Stripe with `stripeFrom(envOf(c))`
in a route and `stripeFrom(process.env)` in a script: dev goes through the
gateway, production uses the key bound to its Worker. Making the key (its
permissions) and registering the webhook (its URL and events):
`references/setup.md`.

## Files

| File | What |
|---|---|
| `schema.sql` | `payments`, `stripe_events`, `tax_rates`, additive |
| `stripe.ts` | `stripeFrom(env)`: the caller, gateway or bound key; `StripeError` |
| `checkout.ts` | `startCheckout`: the pending row, then Checkout (one amount, or `lines`) |
| `form-step.tsx` | `paymentStep(getDb, stripeOf, { source })`: a form's payment step |
| `webhook.ts` | `stripeWebhook(getDb, { secret?, path?, more?, afterPaid? })`, `planEvent`, `applyEvent` |
| `tax.ts` | tax rates (never changed once made), `stripeTaxRate` (made in Stripe once per mode) |
| `money.ts` | minor units per currency, typed amounts, formatting |
| `admin.tsx` | `paymentsAdmin(getDb, { base, css, timeZone, Frame?, … })`: the list, a payment, CSV, a refund a team member confirms |
| `test/` | signatures, encoding, the webhook out of order, checkout, the payment step, admin, the deposit recipe |
| `references/setup.md` | when connecting Stripe or registering the webhook |
| `references/recipes.md` | a deposit on a booking page, payment status in SQL, a refund asked for in chat, adding an event |
