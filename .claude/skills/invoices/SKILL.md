---
name: invoices
description: "Quotes and invoices: quote this job, send the invoice, who owes us. Quotes go through the owner's email sender; invoices are made, emailed and collected by their Stripe, paid only by its webhook. Use for a quote, estimate, invoice, Pay button or what a customer owes. Not for website payments (payments)."
---

# Invoices

A quote is ours: a document the team sends through the owner's sender
(`data/send.ts`). An invoice is Stripe's: made in the owner's Stripe
account (Stripe Invoicing), emailed by Stripe, paid on Stripe's hosted page. Both live in the project's tables, so every app reads
what a customer was quoted, owes and paid. Builds on `data`, `admin` and
`payments`.

Version: 0.2.2 (taskandtool/skills)

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

Invoices use the payments skill's Stripe key and webhook (its
`references/setup.md` lists the key's permissions and the invoice events):
`app.route("/", stripeWebhook(getDb, { more: [invoiceEvents] }))`. A paid
invoice also writes a `payments` row (`kind = 'invoice'`), so refunds and
revenue work as for any payment.

## Files

| File | What |
|---|---|
| `schema.sql` | `quotes`, `quote_lines`, `invoices`, `invoice_lines`, `stripe_customers`. Apply the payments schema first (its `tax_rates`) |
| `lines.ts` | Reading typed lines; the line and total SQL |
| `quotes.ts` | A quote's life: create, save a draft, copy, sent, accepted, declined, expired |
| `invoices.ts` | An invoice's life before Stripe: create, save a draft, from an accepted quote, discard; `owed(db, email)` |
| `document.tsx` | A quote or invoice as HTML on one sheet (previews, a quote's PDF); `sendQuote` |
| `stripe.ts` | `sendInvoice` (safe to repeat), `payLinkForQuote`, `markPaidOutOfBand`, `voidInvoice`, `markUncollectible` |
| `cli.ts` | `quotesCli`, `invoicesCli`: what the app's `scripts/quotes.mjs` and `scripts/invoices.mjs` run |
| `webhook.ts` | `invoiceEvents` for the payments webhook |
| `admin.tsx` | `invoicesAdmin(getDb, { base, css, source, timeZone, business, Frame?, send?, print?, stripe?, links?, afterDecide?, afterSend? })`: the team's pages, opening on what is outstanding, past due and paid this month |
| `test/` | Against a scratch database, Stripe faked, events out of order |
