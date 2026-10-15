# Forms, quotes and invoices in the CRM

Read when setting up quotes and invoices, connecting Stripe or an email sender for them, or working with forms here.

## Forms

Under Settings, Forms: every submission from the project's forms, filtered by form
("my orders" is the order form's), each with the booking and payment it led
to, the ones someone started and did not finish, and the form editor. Each
form says whether its submissions are leads (on, off for a newsletter).
People fill in the forms on the Website; this CRM
shows and edits them. The `forms` skill has the field types (steps, things to buy, a booking step,
a payment step); the `payments` skill's "Submissions, bookings and payments"
says how the three link.

## Quotes and invoices

Under Invoices: the tabs Quotes, Invoices and Payments, and a Tax rates
page. `invoices.quote_word` names a quote everywhere: Quote,
Proposal or Estimate.

**A quote is a proposal page**: designed components in their order, the
quote's own (cover, its message as A note for them, pricing, terms) and the
business's (About us, How we'll do it, a full photograph, Our work, Our team,
Reviews, Clients, Questions). The team ticks them by name on the quote's
page; you tick them with `node scripts/quotes.mjs proposal <id> --components
about,reviews` (no flag: what it has). A quote's own words for this customer
go in its message (`--notes`).

**A component is its file** in `src/proposals/components/`: its design and
its words written in, registered in `index.ts`. It starts with sample words
(`sample: true`, and Send says so while one is ticked). Make it the
business's from the brand record: `node scripts/proposal-read.mjs <their
site>` reads their site (homepage, menu, gallery, reviews, about, team) and, when the app has the
connection, their Google listing (rating, its count, named reviews); the
`brand` skill turns those into `brand/` (look, logo, photographs in
`brand/images/`) and `public/` (business, services, team, proof). Write
every component from those notes, verbatim for reviews, never invented, then
set `sample: false`: a job with no stated result still has its photograph,
its place and what was done. A figure, a bio or a rating only where a source
states it; what none gives is simply left out. Where two sources disagree,
use the business's newest own page. The reply says what went in: no list of
what is missing, conflicts, or what the owner could add. Photographs are `photo("brand/images/<file>")`, built into
the page: `node scripts/proposal-photo.mjs <file>` puts one there at page
size, `--crop` cutting off a logo or a frame laid on it. Change a component's look, add one (a file and a line in
`index.ts`) or remove one when asked. The look as a whole is
`styles/proposal.css`: its tokens from `brand/visual-identity.md`, its fonts
by `node scripts/proposal-font.mjs "<Family>" --for display|body`. After any change: `npm run css`, `npm run check`,
then `node scripts/proposal-preview.mjs` and read the desktop images it names. The page runs no script and loads nothing: keep it so.

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

An invoice is made in the owner's Stripe account: Stripe emails it and
hosts the page the customer pays on. Paid, void and uncollectible arrive
from Stripe's webhook; "Record payment" is for cash, a check or a transfer, all of it or part
(`invoices.mjs record-payment`). A quote can make
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
