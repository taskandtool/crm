# This app: a CRM on Hono

The business's customer record: what came in across the project (form
submissions, bookings, payments), customers keyed by email, deals on a
board of stages, follow-ups, notes of every call, and each job or visit. It runs in **dev** on this machine
and in **production** on Cloudflare once deployed. This
repository *is* the app: the code at the root, the skill that knows how to
work on it in `.claude/skills/crm/`, and `.taskandtool/setup.sh` for what
the machine needs (dependencies, the `web` service). All of it is the
owner's to change.

## Start here

Read the skill for what the owner asks before working from memory:

- "Add a customer", "who should I follow up with", "add a deal", "log a
  job", "who got in touch this week", "import my list", "merge these two",
  statuses and stages, custom fields, shaping the CRM: `crm`.
- "Send Ann the invoice" for a finished job: run
  `node scripts/invoices.mjs bill <who> --confirm` straight away (it finds
  the job, drafts and sends; with two jobs it lists them to ask which).
- "Quote this job", "who owes us", a tax rate, other invoice work: `invoices`.
- "Show me the orders", a form's questions, what someone filled in: `forms`.
- The Stripe key, the webhook, a payment or a refund: `payments`.
- What can be booked, hours, calendar sync: `booking`. A public booking
  page is the Website's, not this app's.
- A chart or a report: `reports`.

## Commands

Use these rather than doing the same work by hand. Each answers `--help`;
`--json` where another script reads the output.

```bash
node scripts/inbox.mjs --since 7d               # what came in, and who it matched
node scripts/customers.mjs add "Ann Lee" --email ann@example.com   # "customers add: added #12 Ann Lee [New]", or "already here, not added"
node scripts/visits.mjs add ann@example.com "Boiler service" --at "next friday 9:30"   # a job; --at also "tomorrow 2pm", in the business's zone; say back the date it prints
node scripts/customers.mjs find "lee"           # customers; also note, status, update, merge
node scripts/follow-ups.mjs list                # due today and overdue; --none: nothing planned; add, done, move
node scripts/follow-ups.mjs add ann@example.com "Call about the quote" --on friday   # say back the day it prints
node scripts/deals.mjs add ann@example.com "New furnace" --value 6500   # a deal; list, stage, won, lost --reason, job
node scripts/visits.mjs list                    # jobs coming up; done, cancel, update --amount
node scripts/stages.mjs list                    # deal stages (--statuses: a customer's); rename, add, archive --move-to
node scripts/forms.mjs submissions --form order # a form's submissions with their booking and payment; list, show, save
node scripts/quotes.mjs send 7                  # prints the email; --confirm sends it
node scripts/invoices.mjs bill ann@example.com --confirm   # "send Ann the invoice": their finished job, drafted and sent in one step
node scripts/invoices.mjs send 3                # one invoice: what Stripe will do; --confirm does it
node scripts/import.mjs file.csv --dry-run      # a list in; always the dry run first
node scripts/export.mjs --out customers.csv     # the list out
```

## Where things are

- `crm.config.json` is the first lever: the words (`Patients`, `Guests`),
  the statuses and deals (their name, stages, lost reasons) seeded on the
  first run, sources, custom fields, the owner's label, the time zone,
  `follow_ups`, which forms count as leads,
  `visits` (what a job or visit is called, its own fields, or off),
  `booking` (the team's side of booking, or off) and `invoices` (the name
  on quotes, the currency, or off).
  `examples/` holds five worked configs to read, not a switch.
- `schema.sql` is the CRM's tables (`customers`, `pipeline_stages` (their
  statuses), `deals`, `deal_stages`, `follow_ups`, `customer_notes`,
  `customer_visits`, and `crm_setup`, which records the schema last applied
  so a script skips setup while it is current), applied at every start and
  every deploy.
- `src/crm/` is every query and rule, named: customers, stages, deals,
  follow-ups (and `digest-job.ts`, the morning email), notes, visits
  (jobs), quotes (a job from an accepted one), what came in, everything
  from one person, merging, the import. Routes, scripts and
  tests all go through it.
- `src/app.tsx` is the Hono app: the team-only gate, the routes.
  `src/views/` are the pages. `src/server.ts` is dev's entry (Node, with
  `src/db/client.ts`); `src/worker.ts` is production's (Cloudflare).
  `src/runtime.ts` is all that differs between them.
- `src/<skill>/` (`booking`, `forms`, `invoices`, `payments`, `reports`,
  `data`, `admin`) are copies of the business skills' code.
- `scripts/customers.mjs`, `deals.mjs`, `follow-ups.mjs`, `visits.mjs`, `forms.mjs`, `quotes.mjs`, `invoices.mjs`,
  `inbox.mjs` and `stages.mjs` are your hands on the data from chat; `import.mjs` and `export.mjs` move CSV
  in and out. Every one answers `--help`.
- `styles/theme.css` is the design as tokens; `DESIGN.md` explains them.
  `static/` is served as-is (the built CSS, the vendored htmx and
  SortableJS, `crm.js`).
- `test/` runs with `npm test`; the database tests need
  `TEST_DATABASE_URL` and skip without it.

## The loop

- `npm run dev` is what the `web` service runs: Tailwind rebuilds the CSS
  and the server restarts on every change, so an edit is in dev on refresh.
  If the service is not running, re-run `bash ~/app/.taskandtool/setup.sh`
  (idempotent).
- To look from the machine:
  `curl -H 'X-TaskTool-User: you@example.com' localhost:3000/`.
- `npm run check` before showing work (config and examples valid, the
  schema additive, the refuse list, the typecheck). `npm test` for the
  tests.
- After a change to `schema.sql` or the config: `python3 ~/tools/taskandtool.py restart`, or `node scripts/migrate.mjs` for the schema alone.
- `npm run deploy` publishes to production (schema, build, deploy), after
  the crm skill's checks.
- Commit at milestones.

## Rules

- The project's tables follow the `data` skill. The customer's words live
  in `crm.config.json`, never in a table name.
- A customer or a deal is archived, never deleted; a visit is cancelled;
  a follow-up is done. A merge waits for the owner's yes.
- What other apps write (submissions, bookings, payments) is read only,
  except a submission's status and a refund a team member confirms. The
  skills' tables the CRM sets up (forms, booking, payments, invoices) it
  writes through the skills' code.
- Identity comes from the platform: `X-TaskTool-User`, or 404; only
  `/healthz` and Stripe's signed `/hooks/stripe` answer without it. The CRM
  builds no login.
- Production stays team only; it is the business's customer list.
- Colours and sizes are tokens in `styles/theme.css`. Markup never carries
  a hex value or a Tailwind default colour; `npm run check` refuses both.
  No em dashes in interface copy.
- Real data only: never invent customers, notes or history.
