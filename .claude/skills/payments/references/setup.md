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
| Invoices | Write | invoices: make, finalize, send, pay out of band, void |
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
   team-only app, mount it before the team gate: Stripe signs in with the
   signature alone. Each app is its own endpoint in Stripe; never point one
   app at another's.
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
   `invoice.marked_uncollectible`, `invoice.deleted`.
   An app without invoices registers only the first six.
4. They copy its signing secret (`whsec_…`) into the form from
   `python3 ~/tools/taskandtool.py request-secret STRIPE_WEBHOOK_SECRET`, for this app alone (each
   endpoint has its own secret); then
   `sprite-env services restart web`. Test and live mode are separate
   endpoints with separate secrets. After an inbound URL rotation, change
   the URL in Stripe too.
