# The levers

Read when changing what the CRM calls things, its statuses or deal stages, its fields or its tables, or when setting up deals, tasks or the morning email.

## The four levers

Everything a business wants changed is one of these.

1. **`crm.config.json`**, read at start and validated (a bad file stops the
   server with the reason; `npm run check` says it first).
   - `vocabulary`: what the people are called; Contact / Contacts by
     default (everyone, before and after they buy), `{ "one": "Patient",
     "many": "Patients" }` for a dentist.
   - `statuses`: who a customer is (`Lead`, `Customer`, `Not a fit`), as
     `{ key, label, kind }`, kind `open`, `won` or `lost`.
   - `deals`: what one piece of work being won is called (`{ "one":
     "Request", "many": "Requests" }`), its `stages` (the same shape), the
     `currency` of its values, and the `lost_reasons` offered.
     Statuses and deal stages are **seeded only into an empty table**, and
     the service seeded the defaults the moment the database appeared. On a
     running CRM the config's lists change nothing: use lever 2, then make
     the config match so a fresh install gets the same.
   - `tasks`: `{ "new_lead": false }` stops the same-day "Call back"
     task that a deal made from a lead gets.
   - `sources`: suggestions for the Source field.
   - `fields`: custom fields (lever 3).
   - `owner_label`: what the owner column is called (`Technician`,
     `Dentist`, `Provider`). An owner is free text: a team member's email
     when they sign in to Task & Tool, otherwise their name (`Kim`).
     The list filters by whatever is there, so use one form per person, or
     the filter splits them.
   - `time_zone`: an IANA name. Every time on a page, and the "when" of a
     note, is in this zone; it ships as `UTC`, so setting it is part of
     shaping. The machine's clock never decides.
   - `events`: what one event on the schedule is called (`{ "one":
     "Event", "many": "Events" }`; a trade's "Job", a practice's
     "Appointment"), its own custom `fields` (same shape as lever 3), and
     the `currency` of its amounts; `false` turns the schedule off (the
     counselor). See `references/schedule.md`.
   - `booking`: online booking (the Services customers book). `false` for
     the dentist whose practice software books; needs `events`. On
     otherwise.
   - `booking_page`: the Website's booking address (`https://acme.com/book`),
     once it has one, so the email for a booking the team makes carries a
     link to manage it there.
   - `invoices`: `{ "currency": "USD", "terms": "...", "days_until_due":
     14 }`: the currency, a new quote's standing terms, a new invoice's
     days to pay. `false` leaves quotes and invoices out.
   - `business`: one line about the business. It ships as `to fill`;
     writing the real line retires the "Shape the CRM" suggestion.

   After a change: `npm run check` (dev restarts on save).

   The business's name, its privacy and terms pages and its postal
   address are not in the file: they are one row every app shares, which
   texts, quotes, invoices, the texting box on the forms and the follow-up
   emails all print. Set them with
   `node scripts/business.mjs set --name "Acme Plumbing" --privacy <url>`
   (the owner sees them in Settings, Business); ask for the real name
   before the first quote or text goes out.

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
   (`--field truck="Truck 2"`). A form answer named with a field's key
   fills it when the submission saves its person, on any app (the CRM
   publishes its fields at every start and deploy), as answers named
   `address` and `company` fill those. Removing a field from
   the config hides it; the data stays. A custom field holds one value per
   customer, and the list cannot filter by one (for "everyone at the North
   location", use a tag or lever 4).

4. **`schema.sql`, for a real column** (indexed, filtered, joined on). It is
   applied by `applySchema` (`src/data/migrate.ts`) at every start and every
   deploy, so each line is safe to run again; a column on a table that is
   already there is its own line:

   ```sql
   alter table customers add column if not exists region text;
   create index if not exists customers_region on customers (region);
   ```

   A new column gets its own `alter table ... add column if not exists`
   line (a `create table if not exists` skips a table that is already
   there). Never drop, rename or change a type; `applySchema` refuses a
   file that does, before running any of it. Name an index after its table. Then
   add it to `src/crm/customers.ts` and the views, `npm run check`
   and `npm test`.

## Deals and tasks

The rules the code keeps, so the AI never redoes them by hand:

- A deal belongs to one customer, who may have many over the years. Moving
  one to a won stage moves its customer from an open status to the first
  won one; lost and won stages close it.
- A deal with a blank value shows the latest quote made for it
  (`quotes.mjs add --deal <id>`, or New quote on the deal's page). That
  quote's yes wins the deal, whether given on the page, by script or by
  paying online.
- A done task goes on the timeline as a note of its kind, so a done
  call counts as contact; so does a quote or an invoice that went out.
  "Nothing planned" (the Contacts filter, `tasks.mjs list --none`) is
  everyone with an open status or an open deal and no open task or
  scheduled event.
- The morning email lists each person's tasks due, through the
  owner's connected sender, once a day. Schedule it once a sender is set
  up: `python3 ~/tools/taskandtool.py schedule-job "Task emails"
  --when "0 * * * *" --command "npx tsx src/crm/digest-job.ts"` (hourly; it
  sends at 7:00 in the business's zone, `--hour` to change). An owner
  written as an email gets one, and so does a team member (Schedule's
  Team) written by name.
- Two records of one person: `customers.mjs merge <keep> <other>` shows
  a preview; add `--confirm` after the owner says yes. The kept record
  also goes by the other's email, so their history follows. A merge cannot
  be undone.

