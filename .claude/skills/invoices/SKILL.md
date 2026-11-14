---
name: invoices
description: "Makes quotes, invoices and recurring invoices with the owner's Stripe: quote this job, send or charge the invoice, bill every month, she paid cash, who owes us. Use for a quote, proposal, estimate, invoice, deposit, recurring billing, a card on file or what a customer owes. Not for payment on a form or booking (payments)."
---

# Invoices

A quote is ours. It goes by email through the owner's sender
(`data/send.ts`). Where the app has a page for quotes (the CRM's proposals),
the customer gets a link and accepts the quote there. An invoice is
Stripe's. It is made in the owner's Stripe account and emailed by Stripe.
The customer pays on Stripe's hosted page, or the invoice is charged to a
card they saved there. Quotes, invoices and payments are rows in the
project's tables, and every app can read what a customer was quoted, owes
and paid. This skill builds on `data`, `admin` and `payments`; the payments
skill's rules on money and test mode apply here.

From chat, use the app's `scripts/quotes.mjs`, `invoices.mjs` and
`recurring.mjs` for everything below (`--help` on each).

## The rules

- **A request from the owner is the go-ahead.** "Send Ann the invoice",
  "void #12": run it with `--confirm`, then say what went to whom. When you
  suggested it, or which item or amount is meant is unclear, run it without
  `--confirm` (it prints exactly what would happen), show that, and wait.
  Every command that reaches a customer or moves money waits for
  `--confirm`.
- **Charge a card only with the customer's agreement** to pay that way (a
  signed proposal that says so counts). The card charged is their first
  saved one, until a person picks another on the customer's page or the
  owner sets a default in Stripe. A refused charge leaves the invoice open.
  Stripe will not email an invoice it charges. Run `email-page` to send them
  its page through the owner's sender; they pay or confirm there.
- **Totals come from the lines** (`lines.ts`, on every save): never write a
  total.
- **Quotes** go from draft to sent, then to accepted, declined or
  expired. A person sets the outcome, or the customer does at the quote's
  link (`decided_by` "signed online" or "declined online"). A sent quote
  the customer opened shows as Viewed. A quote can be edited until it is
  accepted or declined; after that it can only be copied. It has no
  valid-until date unless one is set, and is never sent past that date. To
  send an expired one again, move or clear the date.
- **Invoices** are ours while draft. Once one is sent, the statuses open,
  paid, void and uncollectible come only from the verified webhook
  (`webhook.ts`). After `void` or `uncollectible`, the status changes when
  Stripe's event arrives a few seconds later. Nothing is deleted: `discard`
  a draft (kept as void) and `void` a sent one.
- **Paid another way** (cash, a check, a transfer), all or part:
  `record-payment` saves it in Stripe as a payment record on the invoice
  and here as a `payments` row. It charges nothing. The invoice stays open
  until nothing is owed.
- **Invoices on a quote.** Before the customer accepts, the owner can put
  invoices on the quote for a deposit or the whole amount (`invoices.mjs add
  <who> --quote <id>`; `recurring.mjs add <who> --quote <id>` for one that
  repeats). Accepting sends them and starts the recurring ones; declining
  discards them. After the quote is accepted, `from-quote <id>` bills all of
  it while it has no invoice, and `from-quote <id> --rest` bills what is not
  billed yet. On the pages: New invoice (One invoice or Repeats), and Make
  it repeat on a draft.
- **A recurring invoice**: on each date, an ordinary invoice is made from it. By
  its mode, that invoice is left as a draft with a task, emailed, or
  charged to the saved card. A date found more than two days late is left
  as a draft with a task, whatever the mode. Nothing is made without the
  app's daily "Recurring invoices" scheduled job. Set it up once (the app's
  skill has the `schedule-job --route` line).

## Keys and the webhook

Invoices use the payments skill's Stripe key and webhook (its
`references/setup.md` lists the key's permissions, the invoice and card
events, and the three Stripe settings charging needs):
`app.route("/", stripeWebhook(getDb, { more: [invoiceEvents, cardEvents] }))`.
A paid invoice also gets a `payments` row (`kind = 'invoice'`). Refunds
and revenue then work as for any payment.

## Files

| File | What |
|---|---|
| `schema.sql` | `quotes`, `quote_lines`, `invoices`, `invoice_lines`, `recurring_invoices`, `recurring_invoice_lines`, `stripe_customers`, `stripe_cards`. Apply the payments schema first (its `tax_rates`) |
| `lines.ts` | Reading typed lines; the line and total SQL |
| `quotes.ts` | A quote's life: create, save until decided, copy, sent, viewed, accepted, declined, expired |
| `invoices.ts` | An invoice's life before Stripe: create, save a draft, from an accepted quote (all, the rest), on a quote before its yes (`attachInvoice`), discard; `owed(db, email)` |
| `document.tsx` | A quote or invoice as HTML on one sheet (previews, a quote's PDF); `sendQuote`, with a link or without |
| `stripe.ts` | `sendInvoice` (safe to repeat; emailed, or `collect: "charge"`), `chargeInvoice`, `emailPaymentPage`, `recordPayment` and `paidSoFar`, `voidInvoice`, `markUncollectible` |
| `cards.ts` | Saved cards: `cardEvents` for the webhook, `cardsFor`, `chargeCard` (read fresh from Stripe), `useCard`, `removeCard` |
| `recurring.ts` | A recurring invoice's life and dates; `runRecurring` (the daily job's), `makeNow`, `startFromQuote` and `endForQuote` (one on a quote), the sentences |
| `cli.ts` | `quotesCli`, `invoicesCli`, `recurringCli`: what the app's `scripts/quotes.mjs`, `invoices.mjs` and `recurring.mjs` run |
| `webhook.ts` | `invoiceEvents` for the payments webhook |
| `form.tsx` | The form parts every document shares: customer, line items, One invoice or Repeats |
| `recurring-admin.tsx` | The Recurring tab and a recurring invoice's page (mounted by `invoicesAdmin`); `CardsOnFile` and `RecurringLines` for a customer's page |
| `admin.tsx` | `invoicesAdmin(getDb, { base, css, source, timeZone, proposal?, … })`: the team's pages, opening on what is outstanding, past due and paid this month. `proposal` (`ProposalHooks`) gives a quote the app's own page at a link |
| `test/` | Against a scratch database, Stripe faked, events out of order |
