---
name: crm
description: "Runs and reshapes this CRM: customers keyed by email, what came in from the project's forms, bookings and payments, the pipeline, notes, jobs, its config and schema. Use for 'add a customer', 'log a job', 'who got in touch', 'import my list', 'shape the CRM'. Not for quotes and invoices (invoices)."
---

# CRM

This app is a customer record on Hono: server-rendered JSX, htmx, SortableJS
on the pipeline, Postgres, no client framework. **Dev** is this machine's
`web` service; **production** is the same app on Cloudflare, team only.
`AGENTS.md` says where things are and lists the commands; this file is how
to change it.

## Rules

- **Email is the key**; phone is the fallback (its last ten digits, only
  where one side has no email: `src/crm/phone.ts`). Inbox matching, Add as
  customer, the scripts and the import all use this one rule.
- **Never hard-delete** a customer, note or visit: archive, or cancel.
- **Table names never change**; the config changes what people see.
  `schema.sql` only adds (`npm run check` refuses anything else).
- **Production stays team only**; every route but `/healthz` and Stripe's
  signed `POST /hooks/stripe` keeps `teamOnly()`; every change is a POST
  and records who made it.
- **Real data only**: never invent customers, notes or history.
- **Tokens only in markup, no em dashes in copy** (`npm run check`).
- **Skill code is copied, not edited**: `src/data/`, `admin/`, `forms/`,
  `booking/`, `payments/`, `invoices/` and `src/reports/` are the business
  skills' files; change a skill in the skills repo.
  `dev/starter_apps.sh skills check` fails on any copy that differs.

## The tables

The project has one Postgres database; every app uses the same tables by
their plain names.

- **The CRM's own**: `customers`, `pipeline_stages`, `customer_notes`,
  `customer_visits`, and `crm_setup` (`schema.sql`). Booking and the Board read `customers`
  too, so its columns keep their names and meanings.
- **The skills' tables it sets up and writes** (`src/db/setup.ts`): the
  forms tables (it shows submissions and edits forms), the booking tables
  when booking is on, and with invoices on the payments and invoices
  tables (quotes, invoices, tax rates, refunds, the Stripe events).
- **What other apps write that it reads**: submissions from the Website's
  forms, its bookings and payments. Of those it changes only a submission's
  status, and refunds a payment when a team member confirms one.

## Read next

| When | Read |
|---|---|
| Changing words, stages, custom fields, a real column; jobs or visits | `references/levers.md` |
| What can be booked, hours, calendars, booking messages | `references/bookings.md` |
| Forms here; setting up quotes, invoices, Stripe or the email sender | `references/money.md`, then the `invoices` skill |
| Shaping the CRM for a business; importing or exporting a list | `references/shaping.md` |

## Dev, on this machine

```bash
sprite-env services get web
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/healthz      # 200 once the database is ready
curl -s -H 'X-TaskTool-User: you@example.com' localhost:3000/customers | head
tail -50 /.sprite/logs/services/web.log
```

Every path but `/healthz` and Stripe's signed `/hooks/stripe` answers 404
without `X-TaskTool-User`: that is the gate (`src/admin/guard.ts`), not a
fault. If the service is missing,
re-run `bash ~/app/.taskandtool/setup.sh` (idempotent). If `/healthz` stays
503 the project has no Postgres yet: the owner adds it from the app's page,
or ask with `request_capability("postgres", why)` from
`tools/taskandtool.py`. The server comes up without it and sets its tables
up the moment `DATABASE_URL` appears.

## Production, team only

`npm run deploy` applies `schema.sql` from the machine, builds `dist/` and
`build/worker.mjs`, and deploys with `--flag nodejs_compat`. Before it:
`npm run check`, `npm test`, and look at what changed in dev. Code, config
and schema wait for a deploy; customers do not, since dev and production
share the one database.

The first deploy publishes production to the team. **It stays team only.**
It is the business's customer list, with people's names, phones and
notes, and the whole app is private: it needs no private paths, and it
never needs a public switch. If the owner asks to make it public, say what
that would expose and suggest a separate public page (a form on the
Website) instead.

## Who is signed in, and sending

- `X-TaskTool-User` is the whole login: Task & Tool's edge sets it for a
  signed-in team member and strips forged copies. `created_by`,
  `updated_by` and a note's `author` come from it; scripts record `--as`
  (default `AI`). Never build a login, and never loosen `teamOnly()`.
- The CRM sends only booking messages and quotes, through the owner's own
  sender, and invoices go out from the owner's Stripe; Task & Tool never
  sends for it. A note of kind `email`, `call` or `text` records contact
  that happened elsewhere.
