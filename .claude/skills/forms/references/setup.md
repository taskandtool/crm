# Putting forms on a site

Read when an app takes its first form, mounts the form pages, or sets up the owner's email.

## Add a form to a page

The Website already has steps 2, 3 and 5 done (`src/business.tsx`, `scripts/forms.mjs`):
there, make the form with `node scripts/forms.mjs save`, then do steps 4 and 6.

1. Look: `select key, title, fields from forms`. Reuse a form that
   fits; otherwise pick a key (`quote-request`).
2. Copy `forms/` to `src/forms/` (with `test/`), and `data/`, `admin/`,
   `customers/`, `payments/` and `booking/` if the app lacks them (the
   inbox shows a submission's booking and payment). In the setup script (machine only):
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
   the page instead of showing nothing. On the Website, leave the page
   module out of `src/pages/index.ts` (listing it there would pre-render
   it), and add its nav link to `site.nav` by hand.
5. Mount `formsAdmin(getDb, { base: "/admin/submissions", css, timeZone, links: { booking: (id) => `/admin/schedule/${id}`, payment: (id) => `/admin/payments/${id}` } })`
   at `/admin/submissions` (see the `admin` skill for where private views
   live), and apply the `customers` skill's `schema.sql` with the forms one:
   a submission shows the person's notes.
6. Set up telling the owner ("Telling the owner", below) or say there is no sender, then post a
   test submission in dev and find it in `/admin/submissions`.

## The command

An app without `scripts/forms.mjs` gets one when it takes its first form,
so the AI never writes SQL against `forms`. `scripts/forms.ts`:

```ts
import { formsCli } from "../src/forms/cli";
import { machineEnv } from "../src/data/cli.mjs";
import { fromPool, openPool } from "../src/data/pg";

const pool = openPool(machineEnv().DATABASE_URL, 2);
try {
  await formsCli(process.argv.slice(2), { withDb: (fn) => fn(fromPool(pool)), source: "<app slug>", timeZone: "America/Denver" });
} finally {
  await pool.end();
}
```

and `scripts/forms.mjs` runs it under tsx (copy another `.mjs` launcher and
`scripts/run.mjs`). `src/data/cli.mjs` comes with it; `machineEnv()` reads
`~/.env`, which a chat shell may not have loaded.

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

The form's `notify_emails` are emailed once the questions are answered,
with what was ordered and its total; a booking and a payment follow it, and
the submission shows them, with who the email reached (`notified`). A form
saved without a list goes to the owner.

**Task & Tool email** sends it with nothing to set up, to people who can
open this app in Task & Tool (`python3 ~/tools/taskandtool.py request-connection taskandtool --why "email the team new submissions"` if it is not on).
Anyone else on the list needs Resend or Postmark, configured once for
every skill that sends: `NOTIFY_FROM`, an address on a domain verified
with the vendor, and `NOTIFY_VIA=resend` or `postmark`, with `:<slug>`
when the connection's endpoint slug is not the vendor's name.

| Where | What it needs |
|---|---|
| production (the Worker) | the key bound to the Worker (`python3 ~/tools/taskandtool.py request-connection resend --why "send form emails" --delivery edge`) |
| dev (this machine) | nothing more: the gateway adds the key, which never reaches the machine |

The bound key's env name, and what `sendEmail` returns: the `data` skill's
Email.
