---
name: crm
description: "Runs and reshapes this CRM: customers keyed by email, what came in from the project's forms, bookings and payments, the pipeline, notes, jobs, its config and schema. Use for 'add a customer', 'log a job', 'who got in touch', 'import my list', 'shape the CRM'. Not for quotes and invoices (invoices)."
---

# CRM

This app is a customer record on Hono: server-rendered JSX, htmx, SortableJS
on the pipeline, Postgres, no client framework. `AGENTS.md` has the rules,
where things are and the commands; this file is how to change it. The
project's tables follow the `data` skill, which also says how the copies of
the business skills' code in `src/` are kept.

## Rules

- **Email is the key**; phone is the fallback (its last ten digits, only
  where one side has no email: `src/crm/phone.ts`). Inbox matching, Add as
  customer, the scripts and the import all use this one rule.
- **Every change is a POST** behind `teamOnly()` and records who made it.

## The tables

- **The CRM's own** are in `schema.sql`. Booking and the Board read
  `customers` too, so its columns keep their names and meanings.
- **The skills' tables it sets up and writes** (`src/db/setup.ts`): the
  forms tables (it shows submissions and edits forms), the booking tables
  when booking is on, and with invoices on the payments and invoices
  tables (quotes, invoices, tax rates, refunds, the Stripe events).

## Read next

| When | Read |
|---|---|
| Changing words, stages, custom fields, a real column; jobs or visits | `references/levers.md` |
| What can be booked, hours, calendars, booking messages | `references/bookings.md` |
| Forms here; setting up quotes, invoices, Stripe or the email sender | `references/money.md`, then the `invoices` skill |
| Shaping the CRM for a business; importing or exporting a list | `references/shaping.md` |

## Dev, on this machine

```bash
python3 ~/tools/taskandtool.py logs                 # state and the end of the log
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/healthz      # 200 once the database is ready
curl -s -H 'X-TaskTool-User: you@example.com' localhost:3000/customers | head
```

A 404 without the header is the gate (`src/admin/guard.ts`), not a fault.
If `/healthz` stays 503 the project has no Postgres yet: the owner adds it
from the app's page, or ask with
`python3 ~/tools/taskandtool.py request-capability postgres`. The server
comes up without it and sets its tables up the moment `DATABASE_URL`
appears.

## Production

`npm run deploy` applies `schema.sql` from the machine, builds `dist/` and
`build/worker.mjs`, and deploys with `--flag nodejs_compat`. Before it:
`npm run check`, `npm test`, and look at what changed in dev. Code, config
and schema wait for a deploy; customers do not, since dev and production
share the one database.

The first deploy publishes production to the team, and it needs no private
paths. If the owner asks to make it public, say what that would expose
(people's names, phones and notes) and suggest a separate public page (a
form on the Website) instead.
