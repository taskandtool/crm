---
name: invoices
description: "Quotes and invoices: quote this job, send the invoice, who owes us. Quotes go through the owner's email sender, or as the app's page at a link; invoices are made, emailed and collected by their Stripe, paid only by its webhook. Use for a quote, estimate, proposal, deposit, invoice or what a customer owes. Not for website payments (payments)."
---

# Invoices

A quote is ours: a document the team sends through the owner's sender
(`data/send.ts`), or, in an app that has its own page for it (the CRM's
proposals), a link the customer reads and accepts at. An invoice is Stripe's: made in the owner's Stripe
account (Stripe Invoicing), emailed by Stripe, paid on Stripe's hosted page. Both live in the project's tables, so every app reads
what a customer was quoted, owes and paid. Builds on `data`, `admin` and
`payments`.

Version: 0.4.0 (taskandtool/skills)

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
  declined or expired, set by a person or by the customer at its link
  (`decided_by` is `ONLINE`'s "signed online" or "declined online"); a sent
  one the customer opened shows as Viewed (`viewed_at`). Invoices: a draft is ours; once
  sent it is Stripe's, and open, paid, void and uncollectible arrive only
  from the verified webhook (`webhook.ts`). Void and uncollectible ask
  Stripe and wait for its event.
- **Paid another way, all or part** (cash, a check, a transfer):
  `recordPayment` is Stripe's payment record attached to the invoice and a
  payments row; the invoice stays open with less owed until nothing is left.
- **A quote is edited until it is accepted or declined**, sent or not;
  after that it is copied, never changed.
- **Invoices belong to the customer.** A quote makes as many as asked:
  `from-quote` all of it while it has none, `--deposit 50` a share of each
  tax rate's lines, `--rest` what is not billed yet. Never before the yes.
- **Never delete.** A draft invoice is discarded (void); a sent one is
  voided in Stripe.
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
| `quotes.ts` | A quote's life: create, save until decided, copy, sent, viewed, accepted, declined, expired |
| `invoices.ts` | An invoice's life before Stripe: create, save a draft, from an accepted quote (all, a deposit, the rest), discard; `owed(db, email)` |
| `document.tsx` | A quote or invoice as HTML on one sheet (previews, a quote's PDF); `sendQuote`, with a link or without |
| `stripe.ts` | `sendInvoice` (safe to repeat), `recordPayment` and `paidSoFar`, `voidInvoice`, `markUncollectible` |
| `cli.ts` | `quotesCli`, `invoicesCli`: what the app's `scripts/quotes.mjs` and `scripts/invoices.mjs` run |
| `webhook.ts` | `invoiceEvents` for the payments webhook |
| `admin.tsx` | `invoicesAdmin(getDb, { base, css, source, timeZone, business, word?, proposal?, Frame?, send?, print?, stripe?, links?, afterDecide?, afterSend? })`: the team's pages, opening on what is outstanding, past due and paid this month. `proposal` (`ProposalHooks`) makes a quote the app's own page at a link |
| `test/` | Against a scratch database, Stripe faked, events out of order |
