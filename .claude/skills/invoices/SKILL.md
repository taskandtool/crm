---
name: invoices
description: "Quotes, invoices and recurring invoices: quote this job, send or charge the invoice, bill every month, who owes us. Invoices are made in the owner's Stripe, emailed or charged to a saved card, paid only by its webhook. Use for a quote, proposal, deposit, invoice, recurring billing, a card on file or what a customer owes. Not for website payments (payments)."
---

# Invoices

A quote is ours: a document the team sends through the owner's sender
(`data/send.ts`), or, in an app that has its own page for it (the CRM's
proposals), a link the customer reads and accepts at. An invoice is Stripe's: made in the owner's Stripe
account (Stripe Invoicing), emailed by Stripe and paid on Stripe's hosted page, or charged to
the card the customer saved there. A recurring invoice makes ordinary invoices on its dates. All live in the project's tables, so every app reads
what a customer was quoted, owes and paid. Builds on `data`, `admin` and
`payments`.

Version: 0.5.0 (taskandtool/skills)

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
  one the customer opened shows as Viewed (`viewed_at`). A quote has no
  valid-until date unless one is set, and is never sent past it
  (`cannotSend`); an expired one is sent again once its date is moved or
  cleared. Invoices: a draft is ours; once
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
- **Charge a card only with the customer's agreement** to pay that way (a
  signed proposal that says so is that). `send --charge` and `charge`
  name the card; a refused charge leaves the invoice open with a task, and
  `email-page` emails them its page to pay or confirm (through the owner's
  sender: Stripe will not email a charged invoice). Which
  card is charged is the customer's first saved one until a person picks
  another; never change it quietly.
- **A recurring invoice** is a schedule plus lines (`scripts/recurring.mjs`):
  every n weeks, months or years from its first date (the 1st to the 28th
  for months and years), ending never, on a date or after n invoices. On
  each date it makes an ordinary invoice and, by its mode, leaves a draft
  with a task (`draft`, made `--ahead` days early: an amount that changes),
  emails it (`send`), or charges the saved card (`charge`, emailed while
  there is none). A period more than two days late is always a draft.
  Adding one, resuming or ending it waits for `--confirm`, as sending does.
  It runs only through the app's daily "Recurring invoices" scheduled job:
  set it up once, at 06:00 in the business's zone (the app's skill has the
  command).
- **Never delete.** A draft invoice is discarded (void); a sent one is
  voided in Stripe.
- **Money** is minor units per currency (`payments/money.ts`), one figure
  per currency, and test mode (`livemode = false`) is never money owed or
  earned.

## Keys and the webhook

Invoices use the payments skill's Stripe key and webhook (its
`references/setup.md` lists the key's permissions and the invoice events):
`app.route("/", stripeWebhook(getDb, { more: [invoiceEvents, cardEvents] }))`. A paid
invoice also writes a `payments` row (`kind = 'invoice'`), so refunds and
revenue work as for any payment.

## Files

| File | What |
|---|---|
| `schema.sql` | `quotes`, `quote_lines`, `invoices`, `invoice_lines`, `recurring_invoices`, `recurring_invoice_lines`, `stripe_customers`, `stripe_cards`. Apply the payments schema first (its `tax_rates`) |
| `lines.ts` | Reading typed lines; the line and total SQL |
| `quotes.ts` | A quote's life: create, save until decided, copy, sent, viewed, accepted, declined, expired |
| `invoices.ts` | An invoice's life before Stripe: create, save a draft, from an accepted quote (all, a deposit, the rest), discard; `owed(db, email)` |
| `document.tsx` | A quote or invoice as HTML on one sheet (previews, a quote's PDF); `sendQuote`, with a link or without |
| `stripe.ts` | `sendInvoice` (safe to repeat; emailed, or `collect: "charge"`), `chargeInvoice`, `emailPaymentPage`, `recordPayment` and `paidSoFar`, `voidInvoice`, `markUncollectible` |
| `cards.ts` | Saved cards: `cardEvents` for the webhook, `cardsFor`, `chargeCard` (read fresh from Stripe), `useCard`, `removeCard` |
| `recurring.ts` | A recurring invoice's life and dates; `runRecurring` (the daily job's), `makeNow`, `startFromQuote` and `endForQuote` (a proposal's "Then, recurring"), the sentences |
| `cli.ts` | `quotesCli`, `invoicesCli`, `recurringCli`: what the app's `scripts/quotes.mjs`, `invoices.mjs` and `recurring.mjs` run |
| `webhook.ts` | `invoiceEvents` for the payments webhook |
| `form.tsx` | The form parts every document shares: customer, line items |
| `recurring-admin.tsx` | The Recurring tab and a recurring invoice's page (mounted by `invoicesAdmin`); `CardsOnFile` and `RecurringLines` for a customer's page |
| `admin.tsx` | `invoicesAdmin(getDb, { base, css, source, timeZone, business, word?, proposal?, Frame?, send?, print?, stripe?, links?, afterDecide?, afterSend?, customerHref? })`: the team's pages, opening on what is outstanding, past due and paid this month. `proposal` (`ProposalHooks`) makes a quote the app's own page at a link |
| `test/` | Against a scratch database, Stripe faked, events out of order |
