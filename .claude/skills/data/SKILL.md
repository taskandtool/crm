---
name: data
description: "The code every business skill's snippets build on, copied into src/data/: the Db handle and applySchema, settings, sending email, spam checks, the business's name and address, unsubscribes, visitor keys, script helpers. Use before copying another skill's code into the app. Table rules are the `database` skill's."
---

# Data

The code the other business skills import, and the conventions their
snippets keep. The project's table rules (naming, emails, money, times,
who wrote a row) are the `database` skill's; connection calls and
scheduled route jobs are the `connections` and `schedule-job` skills'.

## The database handle

Snippets take a `Db` (`db.ts`): `db.sql` runs one statement and returns its
rows; `db.transaction([q`…`, q`…`])` runs statements all or nothing. Every value
is a parameter. A transaction is non-interactive: decide inside the SQL
(`insert … select … where not exists`, `returning`), not in JavaScript
between statements. That is the shape the Neon HTTP driver allows, so it is
the only one a snippet assumes.

Every route factory takes a `GetDb`, `(c) => Db`: made per request from the
binding in production, the app's one handle in dev.

Store an email through `normalizeEmail` (`email.ts`). A `schema.sql`
runs every time the app starts, so each statement must be safe to run
again: `create table if not exists`, `create index if not exists`, and a
column added to an existing table on its own line, `alter table x add
column if not exists y …`.

Each app makes its handle from the driver it already uses:

- **The Neon HTTP driver** (the Website): `fromNeon(envVar(c,
  "DATABASE_URL"))` from `neon.ts`, the same in dev and production.
- **`pg`** (the CRM): `fromPool(openPool(url))` from `pg.ts`. In dev, the
  server's one pool. In production, a pool per request on
  `env.DATABASE_URL`, closed in `ctx.waitUntil`, deployed with
  `--flag nodejs_compat` (the `deploy` skill).

## Settings, email, spam

- **Settings** (`env.ts`): `envVar(c, name)` reads a Worker binding in
  production and `process.env` in dev; `envOf(c)` passes them to code that
  takes an `Env`. Never `c.env ?? process.env`: on the machine `c.env` is
  node-server's `{ incoming, outgoing }`, so that reads nothing.
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
  (a bot: thank it and save nothing), `spam` (a form keeps it marked spam; the booking
  page asks them to press again), or `ok`.
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
keeping the `database` skill's table rules and its tests passing. Then:

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

## Files

| File | What it is |
|---|---|
| `db.ts` | `Db`, `GetDb`, `q` |
| `neon.ts`, `pg.ts` | the two handles: `fromNeon` (Neon HTTP, edge and machine); `openPool`, `fromPool` (node-postgres: the machine, and production deployed with `nodejs_compat`) |
| `migrate.ts` | `applySchema` |
| `email.ts` | `normalizeEmail` |
| `env.ts` | `envVar`, `envOf`, `setting`, `connectionsOf` |
| `gateway.ts` | `gatewayFetch(envOf(c), slug, path, init)`, `listConnections`, `gatewayReachable`: the `connections` skill's calls, in dev and production |
| `jobs.ts` | `jobRoutes`: a Hono app for `/_jobs/` routes whose throws answer a JSON 500 (the `schedule-job` skill); `isJob`: whether a request is a job's run |
| `send.ts` | `sendEmail`, `emailsCustomers`, `teamOf` (who Task & Tool email reaches), `afterResponse` |
| `spam.tsx` | `SpamFields`, `makeStamp`, `verdict` |
| `schema.sql` | `business`, `email_optouts`, `unsubscribe_keys` |
| `business.ts` | `businessOf`, `saveBusiness`, `checkBusiness` |
| `unsubscribe.tsx` | `unsubscribeLink`, `unsubscribe`, `emailOptedOut`, `unsubscribeRoutes` |
| `token.ts` | `newToken`, `tokenHash`: a key a visitor holds, stored as its hash |
| `cli.mjs` | what every script shares: arguments, usage, `done`, `fail`, `misused`, `machineEnv` (machine only) |
| `test/` | statements and transactions, applying a schema, settings, the gateway, sending, spam, the script helpers |
