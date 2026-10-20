---
name: crm
description: "Runs and reshapes this CRM: leads, contacts keyed by email, deals, tasks, notes, the schedule, proposals' pages, its config and schema. Use for 'any new leads', 'add a customer', 'who should I follow up with', 'add a deal', 'book Ann in', 'import my list', 'shape the CRM'. Not for sending, charging or billing quotes and invoices (invoices)."
---

# CRM

A customer record on Hono (server-rendered JSX, htmx, SortableJS, Postgres).

## Rules

- **Email is the key**; phone is the fallback (its last ten digits, only
  where one side has no email: `phoneKey` in `src/customers/customer.ts`; in
  SQL, `isCustomer` in `src/crm/sql.ts`). Saving everyone who gets in touch
  (the customers skill's `savePerson`), the scripts and the import all use
  this one rule. A name matches only in an import, between rows and
  customers that have neither.
- **A lead is one enquiry**, made as a form submission or an online booking
  comes in (a form with `"leads": false` makes none) or added for a call.
  It is converted into a deal (`deals.mjs add <who> --lead <id>`) or
  archived with a reason.

## Read next

| When | Read |
|---|---|
| Changing words, statuses, deal stages, custom fields, a real column; deals, tasks, the morning email, merging | `references/levers.md` |
| The schedule: events, what can be booked online, the Team's hours and calendars, booking messages | `references/schedule.md` |
| Forms here; quotes as proposals (their components, the link, signing, how they look); setting up invoices, Stripe or the email sender | `references/money.md`, then the `invoices` skill |
| Writing or changing a proposal component's words | `references/proposal-writing.md` |
| Shaping the CRM for a business; importing or exporting a list | `references/shaping.md` |
| The business number, Messages, the automatic texts and their words | the `phone` skill; `node scripts/phone.mjs --help` |

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
