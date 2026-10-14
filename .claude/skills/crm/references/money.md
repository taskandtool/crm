# Forms, quotes and invoices in the CRM

Read when setting up quotes and invoices, connecting Stripe or an email sender for them, or working with forms here.

## Forms

Under Forms: every submission from the project's forms, filtered by form
("my orders" is the order form's), each with the booking and payment it led
to, the ones someone started and did not finish, and the form editor. Each
form says whether its submissions are leads (on, off for a newsletter).
People fill in the forms on the Website; this CRM
shows and edits them. The `forms` skill has the field types (steps, things to buy, a booking step,
a payment step); the `payments` skill's "Submissions, bookings and payments"
says how the three link.

## Quotes and invoices

Under Invoices: the tabs Quotes, Invoices, Payments and Quote sections, and a
Tax rates page. `invoices.quote_word` names a quote everywhere: Quote,
Proposal or Estimate.

**A quote is a proposal page** (`src/proposals/`): the lines plus the
sections ticked on it (summary, scope, timeline, team, testimonials, case
studies, about, questions, terms; cover, pricing and accept always). Each
section's standing words are in Quote sections, with the pictures; a quote
changes its own on "Edit the quote" (or `node scripts/quotes.mjs proposal
<id> --sections ... --text summary.heard="..."`). Write the summary and
scope from what the owner told you; fill the library from the Website's
facts when there is one. Placeholders: `{customer}`, `{business}`,
`{total}`, `{valid_until}`, `{number}`.

**Sending** gives a private link: emailed through the owner's sender, or
Copy link (`send <id> --link --confirm`). The customer opens it signed out,
types their name to accept, or declines with a reason. It stays editable
until then; the link always shows the current page, and a page changed
while they read is refused at Accept. "After they sign" on the quote makes
the first invoice: a draft, or sent through Stripe with Pay now (a deposit
is a percent). Mark accepted does the same, after saying so. Opens, the
signature and the decline show on the quote; signed and declined ring the
bell; the morning email lists ones opened, and a task comes 3 days before
one expires unsigned. Without a link (no production yet) it goes as a PDF
and they reply to accept.

**How it looks** is `styles/proposal.css` (its tokens; copy a Website's
`styles/theme.css` colours and fonts there when asked, fonts as WOFF2 in
`static/fonts/`) and `src/proposals/sections/<name>.tsx`. After a change:
`npm run css` (it compiles into `src/proposals/style.ts`), `npm run check`,
then Preview a quote. The page runs no script and loads nothing: keep it so.

An invoice is made in the owner's Stripe account: Stripe emails it and
hosts the page the customer pays on. Paid, void and uncollectible arrive
from Stripe's webhook; "Mark paid" is for cash or a check. A quote can make
several ("Invoice the rest"). A customer's page shows what was quoted, what
they owe now and what was paid; an event's page shows its quote and
invoice.

Set it up once, in this order:

1. The name in `invoices` (lever 1), and the tax rates (`node
   scripts/quotes.mjs tax-rate "Sales tax" 8.25`), when they charge tax.
2. Quotes need the email sender bookings use (the Messages paragraph of
   `references/schedule.md`).
3. Links need production: deploy (`npm run deploy`), then
   `python3 ~/tools/taskandtool.py request-public-path /q` and give the
   user its link, where they let customers open `/q`. The rest of
   production stays the team's.
4. Invoices need the owner's Stripe, set up by the `payments` skill's
   `references/setup.md`: a restricted test key first, with every
   permission listed there (refunds on the Payments page need Refunds).
   Add its webhook, with the invoice events, at the URL that
   `python3 ~/tools/taskandtool.py inbound-url /hooks/stripe` prints, and
   set the webhook's signing secret as `STRIPE_WEBHOOK_SECRET`. Stripe
   reaches the CRM at that URL, never at production's address. After the
   secret is set, `python3 ~/tools/taskandtool.py restart`.

The `invoices` skill has the rules, sending among them; `src/invoices/` is its code.
