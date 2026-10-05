# This app: a CRM on Hono

The business's customer record: what came in across the project (form
submissions, bookings, payments), customers keyed by email, a pipeline of
stages, notes of every call, and each job or visit. It runs in **dev** on this machine
and in **production** on Cloudflare once deployed, team only in both. This
repository *is* the app: the code at the root, the skill that knows how to
work on it in `.claude/skills/crm/`, and `.taskandtool/setup.sh` for what
the machine needs (dependencies, the `web` service). All of it is the
owner's to change.

The skill: `crm` (the tables, the levers, the loop, the scripts). Read it
before changing the CRM rather than working from memory.

## Where things are

- `crm.config.json` is the first lever: the words (`Patients`, `Guests`),
  the stages seeded on the first run, sources, custom fields, the owner's
  label, the time zone, the default view, which forms count as leads,
  `visits` (what a job or visit is called, its own fields, or off) and
  `booking` (the team's side of booking, or off).
  `examples/` holds five worked configs to read, not a switch.
- `schema.sql` is the CRM's tables (`customers`, `pipeline_stages`,
  `customer_notes`, `customer_visits`), applied at every start and every deploy. Additive
  only; never rename a table.
- `src/crm/` is every query and rule, named: customers, stages, notes, what
  came in, everything from one person, the import. Routes, scripts and
  tests all go through it.
- `src/app.tsx` is the Hono app: the team-only gate, the routes.
  `src/views/` are the pages. `src/server.ts` is dev's entry (Node, with
  `src/db/client.ts`); `src/worker.ts` is production's (Cloudflare).
  `src/runtime.ts` is all that differs between them.
- `src/booking/` is a copy of the `booking` skill's code: the Bookings
  section (types, hosts, hours, calendars, the bookings) and the calendar
  sync job. The Website's `/book` pages take the bookings.
- `src/data/` and `src/admin/` are copies of the `data` and `admin`
  business skills: the database handle, the additive check, the email key,
  the guard, keyset paging, CSV, the list components.
- `scripts/customers.mjs`, `visits.mjs`, `inbox.mjs` and `stages.mjs` are
  your hands on the data from chat; `import.mjs` and `export.mjs` move CSV
  in and out. Every one answers `--help`.
- `styles/theme.css` is the design as tokens; `DESIGN.md` explains them.
  `static/` is served as-is (the built CSS, the vendored htmx and
  SortableJS, `crm.js`).
- `test/` runs with `npm test`; the database tests need
  `TEST_DATABASE_URL` and skip with a note without it.

## The loop

- `npm run dev` is what the `web` service runs: Tailwind rebuilds the CSS
  and the server restarts on every change, so an edit is in dev on refresh.
  If the service is not running, re-run `bash ~/app/.taskandtool/setup.sh`
  (idempotent).
- Every page needs `X-TaskTool-User`; to look from the machine,
  `curl -H 'X-TaskTool-User: you@example.com' localhost:3000/`.
- `npm run check` before showing work (config and examples valid, the
  schema additive, the refuse list, the typecheck). `npm test` for the
  tests.
- After a change to `schema.sql` or the config: `sprite-env services
  restart web`, or `node scripts/migrate.mjs` for the schema alone.
- `npm run deploy` publishes to production (schema, build, deploy), after
  the crm skill's checks.
- Commit at milestones. Never commit `node_modules/`, `static/vendor/`,
  `static/crm.css`, `dist/`, `build/`, an import file, or any credential.

## Rules

- Table names never change. The customer's words live in
  `crm.config.json`; the tables stay `customers`, `pipeline_stages`,
  `customer_notes`, `customer_visits`.
- A person is their email; a customer is archived, never deleted.
- Other apps' tables are read only, except `submissions.status`.
- Identity comes from the platform: `X-TaskTool-User`, or 404. The CRM
  builds no login and sends no email or text.
- Production stays team only; it is the business's customer list.
- Colours and sizes are tokens in `styles/theme.css`. Markup never carries
  a hex value or a Tailwind default colour; `npm run check` refuses both.
  No em dashes in interface copy.
- Real data only: never invent customers, notes or history.
