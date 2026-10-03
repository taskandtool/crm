---
name: crm
description: "Run and reshape this CRM: the levers (crm.config.json, stages, custom fields, jobs or visits, additive schema.sql), what came in, team-only production, and the scripts for customers, notes, jobs, import and export. Use for 'shape the CRM', 'add a customer', 'log a job', 'who got in touch', 'import my list', 'publish it'."
---

# CRM

This app is a customer record on Hono: server-rendered JSX, htmx for the
round trips, SortableJS on the pipeline only, Postgres for the data, no
client framework. **Dev** is this machine's `web` service; **production**
is the same app deployed to Cloudflare. `AGENTS.md` says where things are;
this file is how to change it.

## The tables

The project has one Postgres database, and every app in it uses the same
tables by their plain names.

- **The CRM's own:** `customers`, `pipeline_stages`, `customer_notes`,
  `customer_visits` (`schema.sql`). Booking and the Board read `customers` too, so its
  columns keep their names and meanings.
- **Other apps' tables it reads:** `submissions` (and `forms` for titles)
  from the Website's forms, `bookings` (and `resources`) from Booking,
  `payments` from Stripe checkouts. Any of them may be missing: the pages
  leave a missing one out with a sentence, and every query checks first
  (`src/crm/tables.ts`). The only column of another app's table the CRM
  writes is `submissions.status`, `new`/`read` to `done` (Mark done).
- **A person is their email.** `customers.email` is `citext`, unique when
  present, stored through `normalizeEmail`. A customer may have only a
  phone: phone is the fallback match (its last ten digits,
  `src/crm/phone.ts`), and only where one side has no email, so two
  people with different emails on one household phone stay two people.
  Inbox matching, Add as customer, `customers.mjs add` and the import all
  use this one rule; keep it that way.

## The four levers

Everything a business wants changed is one of these.

1. **`crm.config.json`**, read at start and validated (a bad file stops the
   server with the reason; `npm run check` says it first).
   - `vocabulary`: `{ "one": "Patient", "many": "Patients" }`.
   - `stages`: `{ key, label, kind }`, kind `open`, `won` or `lost`.
     **Seeded only into an empty `pipeline_stages`**, and the service seeded
     the defaults the moment the database appeared. On a running CRM the
     config's stages change nothing: use lever 2, then make the config
     match so a fresh install gets the same.
   - `sources`: suggestions for the Source field.
   - `fields`: custom fields (lever 3).
   - `owner_label`: what the owner column is called (`Technician`,
     `Dentist`, `Provider`). An owner is a team member's email when they
     sign in to Task & Tool, otherwise just their name (`Kim`): it is free
     text, and the list filters by whatever is there. Use one form per
     person, or the filter splits them.
   - `time_zone`: an IANA name. Every time on a page, and the "when" of a
     note, is in this zone; it ships as `UTC`, so setting it is part of
     shaping. The machine's clock never decides.
   - `default_view` (`list` or `pipeline`) and `pipeline` (`false` hides it,
     for a business that only wants a record).
   - `inbox`: `forms` is `"all"` or a list of form keys that count as
     people getting in touch; `exclude_forms` drops some (`newsletter`);
     `bookings` and `payments` turn those sources off. Find the form keys
     with `select key, title from forms`.
   - `visits`: what one job, visit, appointment or event is called
     (`{ "one": "Job", "many": "Jobs" }`), its own custom `fields` (same
     shape as lever 3), and the `currency` of its amounts; `false` turns
     them off (the counselor). See "Jobs and visits" below.
   - `business`: one line about the business. It ships as `to fill`;
     writing the real line retires the "Shape the CRM" suggestion.

   After a change: `sprite-env services restart web`, then `npm run check`.

2. **Stages are rows** in `pipeline_stages`, edited on `/stages` or with
   `node scripts/stages.mjs`. New people land in the first open stage. A
   stage is archived, never deleted, and only once nobody is in it
   (`--move-to` moves them in the same transaction); there is always at
   least one open stage.

3. **A custom field needs no migration.** Add it to `fields`:
   `{ "key": "truck", "label": "Truck", "type": "select", "options": ["Truck 1", "Truck 2"] }`
   (types `text`, `number`, `date`, `select`, `phone`, `email`; keys are
   `snake_case` and never a built-in column name). Values live in
   `customers.fields` (jsonb) and show on the customer page, in the CSV,
   in the import (header matched by key or label) and in the scripts
   (`--field truck="Truck 2"`), and Add as customer fills it from a form
answer whose name is the field's key (as it fills Address and Company from
answers named `address` and `company`; a value the customer form would
refuse is left out, and a customer who already has a value keeps it; a row
with no phone takes the latest one that email gave). Removing one from the config hides it; the
   data stays. Two limits to tell the owner when they matter: a custom
   field holds one value per customer (which truck went to each job is a
   visit field, below), and the list cannot filter by one (for "show me
   everyone at the North location", use a tag or lever 4).

4. **`schema.sql`, for a real column** (indexed, filtered, joined on). It is
   applied by `applySchema` (`src/data/migrate.ts`) at every start and every
   deploy, by every copy of this app at any version, so it only adds:

   ```sql
   alter table customers add column if not exists region text;
   create index if not exists customers_region on customers (region);
   ```

   A new column gets its own `alter table ... add column if not exists`
   line (a `create table if not exists` skips a table that is already
   there). Never drop, rename or change a type; `applySchema` refuses the
   file before running any of it. Name an index after its table. Then
   restart, add it to `src/crm/customers.ts` and the views, `npm run check`
   and `npm test`.

## Jobs and visits

`customer_visits` holds one row per occasion: a plumber's job, a dentist's
visit, a restaurant's event. Each has what it was (`title`), when
(`starts_at`, null while not scheduled), a status (`planned`, `done`,
`cancelled`; never deleted), who did it (`owner`, `owner_label` names it),
an amount in minor units with its `currency`, notes, and the config's
`visits.fields` in `fields` (jsonb). Pages: `/visits` (coming up, soonest
first, then Done and All, CSV of each) and a section on every customer's
page. Two rules the code keeps: done counts as contact, and done is never
in the future (one marked done early happened now); someone with a visit
planned from now on is not a follow-up.

A fact about the customer is a customer field (their system, their
insurer); a fact about one occasion is a visit field (the truck that went,
the party size, the reason for the visit). It is a record, not a
schedule: times people book stay in `bookings`, and a booking becomes a
visit only when the owner asks (`visits.mjs add`).

## Dev, on this machine

```bash
sprite-env services get web
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/healthz      # 200 once the database is ready
curl -s -H 'X-TaskTool-User: you@example.com' localhost:3000/customers | head
tail -50 /.sprite/logs/services/web.log
```

Every path but `/healthz` answers 404 without `X-TaskTool-User`: that is
the gate (`src/admin/guard.ts`), not a fault. If the service is missing,
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
- The CRM sends no email or text, and Task & Tool never sends for it. A
  note of kind `email`, `call` or `text` records contact that happened
  elsewhere. If the owner wants to send from here, that is their own
  provider through the `data` skill's `send.ts`, built when asked.

## Your hands: the scripts

Every script answers `--help`, takes `--json`, and works on a fresh
database (it runs the same setup the service does).

```bash
node scripts/inbox.mjs --since 7d                  # what came in, and who it matched
node scripts/inbox.mjs --unmatched                 # people who are not customers yet
node scripts/inbox.mjs add submission 412          # Add as customer
node scripts/customers.mjs find "lee"
node scripts/customers.mjs add "Ann Lee" --email ann@example.com --phone "555 010 2030" --source Referral --tag VIP --field system="Heat pump"
node scripts/customers.mjs note ann@example.com "Booked a tune-up for Friday" --kind call --at "2026-10-02 14:30"
node scripts/customers.mjs stage ann@example.com won
node scripts/customers.mjs update 42 --owner sam@example.com --field next_service=2027-04-01
node scripts/customers.mjs follow-up --days 14    # open customers gone quiet
node scripts/visits.mjs list                      # coming up; --done, --all, --owner, --customer <who>
node scripts/visits.mjs add ann@example.com "Annual tune-up" --at "2026-10-09 09:30" --owner Sam --field truck="Truck 2"
node scripts/visits.mjs done 12                   # or cancel 12, plan 12
node scripts/visits.mjs update 12 --amount 245.00 --notes "Replaced the igniter"
node scripts/stages.mjs list
node scripts/stages.mjs rename new "New enquiry"
node scripts/stages.mjs archive quoted --move-to won
```

`<who>` is an id, an email or a phone number. `add` never makes a
duplicate: an email or phone already here is reported instead.
`--at` is a wall time in the business's zone.

**Import:** always `--dry-run` first and show the owner the mapping and
the counts, then run it.

```bash
node scripts/import.mjs ~/app/uploads/customers.csv --dry-run
node scripts/import.mjs ~/app/uploads/customers.csv --map name=Client,phone="Cell #" --source "Old spreadsheet"
```

Headers match built-in names and custom fields, not `owner_label`: a
`Hygienist` column needs `--map owner=Hygienist`. Imported people are
created at the moment of the import, so give the file a `--source` (or
`--tag`) that a "new customers" count can leave out.

Rows match existing customers and each other by email, then phone (a
row with neither matches by name a customer with neither). A match only
gains (empty fields filled, tags added); `--overwrite` replaces
values, stage included. Anyone left without a last contact gets the
time of their latest submission, booking or payment, by email. The import
is one transaction. `node
scripts/export.mjs --out customers.csv` is the reverse, and its headers
import back as they are.

## Shaping the CRM for a business

Read `crm.config.json`, the closest of `examples/` (a two-van HVAC shop, a
dental practice, a restaurant with events, a plumber with three locations
and eight trucks, a counselor who only wants a record), and what the
project already knows: the owner's words, a Company Brain's notes, the
Website's forms (`select key, title from forms`). Ask only what you cannot
infer. Then:

1. Write the config: words, stages, sources, fields, owner label, time
   zone, view, inbox, visits (their name and fields, or `false`), the
   business line.
2. Make the live stages match with `scripts/stages.mjs` (rename, add, set
   kind, archive with `--move-to`), since the defaults are already rows.
   Rename in place rather than archive and re-add: the key stays (`new`
   labelled `Enquiry`), which is fine, since nobody sees a key and every
   script takes the label too.
3. `sprite-env services restart web`, `npm run check`, then show the owner
   What came in, a customer and the pipeline.

A location or an insurer is a custom field; the truck that went or a
party size is a visit field; a technician, dentist or hygienist is the
owner. Name, email, phone,
company, address, source, tags and owner are built in and always show;
the config cannot hide them (hiding one is a small edit in
`src/views/`, done only when asked). A practice that keeps clinical or
therapy notes elsewhere keeps them out of this CRM: it is a contact
record, and say so when shaping one.

## Rules

- Email is the key; phone is the fallback, by the one rule above.
- Never hard-delete a customer, a note or a visit: archive, or cancel. The pages and scripts
  have no delete, and adding one is the owner's explicit call.
- Other apps' tables are read only, except `submissions.status`.
- `schema.sql` only adds; table names never change; the config changes
  what people see.
- Production stays team only; every route keeps `teamOnly()`; every change
  is a POST and records who made it.
- Tokens only in markup (`npm run check`), no em dashes in copy.
- Real data only: never invent customers, notes or history.

`src/data/` and `src/admin/` are copies of the `data` and `admin` business
skills, `src/data/` trimmed to what the CRM uses. The others (`forms`,
`booking`, `payments`, `reports`) come with this app as skills: when the
owner asks to edit booking hours or see a report here, copy from them
rather than writing it fresh, and copy the `data` files they import that
`src/data/` lacks (`gateway.ts`, `test/scratch.ts`). `npm run check` allows
Node built-ins only in `src/server.ts` and `src/db/`, so a skill's
machine-only file (`print.ts`, `sync.ts`) stays out of `src/`. A report
here takes the handle as `c.get("db")` and the CRM's own `Layout`
(`src/views/layout.tsx`) as its frame, given a `head` slot for
`ChartScripts` and a nav link; `customer_visits` is the table for "jobs
done per week" or "revenue by technician".
