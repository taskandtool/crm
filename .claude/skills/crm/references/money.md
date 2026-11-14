# Forms, quotes and invoices in the CRM

Read when setting up quotes and invoices, connecting Stripe or an email sender for them, or working with forms here.

## Forms

Under Settings, Forms: every submission from the project's forms, filtered by form
("my orders" is the order form's), each with the booking and payment it led
to, the ones someone started and did not finish, and the form editor. Each
form has a setting for whether its submissions are leads: on, or off for a
newsletter. People fill in the forms on the Website; the team sees and
edits them here. The `forms` skill has the field types (steps, things to
buy, a booking step, a payment step). How the three link is in the
`payments` skill's "Submissions, bookings and payments".

## Quotes and invoices

Under Invoices: the tabs Invoices, Payments and Recurring (Quotes is a
section of its own), and a Tax rates page. `invoices.quote_word` names a quote everywhere: Quote,
Proposal or Estimate.

**A quote is a proposal page**: by default a plain quote (a plain head, its
message as a Letter, the price, its terms) and the components the team adds
(Cover photo, About us, How we'll do it, a full photograph, Our work, Our
team, Reviews, Clients, Questions). The team ticks them by name on the
quote's page; you tick them with `node scripts/quotes.mjs proposal <id> --components
about,reviews` (no flag: what it has). A quote's own words for this customer
go in its message (`--notes`).

**A component is one file** in `src/proposals/components/` that holds
its design and words. Each is registered in `index.ts`. It starts with
sample words and `sample: true`; while a sample component is ticked, Send
warns about it. Make each one the business's own from the brand record.
`tt-crawl brand <their site> --places` reads their site, and their Google
listing when the app has the `google-places` connection. With the `brand`
skill, turn those into `brand/` (look, logo, photographs in
`brand/images/`) and `public/` (business, services, team, proof). Write
every component from those notes (`references/proposal-writing.md`), then
set `sample: false`.

Photographs are `photo("brand/images/<file>")`, built into the page:
`python3 .claude/skills/brand/web_photos.py <file> --width 1600` puts one
there at page size; `--crop` cuts off a logo or a frame laid over it.
Change a component's look, add one (a file and a line in `index.ts`) or
remove one when asked. The whole page's look is in `styles/proposal.css`.
Its tokens come from `brand/visual-identity.md`; set its fonts with
`node scripts/proposal-font.mjs "<Family>"`. The page has no script and
loads no other file; keep it that way. After any change:
`npm run css`, `npm run check`, then `node scripts/proposal-sample.mjs`
and read the desktop images it names.

**Sending** makes a private link. Email it through the owner's sender, or
use Copy link (`send <id> --link --confirm`). The customer opens it signed
out, types their name to accept, or declines with a reason. The quote
stays editable until then. The link always opens the current page; if the
page changed while they were reading, their Accept is refused. When they
accept, the invoices the owner attached to the quote go out through Stripe
with Pay now on their copy. The quote's recurring invoices start too. When
they decline, those invoices are discarded. The owner writes those
invoices like any other (a deposit, all of it, anything):
`invoices.mjs add <who> --quote <id>` (the quote's lines unless `--line`
says otherwise), or New invoice on the quote's page (its Repeats makes a
recurring one). Mark accepted has the same effect, after showing what
accepting will do. The quote's page shows opens, the signature and any
decline, and a signature or decline also shows in the bell. The morning
email lists quotes that were opened. Its job makes a follow-up task when a
quote is still unsigned 3 days after sending (or 3 days before its
valid-until date). Without a link (no production yet), the email has the
lines and, where this server can make one, a PDF; the customer replies to
accept.

An invoice is made in the owner's Stripe account: Stripe emails it and
hosts the page the customer pays on. Paid, void and uncollectible arrive
from Stripe's webhook; "Record payment" is for cash, a check or a transfer, all of it or part
(`invoices.mjs record-payment`). One quote can have several invoices
("Invoice the rest"). A customer's page shows what was quoted, what
they owe now and what was paid, their recurring invoices and saved card; an
event's page shows its quote and invoice.

**Cards and recurring invoices.** A card is saved when the customer pays an
invoice on Stripe's page; Send then offers "Charge Visa 4242"
(`invoices.mjs send <id> --charge`). A recurring invoice
(`node scripts/recurring.mjs add <who> --name "Maintenance plan" --line "Care|300" --first 2026-11-01 --mode charge`)
makes an ordinary invoice on each date: a draft with a task, emailed, or
charged. On a quote, `--quote <id>` attaches it: the proposal shows it
beside the total, signing starts it, a decline ends it.

Set it up once, in this order:

1. The name in `invoices` (lever 1), and the tax rates (`node
   scripts/quotes.mjs tax-rate "Sales tax" 8.25`), when they charge tax.
2. Emailing a quote needs the owner's Resend or Postmark (the `data`
   skill's Email); Copy link needs no sender.
3. Links need production: deploy (`npm run deploy`), then
   `python3 ~/tools/taskandtool.py request-public-path /q` and give the
   owner the link it prints, where they let customers open `/q`. The rest
   of production stays the team's.
4. Invoices need the owner's Stripe: the `payments` skill's
   `references/setup.md`, with invoices (every permission and webhook
   event it lists, and the card settings for charging). The CRM is team
   only: use the webhook URL that
   `python3 ~/tools/taskandtool.py inbound-url /hooks/stripe` prints.
5. Recurring invoices need the time zone (lever 1) and one daily job (the
   `schedule-job` skill), at the UTC hour that is 06:00 in `time_zone`:
   `python3 ~/tools/taskandtool.py schedule-job "Recurring invoices" --when "0 <h> * * *" --route /_jobs/recurring-invoices`
   (`src/crm/jobs.ts`).

The rules for invoices and for sending them are in the `invoices` skill.
Its code is in `src/invoices/`.
