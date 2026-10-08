# The levers, and jobs

Read when changing what the CRM calls things, its statuses or deal stages, its fields or its tables, or when setting up jobs, deals or the morning email.

## The four levers

Everything a business wants changed is one of these.

1. **`crm.config.json`**, read at start and validated (a bad file stops the
   server with the reason; `npm run check` says it first).
   - `vocabulary`: `{ "one": "Patient", "many": "Patients" }`.
   - `statuses`: who a customer is (`Lead`, `Customer`, `Not a fit`), as
     `{ key, label, kind }`, kind `open`, `won` or `lost`.
   - `deals`: what one piece of work being won is called (`{ "one":
     "Request", "many": "Requests" }`), its `stages` (the same shape), the
     `currency` of its values, and the `lost_reasons` offered.
     Statuses and deal stages are **seeded only into an empty table**, and
     the service seeded the defaults the moment the database appeared. On a
     running CRM the config's lists change nothing: use lever 2, then make
     the config match so a fresh install gets the same.
   - `follow_ups`: `{ "new_lead": false }` stops the "Call back" follow-up
     a lead added from the Inbox gets for that day.
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
   - `inbox`: `forms` is `"all"` or a list of form keys that count as
     people getting in touch; `exclude_forms` drops some (`newsletter`);
     `bookings` and `payments` turn those sources off. Find the form keys
     with `select key, title from forms`.
   - `visits`: what one job, visit, appointment or event is called
     (`{ "one": "Job", "many": "Jobs" }`), its own custom `fields` (same
     shape as lever 3), and the `currency` of its amounts; `false` turns
     them off (the counselor). See "Jobs and visits" below.
   - `booking`: `false` leaves out the team's side of booking (the
     dentist whose practice software books, the counselor). On otherwise.
   - `booking_page`: the Website's booking address (`https://acme.com/book`),
     once it has one, so a booking the team makes mails a manage link there.
   - `invoices`: `{ "name": "Acme Plumbing", "currency": "USD", "terms":
     "...", "days_until_due": 14 }`: the business name printed on quotes,
     the currency, a new quote's standing terms, a new invoice's days to
     pay. `false` leaves quotes and invoices out. It ships with the name
     `to fill`; ask for the real one before the first quote goes out.
   - `business`: one line about the business. It ships as `to fill`;
     writing the real line retires the "Shape the CRM" suggestion.

   After a change: `python3 ~/tools/taskandtool.py restart`, then `npm run check`.

2. **Statuses and deal stages are rows**, in `pipeline_stages` and
   `deal_stages`, edited on `/stages` or with `node scripts/stages.mjs`
   (`--statuses` for a customer's). New ones land in the first open one. A
   stage is archived, never deleted, and only once nothing is in it
   (`--move-to` moves them in the same transaction); each list keeps at
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
planned from now on has something planned.

A fact about the customer is a customer field (their system, their
insurer); a fact about one occasion is a visit field (the truck that went,
the party size, the reason for the visit). It is a record, not a
schedule: times people book stay in `bookings`, and a booking becomes a
visit only when the owner asks (`visits.mjs add`).

## Deals and follow-ups

The rules the code keeps, so the AI never redoes them by hand:

- A deal belongs to one customer, who may have many over the years. Moving
  one to a won stage moves its customer from an open status to the first
  won one; lost and won stages close it.
- A blank value shows the latest quote made for the deal (`quotes.mjs add
  --deal <id>`, or New quote on the deal's page), and that quote's yes, on
  the page, by script or paid online, wins the deal.
- A follow-up done goes on the timeline as a note of its kind, so a call
  done is contact; so is a quote or an invoice that went out. "Nothing planned" is everyone with an open status or an
  open deal and no open follow-up or planned visit.
- The morning email lists each person's follow-ups due, through the
  owner's connected sender, once a day. Schedule it once a sender is set
  up: `python3 ~/tools/taskandtool.py schedule-job "Follow-up emails"
  --when "0 * * * *" --command "npx tsx src/crm/digest-job.ts"` (hourly; it
  sends at 7:00 in the business's zone, `--hour` to change). Only owners
  written as an email get one.
- Two records of one person: `customers.mjs merge <keep> <other>`, which
  previews; `--confirm` after the owner says yes. The kept record also
  goes by the other's email, so their history follows. Not undone.

