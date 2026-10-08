# CRM

The customer record for a small business: everyone who got in touch, in
one place, and what happens next. Its first screen is the **Inbox**:
everything that came in across the project (form submissions from the
Website, bookings, payments), newest first, each matched to a customer by email or offered as a new one
or a new deal, under four figures: leads this week, follow-ups due, the
open pipeline and what was won this month. Then the follow-ups due, the
deals on a board you drag between stages, the customers themselves, a
timeline of notes and calls per customer, and their jobs or visits: what
was done, when, by whom, for how much. It works the minute it
is installed and is shaped for the business by talking to the app's AI:
an HVAC shop, a dental practice, a restaurant, a plumber with several
locations and trucks, a counselor who only wants a record of who called.

This repository *is* the app. On Task & Tool it is cloned onto the app's
own machine, served from there, and everything in it is yours. It also
runs anywhere with Node 20 and a Postgres.

## What is in the box

- **Inbox**: form submissions (not spam), bookings and paid
  payments from the project's other apps, with Add as customer, Add as
  deal (a returning customer's new enquiry too) and Mark done. A source
  the project does not have yet is simply left out.
- **Follow-ups**: a call, email, meeting, text or task due on a day, by
  one person. Due (overdue first, then today), Upcoming and Nothing
  planned, mine or everyone's; the next one at the top of a customer's
  page and on every card. Done goes on the timeline. A new lead gets a
  "Call back" for that day, and a morning email lists what is due.
- **Deals**: one piece of work being won, for one customer, who may have
  many. Stages you name, a value (a quote's total until one is typed),
  an owner, an expected close; won makes them a customer, a quote's yes
  wins it, a lost one keeps why. Make it a job once won.
- **Customers**, keyed by email (a phone alone is fine too), each with a
  status (Lead, Customer, Not a fit): search by name, email, phone or
  company, filter by status, tag and owner, export the filter as CSV,
  archive (never delete), and merge two records of one person.
- **A customer's page**, laid out as CRMs lay out a record: follow-ups,
  one Activity timeline (notes and calls, and everything they sent,
  booked, paid and were quoted) with a note box on top, and their visits;
  beside it About (details and custom fields, Edit), their deals, quotes
  and invoices, possible duplicates, Merge and Archive.
- **Jobs, visits or events** (the config names them): one per occasion,
  planned, done or cancelled, with who did it, an amount and its own
  fields (which truck, which room). A list of what is coming up and what
  was done, exported as CSV. Turned off for a business that keeps them
  elsewhere.
- **Bookings**: what customers can book (an estimate visit, an
  installation, a video call), who takes each, everyone's hours, time off
  and Google or Outlook calendar, and every booking, with "Make it a job".
  The public booking page is the Website's; both use the same tables.
- **Quotes and invoices**: a quote with lines and tax, previewed and
  emailed as a PDF from your own email sender, marked accepted or declined;
  then an invoice made in your Stripe account, which emails it and takes
  the payment by card or bank on Stripe's page. Cash or a
  check is marked paid there too. A customer's page shows what was
  quoted, what they owe now and what they paid.
- **The deals board**: a column per stage with its count and total, drag
  between them, or a select on each card without JavaScript.
- **CSV import** of the list you keep today, matched by email then phone
  so nobody is added twice, with a dry run first.
- **The AI's hands**: scripts to find, add, update, note, tag, merge,
  import and export customers from chat, add and move deals, plan and
  tick off follow-ups, add and close jobs or visits, quote and invoice,
  and list the Inbox. Sending anything to a customer, and a merge,
  waits for your yes.

## Shaping it

`crm.config.json` holds the words (`Patients`, `Guests`, `Clients`), the
statuses and deal stages seeded on the first run (and what a deal is
called), sources, custom fields (`text`, `number`, `date`, `select`,
`phone`, `email`, no migration needed), what the owner is called, the
time zone, which forms count as leads, and what a visit is called and
records. `examples/` has five worked configs. Ask the AI to shape the CRM
for your business; it reads them, asks what it cannot infer, and sets it
up. After the first run, statuses and deal stages are rows, edited on the
Stages page. A field that deserves a real column is an additive line in
`schema.sql`.

## How it runs

- **Dev, on Task & Tool:** the platform clones this repository, runs
  `.taskandtool/setup.sh` (dependencies, CSS, the `web` service), grants
  the project's Postgres as `DATABASE_URL`, and the CRM sets its tables up.
  The team opens it from the app's Development link.
- **Production, on Cloudflare:** `npm run deploy` applies the schema from
  the machine, builds, and deploys. It stays team only: Task & Tool signs
  your team in and tells the CRM who they are, which is the whole login.
  Without that, every page answers 404, except Stripe's signed webhook.
- Anywhere else: `npm install`, put `DATABASE_URL` (any Postgres) and
  `ADMIN_DEV_USER=<your email>` in the environment, `npm run dev`, and open
  `http://localhost:3000`. `npm run check` and `npm test` are the checks;
  the database tests run when `TEST_DATABASE_URL` is set.

## Layout

```
crm.config.json          the levers: words, statuses, deals, sources, fields, zone, inbox
schema.sql               the tables, additive only, applied at start and deploy
src/app.tsx              the Hono app: the team-only gate, the routes
src/crm/                 customers, stages, deals, follow-ups, notes, visits, the inbox, history, merge, import
src/views/               inbox, follow-ups, deals, customers, a customer, visits, stages
src/booking/             a copy of the booking skill: the Bookings section, the calendar sync job
src/forms/               a copy of the forms skill: submissions by form, the form editor
src/invoices/            a copy of the invoices skill: quotes, invoices, tax rates, Stripe
src/data/  src/admin/    copies of the data and admin business skills, and what is
src/payments/ src/reports/   used of payments and reports
scripts/                 customers, deals, follow-ups, visits, forms, quotes, invoices, inbox, stages, import, export, migrate (--help)
styles/  static/         the tokens; the built CSS, vendored htmx and SortableJS, crm.js
examples/                hvac, dental, restaurant, plumbing, counselor configs
test/                    node:test
.claude/skills/crm/      the skill the AI reads (Claude or Codex)
.taskandtool/setup.sh    what the machine needs; idempotent
```

## Stack

Hono with server-rendered JSX, `pg` on Postgres with plain SQL, Tailwind
v4 as tokens, htmx for the round trips, SortableJS for the deals board. No
client framework, no ORM, no login of its own; email only through your
own sender, money only through your own Stripe. MIT.
