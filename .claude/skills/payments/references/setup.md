# Connecting Stripe, and the webhook

Read when the owner connects Stripe, when payments are switched on in an
app, or when the webhook is registered or moved.

## The key

A restricted key only (`rk_…`); a full secret key (`sk_…`) is refused. A
test-mode key first. The owner makes it in Stripe, Developers, API keys, as
"Providing this key to a third-party application" (Task & Tool is the third
party; never "an AI agent"), named for Task & Tool, with these permissions
and nothing else:

| Resource | Access | Why |
|---|---|---|
| Checkout Sessions | Write | orders, deposits, paid bookings |
| Refunds | Write | the private payments page |
| Tax Rates | Write | tax on checkout and invoice lines |
| Customers | Write | invoices (the invoices skill) |
| Invoices | Write | invoices: make, finalize, send, charge, void |
| Payment Methods | Write | invoices: the cards a customer saved, and removing one |
| Payment Records | Write | a payment recorded by hand on an invoice (cash, a check, a transfer), all or part |
| Payment Intents | Read | an invoice's payment, for refunds |
| Balance | Read | Task & Tool checks a pasted key by reading it |

Without invoices, the first three and Balance are enough. Ask with
`python3 ~/tools/taskandtool.py request-connection stripe --why "take
payments" --auth api_key --delivery edge` and give the owner its review
link.

One grant delivered to the edge serves both: dev (the machine) never holds
the key and calls through the gateway; production has it bound into its
Worker under the connection's `env_name` (`STRIPE_API_KEY` for slug
`stripe`; read it in `python3 ~/tools/taskandtool.py list-connections`) and calls Stripe directly. For
another slug: `stripeFrom(envOf(c), fetch, "stripe-eu")`.

## The webhook

1. Mount it at the root of every app that takes payments:
   `app.route("/", stripeWebhook(getDb, { afterPaid }))`, where `afterPaid`
   completes a form that ends in payment (forms' `completePaidSubmission`)
   and confirms its booking (booking's `confirm.ts` header has the lines),
   with `more: [invoiceEvents]` where the invoices skill is carried. It
   answers POST `/hooks/stripe` and reads `STRIPE_WEBHOOK_SECRET`. In a
   team-only app, mount it before the team gate: Stripe has no sign-in, only
   the signature.
2. Its URL. A public production site: `https://<production host>/hooks/stripe`
   (the machine stays asleep). Otherwise (team only, or not deployed):
   `python3 ~/tools/taskandtool.py inbound-url /hooks/stripe`, which reaches
   the machine asleep or not.
3. The owner adds the endpoint in Stripe, Developers, Webhooks, with these
   events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `charge.refunded`, `payment_intent.payment_failed`, and with invoices
   `invoice.finalized`, `invoice.paid`, `invoice_payment.paid`,
   `invoice.payment_failed`, `invoice.voided`,
   `invoice.marked_uncollectible`, `invoice.deleted`, and for saved cards
   `payment_method.attached`, `payment_method.detached`, `customer.updated`.
   An app without invoices registers only the first six. Never
   `invoice.created`: Stripe holds automatic charges for up to 72 hours
   when an endpoint does not answer it.
4. The owner copies the endpoint's signing secret (`whsec_…`) into the form from
   `python3 ~/tools/taskandtool.py request-secret STRIPE_WEBHOOK_SECRET`; then
   `python3 ~/tools/taskandtool.py restart`. Test and live mode are separate
   endpoints with separate secrets. After an inbound URL rotation, change
   the URL in Stripe too.

## Charging a saved card (invoices)

A card is saved on the Stripe customer when they pay an invoice on
Stripe's page; the invoices skill charges it by name. The owner turns
these on in Stripe:

| Setting | Where in Stripe | Why |
|---|---|---|
| Save customer payment information: Offer or Always | Settings, Billing, Invoices, Default payment terms | cards saved from Stripe's invoice page |
| One-time invoice retries | Settings, Billing, Invoices, Advanced invoicing features | Stripe retries a refused charge |
| Successful payments | Settings, Emails | a receipt for a charged invoice; Stripe sends none without it |

Stripe's "card payment failed" and "confirm your payment" emails are for
subscriptions, and Stripe will not email the page of an invoice it charges.
A refused charge here makes a task, and `invoices.mjs email-page <id>`
emails the customer the invoice's payment page through the owner's own
sender (Resend or Postmark); with none, it prints the link to pass on.
