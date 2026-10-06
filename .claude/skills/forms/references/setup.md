# Putting forms on a site

Read when an app takes its first form, mounts the form pages, or sets up the owner's email.

## Add a form to a page

The Website has steps 2, 3 and 5 done (`src/business.tsx`, `scripts/forms.mjs`):
make the form with `node scripts/forms.mjs save`, set `SPAM_SECRET`, then steps 4 and 6.

1. Look: `select key, title, fields from forms`. Reuse a form that
   fits; otherwise pick a key (`quote-request`).
2. Copy `forms/` to `src/forms/` (with `test/`), and `data/`, `admin/`
   and the payments skill's `money.ts` if the app lacks them. In the setup script (machine only):
   `applySchema(db, readFileSync("src/forms/schema.sql", "utf8"))`, then
   `seedForm(db, { key, title, fields }, "<app slug>")`.
3. Mount in `src/app.tsx`, below the page loop:
   `app.route("/", formRoutes(getDb, { source: "<app slug>", page }))`,
   where `getDb(c)` is the app's handle (`data/db.ts`) and
   `page(c, title, body)` wraps a body in the site's layout
   (the Website: `render({ path: c.req.path, title, description: title }, body)`).
4. Serve the page as a route, not a pre-rendered page:
   `app.get("/contact", async (c) => c.html(render(Contact.page, <Contact.Body form={await embedForm(c, getDb(c), "contact")} />)))`.
   `embedForm` is null when the form is missing or switched off; say so in
   the page instead of showing nothing. On the Website the page module is
   then not listed in `src/pages/index.ts` (that would pre-render it), so
   its nav link goes in `site.nav` by hand.
5. Mount `formsAdmin(getDb, { base: "/admin/forms", css, timeZone, source: "<app slug>" })`
   at `/admin/forms` (see the `admin` skill for where private views live),
   and set `SPAM_SECRET`.
6. Set up telling the owner (above) or say there is no sender, then post a
   test submission in dev and find it in `/admin/forms/submissions`.

## The command

An app without `scripts/forms.mjs` gets one when it takes its first form,
so the AI never writes SQL against `forms`. `scripts/forms.ts`:

```ts
import pg from "pg";
import { formsCli } from "../src/forms/cli";
import { fromPool } from "../src/data/pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  await formsCli(process.argv.slice(2), { withDb: (fn) => fn(fromPool(pool)), source: "<app slug>", timeZone: "America/Denver" });
} finally {
  await pool.end();
}
```

and `scripts/forms.mjs` runs it under tsx with `/home/sprite/.env` loaded
(copy another `.mjs` entry, or `tsx --env-file=/home/sprite/.env scripts/forms.ts`).
`src/data/cli.mjs` comes with it.

## Steps, a booking and a payment

Mount the routes once with the steps the app carries:

```ts
app.route("/", formRoutes(getDb, {
  source: "website", page,
  steps: {
    booking: bookingStep(getDb, { source: "website" }),                              // booking/form-step.tsx
    payment: paymentStep(getDb, (c) => stripeFrom(envOf(c)), { source: "website" }), // payments/form-step.tsx
  },
  onComplete, // the booking's confirmation once the form is done: booking/confirm.ts
}));
```

A form that ends in payment completes in the payments webhook instead
(`afterPaid`, the payments skill's setup), which confirms its booking the
same way. A form with
a step that is not wired shows "not ready" and logs which line is missing.
When a form sells things, load `cart.js` on every page (the Website:
`cart: true` in `src/site.ts`).

## Telling the owner

The owner's email comes once the questions are answered, with what was
ordered and its total; a booking and a payment follow it, and the
submission shows them. Configured once for every skill that sends
(bookings use the same):
`NOTIFY_FROM`, an address on a domain verified with the vendor, and
`NOTIFY_VIA=resend` or `postmark`, with `:<slug>` when the connection's
endpoint slug is not the vendor's name.

| Where | What it needs |
|---|---|
| production (the Worker) | the key bound to the Worker (`python3 ~/tools/taskandtool.py request-connection resend --why "send form emails" --delivery edge`) |
| dev (this machine) | nothing more: the gateway adds the key, which never reaches the machine |

A bound key's env name is the connection's `env_name` in
`python3 ~/tools/taskandtool.py list-connections` (`<SLUG>_API_KEY`, so `RESEND_API_KEY` for slug
`resend`); check it there rather than assuming. `sendEmail` returns
`{ status: "sent" | "none" | "failed" }` and never throws; a failure is
logged and the submission is already saved.

## A `leads` table

A Website without this skill keeps its contact form in a `leads` table. When
the project has one, copy it once, from the machine, then write only to
`submissions` with form key `contact`. Never drop `leads`: it is the owner's
data.

```sql
insert into submissions (form_key, name, email, phone, data, source, page, created_at)
select 'contact', l.name, lower(trim(l.email)), l.phone,
       case when l.message is null then '{}'::jsonb else jsonb_build_object('message', l.message) end,
       l.source, l.page, l.created_at
from leads l
where not exists (select 1 from submissions s
                  where s.form_key = 'contact' and s.email = lower(trim(l.email)) and s.created_at = l.created_at);
```

`CONTACT_FORM` in `store.ts` is the same name, email, phone and message form,
seeded as the `contact` row.
