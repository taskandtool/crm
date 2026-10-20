---
name: invoices
description: "Quotes, invoices and recurring invoices in the owner's Stripe: quote this job, send or charge the invoice, bill every month, she paid cash, who owes us. Use for a quote, proposal, estimate, invoice, deposit, recurring billing, a card on file or what a customer owes. Not for payment on a form or booking (payments)."
---

# Invoices

A quote is ours: emailed through the owner's sender (`data/send.ts`), or,
where the app has a page for it (the CRM's proposals), a link the customer
accepts at. An invoice is Stripe's: made in the owner's Stripe account,
emailed by Stripe and paid on its hosted page, or charged to a card the
customer saved there. Quotes, invoices and payments are rows in the
project's tables, so every app reads what a customer was quoted, owes and
paid. Builds on `data`, `admin` and `payments`; the payments skill's rules
on money and test mode hold here.

From chat, the app's `scripts/quotes.mjs`, `invoices.mjs` and
`recurring.mjs` do everything below (`--help` on each).

Version: 0.5.0 (taskandtool/skills)

## The rules

- **The owner asking is the yes.** "Send Ann the invoice", "void #12": run
  it with `--confirm`, then say what went to whom. When you suggested it,
  or which item or amount is meant is unclear, run it without `--confirm`
  (it prints exactly what would happen), show that, and wait. Every command
  that reaches a customer or moves money waits for `--confirm`.
- **Charge a card only with the customer's agreement** to pay that way (a
  signed proposal that says so is that). The card charged is their first
  saved one, until a person picks another on the customer's page or the
  owner sets a default in Stripe. A refused charge leaves the invoice open;
  `email-page` emails them its page to pay or confirm, through the owner's
  sender, since Stripe will not email an invoice it charges.
- **Totals come from the lines** (`lines.ts`, on every save): never write a
  total.
- **Quotes** go draft, sent, then accepted, declined or expired, set by a
  person or by the customer at its link (`decided_by` "signed online" or
  "declined online"); a sent one the customer opened shows as Viewed. A
  quote is edited until it is accepted or declined, then only copied. It
  has no valid-until date unless one is set, and is never sent past it:
  move or clear the date to send an expired one again.
- **Invoices** are ours while draft. Once sent, open, paid, void and
  uncollectible arrive only from the verified webhook (`webhook.ts`), so
  after `void` or `uncollectible` the status follows Stripe's event a few
  seconds later. Nothing is deleted: `discard` a draft (kept as void),
  `void` a sent one.
- **Paid another way** (cash, a check, a transfer), all or part:
  `record-payment` keeps it in Stripe as a payment record on the invoice
  and here as a `payments` row; it charges nothing, and the invoice stays
  open until nothing is owed.
- **Invoices on a quote.** Before the yes, the owner's own invoices go on
  the quote, a deposit or all of it (`invoices.mjs add <who> --quote <id>`;
  `recurring.mjs add <who> --quote <id>` for one that repeats). The yes
  sends them and starts the recurring ones; a no discards them. After the
  yes, `from-quote <id>` bills all of it while it has no invoice, `--rest`
  what is not billed yet. On the pages: New invoice (One invoice or
  Repeats), and Make it repeat on a draft.
- **A recurring invoice** makes an ordinary invoice on each date and, by
  its mode, leaves it as a draft with a task, emails it, or charges the
  saved card. A date found more than two days late is left as a draft with
  a task, whatever the mode. Nothing is made without the app's daily
  "Recurring invoices" scheduled job: set it up once (the app's skill has
  the command).

## Keys and the webhook

Invoices use the payments skill's Stripe key and webhook (its
`references/setup.md` lists the key's permissions, the invoice and card
events, and the three Stripe settings charging needs):
`app.route("/", stripeWebhook(getDb, { more: [invoiceEvents, cardEvents] }))`.
A paid invoice also writes a `payments` row (`kind = 'invoice'`), so
refunds and revenue work as for any payment.

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
| `admin.tsx` | `invoicesAdmin(getDb, { base, css, source, timeZone, proposal?, … })`: the team's pages, opening on what is outstanding, past due and paid this month. `proposal` (`ProposalHooks`) makes a quote the app's own page at a link |
| `test/` | Against a scratch database, Stripe faked, events out of order |
