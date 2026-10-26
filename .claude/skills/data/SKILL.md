---
name: data
description: "What every skill's code builds on: the project's shared tables and their rules, the Db handle, settings, connection calls, email, spam checks, the business's name and address, unsubscribes. Use before creating or changing a table or copying another skill's code. Not for DATABASE_URL, drivers or extensions (the `database` skill)."
---

# Data

Every app in a project shares one Postgres database, so a CRM installed
later finds the Website's form submissions, bookings and payments already
there.

Version: 0.5.0 (taskandtool/skills)

## The rules

- **One set of tables for the project, each by its plain name.** Every app
  reads, writes and alters every table, so name a new one for what it holds
  (`quotes`, `report_snapshots`), never for the app that made it. Look
  first: `select table_name from information_schema.tables where
  table_schema = 'public'`. A table another app made is the one to use: add
  a column to it rather than making a second one.
- **A person is an email.** Every table that names a person has
  `email citext`, stored through `normalizeEmail` (`email.ts`). That is how
  every app finds the same person; there is no people table.
- **A `schema.sql` runs every time the app starts**, so each statement
  must be safe to run again: `create table if not exists`, `create index if
  not exists`. A table already there is skipped, so a column added to one
  needs its own line: `alter table x add column if not exists y …`.
- **Times are `timestamptz`.** Store the IANA zone next to any time a person
  chose in their own zone (`time_zone text`). Never store a local time without
  its zone.
- **Money is an integer in minor units** with a currency (`amount_cents
  bigint`, `currency text`). Never a float.
- **Rows say who wrote them**: `source text` (the app's slug, e.g. `website`),
  `created_at timestamptz not null default now()`, and `updated_by citext`
  (the team member's email) on anything a person edits.

## The database handle

Snippets take a `Db` (`db.ts`): `db.sql` runs one statement and returns its
rows; `db.transaction([q`…`, q`…`])` runs statements all or nothing. Every value
is a parameter. A transaction is non-interactive: decide inside the SQL
(`insert … select … where not exists`, `returning`), not in JavaScript
between statements. That is the shape the Neon HTTP driver allows, so it is
the only one a snippet assumes.

Every route factory takes a `GetDb`, `(c) => Db`: made per request from the
binding in production, the app's one handle in dev.

Each app makes its handle from the driver it already uses:

- **The Neon HTTP driver** (the Website): `fromNeon(envVar(c,
  "DATABASE_URL"))` from `neon.ts`, the same in dev and production.
- **`pg`** (the CRM): `fromPool(openPool(url))` from `pg.ts`. In dev, the
  server's one pool. In production, a pool per request on
  `env.DATABASE_URL`, closed in `ctx.waitUntil`, deployed with
  `--flag nodejs_compat` (the `deploy` skill).

## Settings, the gateway, email, spam

- **Settings** (`env.ts`): `envVar(c, name)` reads a Worker binding in
  production and `process.env` in dev; `envOf(c)` passes them to code that
  takes an `Env`. Never `c.env ?? process.env`: on the machine `c.env` is
  node-server's `{ incoming, outgoing }`, so that reads nothing.
- **A connection** (`gateway.ts`):
  `gatewayFetch(env, slug, path, init)`, the same in dev and production:
  Task & Tool adds the key or token, which never reaches app code. Pass
  `envOf(c)`: in production it carries the connections the routing Worker
  hands each request (`TT`), on the machine the gateway's address.
  `listConnections(env)` is the app's list for code, in both: a slug per
  granted endpoint, with its `service` and `account`. Two people's Google on
  one app are `google-calendar` and `google-calendar-7c2e1a`, so code that
  serves everyone who connected finds them by `service`, not by one slug.
- **Scheduled work** (`jobs.ts`): a `/jobs/<name>` route scheduled with
  `schedule-job --route` runs where the app is served (production once
  deployed, else the dev server). Put it on `jobRoutes()`: it answers only
  when `isJob(c)` (the routing Worker's `props.job` in production, the
  machine token in dev), and a throw becomes a JSON 500.
- **Email** (`send.ts`): `sendEmail(env, mail)` through Resend or Postmark
  (the owner's, to anyone; `NOTIFY_FROM` and `NOTIFY_VIA`), else Task & Tool
  email (ours, free, nothing to set). Task & Tool email sends only mail
  marked `team: true`, and only to people who can open this app in Task &
  Tool; to email anyone else, connect Resend or Postmark. `emailsCustomers(env)`
  says whether a customer's email can go out. It never throws: it returns
  `{ status: "sent" | "none" | "failed" }` with the reason. Run it with
  `afterResponse(c, …)` so the visitor does not wait and the Worker does not
  stop before it is sent.
- **Spam** (`spam.tsx`): every public form carries `<SpamFields
  stamp={await makeStamp(scope)} />` and is checked with `verdict`: `drop`
  (a bot: thank it and save nothing), `fast` (save it marked spam), or `ok`.
- **The business** (`business.ts`): its name, its privacy and terms
  pages and its postal address, one row for the project. Read it with
  `businessOf(db)` wherever a page, text, email or quote names the business;
  never keep a copy in an app's config. The CRM's Settings, Business edits
  it.
- **Unsubscribing** (`unsubscribe.tsx`): a commercial follow-up email
  carries `unsubscribeLink`, the app mounts `unsubscribeRoutes` where its
  customers' pages are, and `emailOptedOut` is checked before each send.

## Installing a skill's code into this app

Copy the files the app uses into `src/<skill>/`, with what they import
(this skill's go in `src/data/`, so `../data/db` resolves as it does in the
skills repo) and the tests that cover them (`data/test/scratch.ts` for any
database test). The copy is this app's code: change it as the app needs,
keeping the rules above and its tests passing. Then:

1. Run this skill's `schema.sql` first, then the skill's own, with
   `applySchema` from the app's setup or start
   script (machine only, never per request):
   `await applySchema(db, readFileSync("src/booking/schema.sql", "utf8"))`.
2. Add the dependency the handle needs if the app lacks it
   (`@neondatabase/serverless` or `pg`). The tests use `pg` whatever the
   app's handle, so an app on the Neon driver adds `pg` and `@types/pg` as
   dev dependencies.
3. Run the copied tests and the app's typecheck:
   `TEST_DATABASE_URL=postgres://… npx tsx --test src/<skill>/test/*.test.ts`
   (a role that may create databases; each test makes and drops its own).

A machine-only file (`cli.mjs`, a skill's `cli.ts`, reports' `print.ts`,
forms' `files.ts`) runs only on the machine and may
import Node built-ins. Nothing the production Worker imports may reach it.
The Website's `npm run check:code` fails if something does; the CRM's `npm
run check` allows Node built-ins only in the files listed in `nodeOnly`
(`scripts/check.mjs`), so a new machine-only file goes on that list. A
`.ts` file imports `cli.mjs` by its full name (`../data/cli.mjs`), and the
app's `tsconfig.json` needs `"allowJs": true`.

## When the database is not there

No `DATABASE_URL` means the app has no database yet: ask the owner with
`python3 ~/tools/taskandtool.py request-capability postgres`.

## Files

| File | What it is |
|---|---|
| `db.ts` | `Db`, `GetDb`, `q` |
| `neon.ts`, `pg.ts` | the two handles: `fromNeon` (Neon HTTP, edge and machine); `openPool`, `fromPool` (node-postgres: the machine, and production deployed with `nodejs_compat`) |
| `migrate.ts` | `applySchema` |
| `email.ts` | `normalizeEmail` |
| `env.ts` | `envVar`, `envOf`, `setting`, `connectionsOf` |
| `gateway.ts` | `gatewayFetch`, `listConnections`, `gatewayReachable` (dev and production) |
| `jobs.ts` | `jobRoutes`, `isJob`: the scheduled route jobs' Hono app, and whether a request is one |
| `send.ts` | `sendEmail`, `emailsCustomers`, `teamOf` (who Task & Tool email reaches), `afterResponse` |
| `spam.tsx` | `SpamFields`, `makeStamp`, `verdict` |
| `schema.sql` | `business`, `email_optouts`, `unsubscribe_keys` |
| `business.ts` | `businessOf`, `saveBusiness`, `checkBusiness` |
| `unsubscribe.tsx` | `unsubscribeLink`, `unsubscribe`, `emailOptedOut`, `unsubscribeRoutes` |
| `token.ts` | `newToken`, `tokenHash`: a key a visitor holds, stored as its hash |
| `cli.mjs` | what every script shares: arguments, usage, `done`, `fail`, `misused`, `machineEnv` (machine only) |
| `test/` | statements and transactions, applying a schema, settings, the gateway, sending, spam, the script helpers |
