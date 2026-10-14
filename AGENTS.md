# This app: a CRM on Hono

The business's customer record: Home (the figures and what needs doing
today), leads (each enquiry from a form, an online booking or a call),
contacts keyed by email, deals on a board of stages, tasks, notes of every
call, a bell for what customers did themselves, and a schedule of events (an
appointment, a job, a visit: one record each, booked online or added by the team). It runs in **dev** on this machine
and in **production** on Cloudflare once deployed. This
repository *is* the app: the code at the root, the skill that knows how to
work on it in `.claude/skills/crm/`, and `.taskandtool/setup.sh` for what
the machine needs (dependencies, the `web` service). All of it is the
owner's to change.

## Start here

Read the skill for what the owner asks before working from memory:

- "Add a customer", "who should I follow up with", "add a deal", "put a
  job on the schedule", "who got in touch this week", "import my list", "merge these two",
  statuses and stages, custom fields, shaping the CRM: `crm`.
- "Send Ann the invoice" for finished work: run `node scripts/invoices.mjs bill <who> --confirm` straight away (with two finished events it lists them to ask which).
- "Quote this job", "who owes us", a tax rate, other invoice work: `invoices`.
- "Show me the orders", a form's questions, what someone filled in: `forms`.
- The Stripe key, the webhook, a payment or a refund: `payments`.
- What can be booked, hours, calendar sync: `booking`. A public booking
  page belongs to the Website app, not this one.
- A chart or a report: `reports`.

## Commands

Use these rather than doing the work by hand; each answers `--help`.

```bash
node scripts/leads.mjs list                     # open enquiries, newest first; show, add (a phone call), archive --reason
node scripts/deals.mjs add 18 --lead 5          # convert lead 5 into a deal for its contact, with a call back today
node scripts/customers.mjs add "Ann Lee" --email ann@example.com   # "customers add: added #12 Ann Lee [Lead]", or "already here, not added"
node scripts/events.mjs add ann@example.com "Boiler service" --at "next friday 9:30" --host Dana   # on the schedule; --at also "tomorrow 2pm", in the business's zone; say back the date it prints
node scripts/customers.mjs find "lee"           # customers; also note, status, update, merge
node scripts/tasks.mjs list                # due today and overdue; --none: nothing planned; add, done, move
node scripts/tasks.mjs add ann@example.com "Call about the quote" --on friday   # say back the day it prints
node scripts/deals.mjs add ann@example.com "New furnace" --value 6500   # a deal; list, stage, won, lost --reason
node scripts/events.mjs list                    # what is scheduled; done, no-show, cancel, update --amount
node scripts/stages.mjs list                    # deal stages (--statuses: a customer's); rename, add, archive --move-to
node scripts/forms.mjs submissions --form order # a form's submissions with their booking and payment; list, show, save
node scripts/quotes.mjs send 7                  # prints the email; --confirm sends it
node scripts/invoices.mjs send 3                # one invoice: what Stripe will do; --confirm does it
node scripts/import.mjs file.csv --dry-run      # a list in; always the dry run first
node scripts/export.mjs --out customers.csv     # the list out
```

## Where things are

- `crm.config.json` is the first lever (words, statuses, deals, fields, zone, events, booking, invoices); every key is in the crm skill's `references/levers.md`. `examples/` holds five worked configs to read, not a switch.
- `schema.sql` is the CRM's own tables (statuses are `pipeline_stages`, tasks are `follow_ups`) and its columns on the booking skill's `bookings`, applied at every start and deploy. `customers` and `customer_notes` are the customers skill's (`src/customers/schema.sql`).
- `src/crm/` is every query and rule, named (the customer-match SQL is `sql.ts`); routes, scripts and tests all go through it.
- `src/app.tsx` is the Hono app: the team-only gate, the routes.
  `src/views/` are the pages. `src/server.ts` is dev's entry (Node, with
  `src/db/client.ts`); `src/worker.ts` is production's (Cloudflare).
  `src/runtime.ts` is all that differs between them.
- `src/<skill>/` (`booking`, `customers`, `forms`, `invoices`, `payments`,
  `reports`, `data`, `admin`) are copies of the business skills' code.
- `styles/theme.css` is the design as tokens; `DESIGN.md` explains them.
  `static/` is served as-is (the built CSS, the vendored htmx and
  SortableJS, `crm.js`).
- `test/` runs with `npm test`; the database tests need
  `TEST_DATABASE_URL` and skip without it.

## The loop

- `npm run dev` is what the `web` service runs: Tailwind rebuilds the CSS
  and the server restarts on every change, so an edit is in dev on refresh.
  If the service is not running, re-run `bash ~/app/.taskandtool/setup.sh`
  (it is safe to run again).
- To look from the machine:
  `curl -H 'X-TaskTool-User: you@example.com' localhost:3000/`.
- `npm run check` before showing work (config and examples valid, the
  schema additive, the refuse list, the typecheck). `npm test` for the
  tests.
- `npm run deploy` publishes to production (schema, build, deploy), after
  the crm skill's checks.
- Commit at milestones.

## Rules

- The project's tables follow the `data` skill. The customer's words live
  in `crm.config.json`, never in a table name.
- A customer or a deal is archived, never deleted; an event is cancelled;
  a task is done. A merge waits for the owner's yes.
- Other apps' rows are written only through the skills' code in `src/<skill>/` and `src/crm/events.ts` (the CRM's events are rows in `bookings`); a submission's status and a confirmed refund are the only other changes.
- Identity comes from the platform: `X-TaskTool-User`, or 404; only
  `/healthz` and Stripe's signed `/hooks/stripe` answer without it. The CRM
  builds no login.
- Production stays team only; it is the business's customer list.
- Colours and sizes are tokens in `styles/theme.css`. Markup never carries
  a hex value or a Tailwind default colour; `npm run check` refuses both.
  No em dashes in interface copy.
- Real data only: never invent customers, notes or history.
