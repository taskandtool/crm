# CRM

The customer record for a small business: everyone who got in touch, in
one place, and what happened next. Its first screen is **what came in**
across the project (form submissions from the Website, bookings, payments),
newest first, each matched to a customer by email or offered as a new one.
Then the customers themselves, a pipeline you drag between stages, and a
timeline of notes, calls and visits per customer. It works the minute it
is installed and is shaped for the business by talking to the app's AI:
an HVAC shop, a dental practice, a restaurant, a plumber with several
locations and trucks, a counselor who only wants a record of who called.

This repository *is* the app. On Task & Tool it is cloned onto the app's
own machine, served from there, and everything in it is yours. It also
runs anywhere with Node 20 and a Postgres.

## What is in the box

- **What came in**: form submissions (not spam), bookings and paid
  payments from the project's other apps, with Add as customer and Mark
  done. A source the project does not have yet is simply left out.
- **Customers**, keyed by email (a phone alone is fine too): search by
  name, email, phone or company, filter by stage, tag and owner, export the
  filter as CSV, archive (never delete).
- **A customer's page**: details and custom fields, stage, tags, owner,
  a notes timeline, and everything they sent, booked and paid.
- **A pipeline** of stages you name and order, with drag between them,
  or a select on each card without JavaScript.
- **CSV import** of the list you keep today, matched by email then phone
  so nobody is added twice, with a dry run first.
- **The AI's hands**: scripts to find, add, update, note, stage, tag,
  import and export customers from chat, and to list what came in.

## Shaping it

`crm.config.json` holds the words (`Patients`, `Guests`, `Clients`), the
stages seeded on the first run, sources, custom fields (`text`, `number`,
`date`, `select`, `phone`, `email`, no migration needed), what the owner
is called, the time zone and which forms count as leads. `examples/` has
five worked configs. Ask the AI to shape the CRM for your business; it
reads them, asks what it cannot infer, and sets it up. Stages are rows
after the first run (the Stages page). A field that deserves a real column
is an additive line in `schema.sql`.

## How it runs

- **Dev, on Task & Tool:** the platform clones this repository, runs
  `.taskandtool/setup.sh` (dependencies, CSS, the `web` service), grants
  the project's Postgres as `DATABASE_URL`, and the CRM sets its tables up.
  The team opens it from the app's Development link.
- **Production, on Cloudflare:** `npm run deploy` applies the schema from
  the machine, builds, and deploys. It stays team only: Task & Tool signs
  your team in and tells the CRM who they are, which is the whole login.
  Without that, every page answers 404.
- Anywhere else: `npm install`, put `DATABASE_URL` (any Postgres) and
  `ADMIN_DEV_USER=<your email>` in the environment, `npm run dev`, and open
  `http://localhost:3000`. `npm run check` and `npm test` are the checks;
  the database tests run when `TEST_DATABASE_URL` is set.

## Layout

```
crm.config.json          the levers: words, stages, sources, fields, zone, inbox
schema.sql               the tables, additive only, applied at start and deploy
src/app.tsx              the Hono app: the team-only gate, the routes
src/crm/                 customers, stages, notes, what came in, history, import
src/views/               what came in, customers, a customer, pipeline, stages
src/data/  src/admin/    copies of the data and admin business skills
scripts/                 customers, inbox, stages, import, export, migrate (--help)
styles/  static/         the tokens; the built CSS, vendored htmx and SortableJS, crm.js
examples/                hvac, dental, restaurant, plumbing, counselor configs
test/                    node:test
.claude/skills/crm/      the skill the AI reads; .agents/skills/crm/ is the Codex adapter
.taskandtool/setup.sh    what the machine needs; idempotent
```

## Stack

Hono with server-rendered JSX, `pg` on Postgres with plain SQL, Tailwind
v4 as tokens, htmx for the round trips, SortableJS for the pipeline. No
client framework, no ORM, no login of its own, no email sent. MIT.
