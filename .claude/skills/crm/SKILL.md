---
name: crm
description: "Runs and reshapes this CRM: contacts keyed by email, leads (each enquiry from a form, an online booking or a call), deals, tasks, notes, the schedule, its config and schema. Use for 'any new leads', 'add a customer', 'who should I follow up with', 'add a deal', 'book Ann in', 'import my list', 'shape the CRM'. Not for quotes and invoices (invoices)."
---

# CRM

A customer record on Hono (server-rendered JSX, htmx, SortableJS, Postgres).
`AGENTS.md` has the rules, layout and commands; tables follow the `data` skill.

## Rules

- **Email is the key**; phone is the fallback (its last ten digits, only
  where one side has no email: `phoneKey` in `src/customers/customer.ts`; in SQL, `isCustomer` in
  `src/crm/sql.ts`). Saving everyone who gets in touch (the
  customers skill's `savePerson`, called as each submission and booking is
  written; `saveEveryone` at setup for older rows), the scripts and the
  import all use this one rule. A name never matches.
- **A lead is one enquiry**, made as a form submission or an online booking
  comes in (a form with `"leads": false` makes none) or added for a call.
  It is converted into a deal (`deals.mjs add <who> --lead <id>`) or
  archived with a reason, never deleted.
- **Every change is a POST** behind `teamOnly()` and records who made it.

## The tables

- **The CRM's own** are in `schema.sql`. `customers` and
  `customer_notes` are the customers skill's (`src/customers/schema.sql`),
  set up before them; booking and the Website read `customers` too, so its
  columns keep their names and meanings.
- **The skills' tables it sets up and writes** (`src/db/setup.ts`): the
  forms tables (it shows submissions and edits forms), the booking tables
  (always: the schedule's events are bookings), and, when invoices are on, the payments and invoices
  tables (quotes, invoices, tax rates, refunds, the Stripe events), and the
  proposals' (`src/proposals/schema.sql`: the components ticked, the page and its link, opens, signatures).

## Read next

| When | Read |
|---|---|
| Changing words, statuses, deal stages, custom fields, a real column; deals, tasks, the morning email, merging | `references/levers.md` |
| The schedule: events, what can be booked online, the Team's hours and calendars, booking messages | `references/schedule.md` |
| Forms here; quotes as proposals (their components, the link, signing, how they look); setting up invoices, Stripe or the email sender | `references/money.md`, then the `invoices` skill |
| Writing or changing a proposal component's words | `references/proposal-writing.md` |
| Shaping the CRM for a business; importing or exporting a list | `references/shaping.md` |

## Dev, on this machine

```bash
python3 ~/tools/taskandtool.py logs                 # state and the end of the log
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/healthz      # 200 once the database is ready
```

A 404 without the header is the gate (`src/admin/guard.ts`), not a fault.
If `/healthz` stays 503 the project has no Postgres yet: the owner adds it
from the app's page, or ask with
`python3 ~/tools/taskandtool.py request-capability postgres`. The server
comes up without it and sets its tables up the moment `DATABASE_URL`
appears.

## Production

`npm run deploy` applies `schema.sql` from the machine, builds `dist/` and
`build/worker.mjs`, and deploys with `--flag nodejs_compat`.

Before `npm run deploy`: `npm run check`, `npm test`, and look at what
changed in dev. Code, config and schema wait for a deploy; customers do not
(one shared database).

If the owner asks to make production public, say what it would expose
(names, phones, notes) and suggest a form on the Website instead. Only
`/q`, a proposal's link, opens to customers (`references/money.md`).
