---
name: invoices
description: "Quotes and invoices: quote this job, send the invoice, who owes us. Quotes go through the owner's email sender; invoices are made, emailed and collected by their Stripe, paid only by its webhook. Use for a quote, estimate, invoice, Pay button or what a customer owes. Not for website payments (payments)."
---

# Invoices

A quote is ours: a document the team sends through the owner's sender
(`data/send.ts`). An invoice is Stripe's: made in the owner's Stripe
account (Stripe Invoicing), emailed by Stripe, paid on Stripe's hosted page
(the page lasts 30 days past the due date, at most 120, then offers to resend). Both live in the project's tables, so every app reads
what a customer was quoted, owes and paid. Builds on `data`, `admin` and
`payments`.

Version: 0.1.0 (taskandtool/skills)

## The rules

- **The owner asking for it is the yes**: "send Ann the invoice", "void
  #12" is run with `--confirm`, then say what went to whom. When you
  suggested it, or it is unclear which item or amount is meant, run
  it without `--confirm` (the CRM's `scripts/quotes.mjs` and
  `scripts/invoices.mjs` print exactly what would happen), show that, and
  wait. This covers sending a quote or invoice, marking paid, voiding and
  writing off (`uncollectible`).
- **Totals come from the lines, in SQL** (`lines.ts`): amount is quantity x
  price rounded, tax per line, the document's totals summed on every save.
  Never write a total.
- **Statuses only move forward.** Quotes: draft, sent, then accepted,
  declined or expired, set by a person. Invoices: a draft is ours; once
  sent it is Stripe's, and open, paid, void and uncollectible arrive only
  from the verified webhook (`webhook.ts`). Mark paid, void and
  uncollectible ask Stripe and wait for its event.
- **Never delete.** A sent quote is copied, not edited; a draft invoice is
  discarded (void); a sent one is voided in Stripe.
- **A proposal's Pay button** (`send --pay`, or the box on the send page):
  the quote's invoice is made in Stripe without Stripe's email, the quote
  carries its payment page, and paying it accepts the quote.
- **Money** is minor units per currency (`payments/money.ts`), one figure
  per currency, and test mode (`livemode = false`) is never money owed or
  earned.

## Keys and the webhook

Invoices use the payments skill's Stripe connection (the key's
permissions, Customers, Invoices and Tax Rates among them, are in its
`references/setup.md`) and its endpoint. Mount the endpoint with this skill's events:

```ts
app.route("/", stripeWebhook(getDb, { more: [invoiceEvents] }));
```

A team-only app (the CRM) mounts it before the team gate: Stripe has no
sign-in, only the signature. The owner adds the invoice events to the
endpoint (step 3 of "The webhook" in the payments skill's `references/setup.md`). A paid invoice also writes a
`payments` row (`kind = 'invoice'`) with its payment intent, so refunds and
revenue work as for any payment.

## Files

- `schema.sql`: `quotes`, `quote_lines`, `invoices`, `invoice_lines`,
  `stripe_customers`. Apply the payments schema first (its `tax_rates`).
- `lines.ts`: reading typed lines, the line and total SQL (tax rates are
  the payments skill's `tax.ts`).
- `quotes.ts`: create, save (a draft only), copy, sent, accepted, declined,
  expired; numbers `Q-0001`.
- `invoices.ts`: create, save (a draft not yet in Stripe), from an accepted
  quote (once), discard, `owed(db, email)`.
- `document.tsx`: a quote as HTML (the preview, and the PDF through
  `reports/print.ts` where a browser exists) and as an email that stands
  without the PDF; `sendQuote`.
- `stripe.ts`: `sendInvoice` (customer, tax rates, invoice, items,
  finalize, send; safe to repeat), `payLinkForQuote`, `markPaidOutOfBand`,
  `voidInvoice`, `markUncollectible`.
- `cli.ts`: `quotesCli` and `invoicesCli`, what an app's
  `scripts/quotes.mjs` and `scripts/invoices.mjs` run with its settings.
- `webhook.ts`: `invoiceEvents` for the payments webhook.
- `admin.tsx`: `invoicesAdmin(getDb, { base, css, source, timeZone,
  business, Frame?, send?, print?, stripe?, quoteExtra?, invoiceExtra?,
  invoicesTop?, afterDecide?, afterSend? })`, the team's pages; every change is a POST from a page
  that says what will happen.
- `test/`: against a scratch database, Stripe faked, events out of order.
