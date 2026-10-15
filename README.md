# CRM

The customer record for a small business: everyone who got in touch, in
one place, and what happens next. Its first screen is **Home**: the
figures (new leads this week, your tasks due, the open pipeline, what was
won this month, what is owed), then the newest leads, today's schedule,
your tasks due and the deals closing this month. Then the leads, each
enquiry from a form or an online booking; the tasks; the
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

- **Home**: the figures, each opening its list, then four short lists
  (new leads, today, your tasks due, closing this month), each with the
  way to the whole list. Everyone who gets in touch is saved as a contact
  on their own, matched by email, else by phone, never by name.
- **Notifications**: the bell beside the business's name. What happened
  without the team doing it, newest first: a booker's own reschedule or
  cancel, a proposal the customer signed or declined at its link, and
  money paid. Opening the bell clears its count; what was new is in bold that
  once. Each opens its record.
- **Leads**: one enquiry each, as Pipedrive's leads and Jobber's
  requests: a form fill or an online booking makes one as it comes in, and
  New lead adds a phone call or a walk-in. Open, Converted or Archived. A
  lead shows who, where it came from, what they said, and what they
  already have (an open deal, a visit); on its page Convert to deal opens
  the deal form filled in, and Archive asks why and offers Undo. A form's
  submission follows its lead.
- **Tasks**: a call, email, meeting, text or to-do due on a day, by
  one person. Mine (the default), Everyone's or Done, overdue first, and
  New task; the next one at the top of a customer's page and on every
  card. Contacts' "Nothing planned" filter shows who is in play with
  nothing planned. Done goes on the timeline. A deal made from a lead
  gets a "Call back" for that day, and a morning email lists what is due.
- **Deals**: one piece of work being won, for one customer, who may have
  many. Stages you name, a value (a quote's total until one is typed),
  an owner, an expected close; its own tasks and events (a visit to quote
  it, the job itself); won makes them a customer, a quote's yes wins it, a
  lost one keeps why.
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
  and invoices, possible duplicates; Call, Email and More (New quote, Merge,
  Archive) at the top.
- **Search** from any page finds contacts, leads, deals, quotes and
  invoices, a few of each as you type, the rest on its page.
- **Schedule**: one record per event (the config names them: Event,
  Job, Appointment), whether a customer booked it online or the team put
  it on the schedule. Scheduled, then completed, no-show or cancelled,
  with who takes it, where, an amount and its own fields (which truck,
  which room). The Calendar (a day, a week or a month, by person) and the
  list (upcoming, overdue, past, all, exported as CSV). The public booking page is the Website's; both use
  the same table. Turned off for a business that keeps its schedule
  elsewhere.
- **Settings**: the forms, the stages and statuses, Services (what
  customers can book online, with online booking on), the Team (everyone's
  hours, time off and Google or Outlook calendar) and tax rates.
- **Proposals, quotes and invoices**: a quote with lines and tax, and the
  designed components you tick by name (about us, your team, reviews, case
  studies, a full-page photograph, questions, terms), which the AI fills
  with your own words and photographs from your website. It goes out as a private link from your own email sender (or one
  you copy); the customer reads a clean page, types their name to accept
  or says why not, and you see when they opened it. Signing can make the
  first invoice, a deposit too, and take them straight to pay. The
  invoice is made in your Stripe account, which emails it and takes the
  payment by card or bank on Stripe's page. Cash, a check or a transfer is
  recorded there too (Record payment), all of it or part; the rest stays
  owed. A customer's page shows what was quoted, what they owe now
  and what they paid.
- **The deals board**: a column per stage with its count and total, drag
  between them, or a select on each card on a phone or without JavaScript.
- **CSV import** of the list you keep today, matched by email then phone
  so nobody is added twice, with a dry run first.
- **The AI's hands**: scripts to find, add, update, note, tag, merge,
  import and export customers from chat, add and move deals, plan and
  tick off tasks, schedule and close events, quote and invoice,
  and read the form submissions. Sending anything to a customer, and a merge,
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
crm.config.json          the levers: words, statuses, deals, sources, fields, zone, events, invoices
schema.sql               the tables, additive only, applied at start and deploy
src/app.tsx              the Hono app: the team-only gate, the routes
src/crm/                 home, customers, leads, stages, deals, tasks, events, notifications, search, history, merge, import
src/views/               home, leads, tasks, deals, customers, a customer, events, notifications, search, settings, stages
src/booking/             a copy of the booking skill: the Schedule, Services and Team, the calendar sync job
src/customers/           a copy of the customers skill: the customers and notes tables, the note box
src/forms/               a copy of the forms skill: the submissions list, the form editor
src/invoices/            a copy of the invoices skill: quotes, invoices, tax rates, Stripe
src/proposals/           a quote as the customer's page: designed components, the link at /q, signing, opens
src/data/  src/admin/    copies of the data and admin business skills, and what is
src/payments/ src/reports/   used of payments and reports
scripts/                 customers, deals, tasks, events, forms, quotes, invoices, stages, import, export, migrate (--help)
styles/  static/         the tokens (proposal.css: the proposal's own); the built CSS, vendored htmx and SortableJS, crm.js
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
