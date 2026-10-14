# CRM

The customer record for a small business: everyone who got in touch, in
one place, and what happens next. Its first screen is the **Inbox**:
everything that came in across the project (form submissions from the
Website, bookings, payments), newest first, each matched to a customer by email or offered as a new one
or a new deal, under four figures: leads this week, tasks due, the
open pipeline and what was won this month. Then the tasks due, the
deals on a board you drag between stages, the customers themselves, a
timeline of notes and calls per customer, and a schedule of events (an
appointment, a job, a visit): when, who, where, for how much. It works the minute it
is installed and is shaped for the business by talking to the app's AI:
an HVAC shop, a dental practice, a restaurant, a plumber with several
locations and trucks, a counselor who only wants a record of who called.

This repository *is* the app. On Task & Tool it is cloned onto the app's
own machine, served from there, and everything in it is yours. It also
runs anywhere with Node 20 and a Postgres.

## What is in the box

- **Inbox**: form submissions (not spam) and online bookings from the
  project's other apps. Everyone who gets in touch is saved as a customer
  on their own, matched by email, else by phone, never by name. Each has
  New deal (the New deal form, filled in from it; a returning customer's
  new enquiry too) and Done, which offers Undo. It opens on To do, which
  empties as you work: anything leaves once it is done or made a deal,
  and a booking once it is no longer scheduled. The nav counts what is to
  do. A source the project does not have yet is simply left out.
- **Notifications**: the bell beside the business's name. What happened
  without the team doing it, newest first: a booker's own reschedule or
  cancel, a quote the customer accepted by paying it online, and money
  paid. Opening the bell clears its count; what was new is in bold that
  once. Each opens its record.
- **Leads**: one enquiry each, as Pipedrive's leads and Jobber's
  requests: a form fill or an online booking makes one as it comes in, and
  New lead adds a phone call or a walk-in. Open, Converted or Archived. A
  lead shows who, where it came from, what they said, and what they
  already have (an open deal, a visit); Convert to deal opens the deal form
  filled in, and Archive asks why and offers Undo.
- **Tasks**: a call, email, meeting, text or to-do due on a day, by
  one person. Every open task on one list, overdue first, everyone's or mine, and
  New task; the next one at the top of a customer's page and on every
  card. Contacts' "Nothing planned" filter shows who is in play with
  nothing planned. Done goes on the timeline. A deal made from the Inbox
  gets a "Call back" for that day, and a morning email lists what is due.
- **Deals**: one piece of work being won, for one customer, who may have
  many. Stages you name, a value (a quote's total until one is typed),
  an owner, an expected close; won makes them a customer, a quote's yes
  wins it, a lost one keeps why.
- **Contacts**, everyone the business deals with, keyed by email (a phone
  alone is fine too), each with a status (Lead until they buy, then
  Customer, or Not a fit), as Pipedrive and HubSpot name them; the word is
  the `vocabulary` setting (a dentist's Patients): search by name, email, phone or
  company, filter by status, tag and owner, export the filter as CSV,
  archive (never delete), and merge two records of one person.
- **A contact's page**, laid out as CRMs lay out a record: tasks,
  one Activity timeline (notes and calls, and everything they sent,
  paid and were quoted) with a note box on top, and their events;
  beside it Details (details and custom fields, Edit), their deals, quotes
  and invoices, possible duplicates, Merge and Archive.
- **Schedule**: one record per event (the config names them: Event,
  Job, Appointment), whether a customer booked it online or the team put
  it on the schedule. Scheduled, then completed, no-show or cancelled,
  with who takes it, where, an amount and its own fields (which truck,
  which room). The Calendar (the week by person), the list (upcoming, overdue, past,
  all, exported as CSV), Services (what customers can book online, with
  online booking on) and the Team (everyone's hours, time off and Google
  or Outlook calendar). The public booking page is the Website's; both use
  the same table. Turned off for a business that keeps its schedule
  elsewhere.
- **Quotes and invoices**: a quote with lines and tax, previewed and
  emailed as a PDF from your own email sender, marked accepted or declined;
  then an invoice made in your Stripe account, which emails it and takes
  the payment by card or bank on Stripe's page. Cash or a
  check is marked paid there too. A customer's page shows what was
  quoted, what they owe now and what they paid.
- **The deals board**: a column per stage with its count and total, drag
  between them, or a select on each card on a phone or without JavaScript.
- **CSV import** of the list you keep today, matched by email then phone
  so nobody is added twice, with a dry run first.
- **The AI's hands**: scripts to find, add, update, note, tag, merge,
  import and export customers from chat, add and move deals, plan and
  tick off tasks, schedule and close events, quote and invoice,
  and list the Inbox. Sending anything to a customer, and a merge,
  waits for your yes.

## Shaping it

`crm.config.json` holds the words (`Patients`, `Guests`, `Clients`), the
statuses and deal stages seeded on the first run (and what a deal is
called), sources, custom fields (`text`, `number`, `date`, `select`,
`phone`, `email`, no migration needed), what the owner is called, the
time zone, which forms count as leads, and what an event is called and
records. `examples/` has five worked configs. Ask the AI to shape the CRM
for your business; it reads them, asks what it cannot infer, and sets it
up. After the first run, statuses and deal stages are rows, edited from
Edit stages on the board. A field that deserves a real column is an additive line in
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
src/crm/                 customers, stages, deals, tasks, events, the inbox, history, merge, import
src/views/               inbox, tasks, deals, customers, a customer, events, stages
src/booking/             a copy of the booking skill: the Schedule, Services and Team, the calendar sync job
src/customers/           a copy of the customers skill: the customers and notes tables, the note box
src/forms/               a copy of the forms skill: the submissions inbox, the form editor
src/invoices/            a copy of the invoices skill: quotes, invoices, tax rates, Stripe
src/data/  src/admin/    copies of the data and admin business skills, and what is
src/payments/ src/reports/   used of payments and reports
scripts/                 customers, deals, tasks, events, forms, quotes, invoices, inbox, stages, import, export, migrate (--help)
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
