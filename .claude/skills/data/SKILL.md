---
name: data
description: "The project's one database, shared by every app: table rules (email links people, schema files only add), the Db handle, settings, connection calls, email and spam checks. Use before creating or changing a table, or copying another skill's code. Not for getting a database (the `database` skill)."
---

# Data

Every app in a project shares one Postgres database, so a CRM installed
later finds the Website's form submissions, bookings and payments already
there.

Version: 0.1.1 (taskandtool/skills)

## The rules

- **One database per project, one set of tables, each by its plain name.**
  Every app reads, writes and alters every table, so name a new table for
  what it holds (`quotes`, `report_snapshots`),
  never for the app that made it.
- **Look before you build.** Before creating anything, list what is there:
  `select table_name from information_schema.tables where table_schema = 'public'`.
  A table another app made is the one to use: add a column to it rather than
  making a second one. Never make `leads` beside `submissions`.
- **A person is an email.** Every table that names a person has
  `email citext`. Store it through `normalizeEmail` (`email.ts`). Nothing else
  links people across apps: no people table, no foreign keys between
  skills' tables.
- **Tables only grow.** Several apps may run different versions of the same
  skill, so a newer one adds a column an older one ignores and neither breaks
  the other. A `schema.sql` holds only `create table if not exists x`,
  `create [unique] index if not exists … on x`, `alter table x add column if
  not exists …` and `comment on`, with plain table names. Put constraints
  inline in `create table`, or on the column in `add column`. Never drop,
  rename or change a type; add a new column and stop writing the old one.
  `applySchema` refuses anything else before running any of it.
- **A column added in a later version gets its own line**:
  `alter table x add column if not exists y …`, as well as being in the
  `create table`. `create table if not exists` skips a table that is already
  there, so a project whose table an older copy made never gets a column that
  is only inside the `create`.
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

Every route factory takes a `GetDb`, `(c) => Db`, as its first argument,
then its options (`base`, `css`, `timeZone`, `nav`, `pageSize`, `source` where
they apply). In production the handle is made per request from the
binding; in dev the function returns the app's one handle.

Each app makes its handle from the driver it already uses:

- **The Neon HTTP driver** (the Website): `fromNeon(envVar(c,
  "DATABASE_URL"))` from `neon.ts`, the same in dev and production.
- **`pg`** (the Board, the CRM): `fromPool(pool)` from `pg.ts`. In dev, the
  server's one pool. In production, a pool per request on
  `env.DATABASE_URL`, closed in `ctx.waitUntil`, deployed with
  `--flag nodejs_compat` (the `deploy` skill).

## Settings, the gateway, email, spam

- **Settings** (`env.ts`): `envVar(c, name)` reads a Worker binding in
  production and `process.env` in dev; `envOf(c)` passes them to code that
  takes an `Env`. Never `c.env ?? process.env`: on the machine `c.env` is
  node-server's `{ incoming, outgoing }`, so that reads nothing.
- **A connection** (`gateway.ts`):
  `gatewayFetch(env, slug, path, init)`. The gateway adds the key, and it
  serves dev only. Production calls the vendor directly, with the key the
  owner bound to the production Worker (`delivery="edge"`).
  That key's env name is the connection's `env_name` in `python3 ~/tools/taskandtool.py list-connections`
  (`<SLUG>_API_KEY`); read it there rather than assuming it.
- **Email** (`send.ts`): `sendEmail(env, mail)` through the owner's Resend or
  Postmark, set once by `NOTIFY_FROM` and `NOTIFY_VIA`
  (`resend|postmark[:slug]`); it never throws. Run it with
  `afterResponse(c, …)` so the visitor does not wait and the Worker does not
  stop before it is sent.
- **Spam** (`spam.tsx`): every public form carries `<SpamFields>` and is
  checked with `verdict`.

## Installing a skill's code into this app

Copy the files the app uses into `src/<skill>/`, with what they import
(this skill's go in `src/data/`, so `../data/db` resolves as it does in the
skills repo) and the tests that cover them (`data/test/scratch.ts` for any
database test). The copy is this app's code: change it as the app needs,
keeping the rules above and its tests passing. Then:

1. Run its `schema.sql` with `applySchema` from the app's setup or start
   script (machine only, never per request):
   `await applySchema(db, readFileSync("src/booking/schema.sql", "utf8"))`.
2. Add the dependency the handle needs if the app lacks it
   (`@neondatabase/serverless` or `pg`). The tests use `pg` whatever the
   app's handle, so an app on the Neon driver adds `pg` and `@types/pg` as
   dev dependencies.
3. Run the copied tests and the app's typecheck:
   `TEST_DATABASE_URL=postgres://… npx tsx --test src/<skill>/test/*.test.ts`
   (a role that may create databases; each test makes and drops its own).

A machine-only file (`cli.mjs`, a skill's `cli.ts`, booking's `sync.ts` and
`reminders-job.ts`, reports' `print.ts`) runs only on the machine and may
import Node built-ins. Nothing the production Worker imports may reach it;
the app's `npm run check` fails if it does. A `.ts` file imports `cli.mjs`
by its full name (`../data/cli.mjs`), and the app's `tsconfig.json` needs
`"allowJs": true`.

## When the database is not there

No `DATABASE_URL` means the app has no database yet: ask the owner with
`python3 ~/tools/taskandtool.py request-capability postgres`.

## Files

| File | What it is |
|---|---|
| `db.ts` | `Db`, `GetDb`, `q` |
| `neon.ts`, `pg.ts` | the two handles: Neon HTTP (edge and machine), node-postgres (the machine, and production deployed with `nodejs_compat`) |
| `migrate.ts` | `applySchema`, the additive check |
| `email.ts` | `normalizeEmail` |
| `env.ts` | `envVar`, `envOf`, `setting`, `keyName` |
| `gateway.ts` | `gatewayFetch` (machine only at run time) |
| `send.ts` | `sendEmail`, `afterResponse` |
| `spam.tsx` | `SpamFields`, `makeStamp`, `verdict` |
| `token.ts` | `newToken`, `tokenHash`: a key a visitor holds, stored as its hash |
| `cli.mjs` | what every script shares: arguments, usage, `done`, `fail`, `misused`, `machineEnv` (machine only) |
| `test/` | the additive check, the handles, settings, sending, spam |
