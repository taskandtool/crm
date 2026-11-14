---
name: crm
description: "Runs and reshapes this CRM: leads, contacts keyed by email, deals, tasks, notes, the schedule, proposal pages, its config and schema. Use when asked 'any new leads', 'add a customer', 'who should I follow up with', 'add a deal', 'book Ann in', 'import my list', 'shape the CRM'. Not for sending, charging or billing quotes and invoices (invoices)."
---

# CRM

A customer record on Hono (server-rendered JSX, htmx, SortableJS, Postgres).

## Rules

- **Email is the key**; phone is the fallback (its last ten digits, only
  where one side has no email: `phoneKey` in `src/customers/customer.ts`; in
  SQL, `isCustomer` in `src/crm/sql.ts`). Saving everyone who gets in touch
  (the customers skill's `savePerson`), the scripts and the import all use
  this one rule. Names are matched only in an import, and only between a
  row and a customer that both have no email and no phone.
- **A lead is one enquiry.** One is made when a form submission or an
  online booking comes in (not for a form with `"leads": false`), or you
  add one for a call. Convert it into a deal
  (`deals.mjs add <who> --lead <id>`) or archive it with a reason.

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

A 404 for a request without the `X-TaskTool-User` header is the gate
(`src/admin/guard.ts`), not a fault. If `/healthz` stays 503, the project
has no Postgres yet: the owner adds it from the app's page, or you ask for
it with `python3 ~/tools/taskandtool.py request-database`. The server
starts without it and creates its tables once `DATABASE_URL` is set.
