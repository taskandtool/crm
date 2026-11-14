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
     Statuses and deal stages are **seeded only into an empty table**. The
     defaults were seeded when the database appeared. On a running CRM,
     editing these lists in the config changes nothing: use lever 2, then
     make the config match for a fresh install.
   - `tasks`: `{ "new_lead": false }` stops the same-day "Call back"
     task that a deal made from a lead gets.
   - `sources`: suggestions for the Source field.
   - `fields`: custom fields (lever 3).
   - `owner_label`: what the owner column is called (`Technician`,
     `Dentist`, `Provider`). An owner is free text: a team member's email
     when they sign in to Task & Tool, otherwise their name (`Kim`).
     Write each person the same way every time: the list's filter treats
     `Kim` and `kim@acme.com` as two owners.
   - `time_zone`: the business's IANA zone. Automatic texts and their
     quiet hours, the digest, recurring invoices and the dates a script
     reads all use it. It ships as `UTC`; set it when shaping. Screens show
     each person their own browser's zone and fall back to this one. The
     machine's zone is never used.
   - `events`: what one event on the schedule is called (`{ "one":
     "Event", "many": "Events" }`; a trade's "Job", a practice's
     "Appointment"), its own custom `fields` (same shape as lever 3), and
     the `currency` of its amounts; `false` turns the schedule off (the
     counselor). See `references/schedule.md`.
   - `booking`: online booking of the Services. On by default, and it
     needs `events`. Set `false` for a dentist whose practice software
     takes the bookings.
   - `booking_page`: the Website's booking address (`https://acme.com/book`),
     once it has one. Once it is set, the email for a booking the team
     makes has a link to manage the booking there.
   - `invoices`: `{ "currency": "USD", "terms": "...", "days_until_due":
     14, "quote_word": "Estimate" }`: the currency, a new quote's standing
     terms, a new invoice's days to pay (30 when unset), and what a quote
     is called everywhere (`Quote`, `Proposal` or `Estimate`). `false`
     leaves quotes and invoices out.
   - `business`: one line about the business. It ships as `to fill`;
     writing the real line retires the "Set up the CRM for my business"
     suggestion.

   After a change: `npm run check` (dev restarts on save).

   The business's name, its privacy and terms pages and its postal
   address are not in the file. They are one row that every app shares,
   and they appear on texts, quotes, invoices, the forms' texting box and
   the follow-up emails. Set them with
   `node scripts/business.mjs set --name "Acme Plumbing" --privacy <url>`
   (the owner sees them in Settings, Business); ask for the real name
   before the first quote or text goes out.

2. **Statuses and deal stages are rows**, in `pipeline_stages` and
   `deal_stages`, edited on `/stages` or with `node scripts/stages.mjs`
   (`--statuses` for a customer's). New customers and deals start in the
   first open one. A stage is archived, never deleted, and only when it is
   empty; `--move-to` moves what is in it in the same transaction. Each
   list keeps at least one open stage.

3. **A custom field needs no migration.** Add it to `fields`:
   `{ "key": "truck", "label": "Truck", "type": "select", "options": ["Truck 1", "Truck 2"] }`
   (types `text`, `number`, `date`, `select`, `phone`, `email`; keys are
   `snake_case`, and `npm run check` refuses a built-in column's name).
   Values are stored in `customers.fields` (jsonb) and show on the
   customer page, in the CSV, in the import (header matched by key or
   label) and in the scripts (`--field truck="Truck 2"`). A form answer
   whose name is a field's key fills that field when the submission's
   person is saved, on any app. Answers named `address` and `company` fill
   those columns the same way. This works because the CRM publishes its
   fields at every start and deploy. Removing a field from the config
   hides it; the data stays. A custom field holds one value per customer,
   and the list cannot filter by it. For "everyone at the North location",
   use a tag or lever 4.

4. **`schema.sql`, for a real column** (indexed, filtered, joined on),
   following the `database` skill's table rules. It runs at every start,
   dev's too, against the database production also uses:

   ```sql
   alter table customers add column if not exists region text;
   create index if not exists customers_region on customers (region);
   ```

   Then add it to `src/crm/customers.ts` and the views, `npm run check`
   and `npm test`.

## Deals and tasks

The code does these; never do them by hand:

- A deal belongs to one customer, who may have many over the years. Moving
  one to a won stage moves its customer from an open status to the first
  won one; lost and won stages close it.
- A deal with a blank value shows the total of its latest quote
  (`quotes.mjs add --deal <id>`, or New quote on the deal's page). Accepting
  that quote wins the deal, whether on the page, by script or by paying online.
- A done task goes on the timeline as a note of its kind. A done call
  counts as contact, and so does a quote or an invoice that went out.
  "Nothing planned" (the Contacts filter, `tasks.mjs list --none`) is
  everyone with an open status or an open deal and no open task or
  scheduled event.
- Once a day, each person gets the morning email with their tasks due.
  It goes through the app's email sender. Task & Tool email is enough:
  the morning email goes only to the team. The same job makes the
  follow-up task for an unsigned proposal.
  Schedule it once (the `schedule-job` skill):
  `python3 ~/tools/taskandtool.py schedule-job "Task emails"
  --when "0 * * * *" --route /_jobs/task-emails` (hourly; it
  sends at 7:00 in the business's zone, `DEFAULT_HOUR` in
  `src/crm/digest.ts`).
  An owner written as an email gets one, and so does a team member
  (Settings, Team) written by name.
- Two records of one person: `customers.mjs merge <keep> <other>` shows
  a preview; add `--confirm` after the owner says yes. The kept record has
  the other's email as a second address, and their history. A merge cannot
  be undone.

