---
name: forms
description: "Forms as rows in the project's database: a form's fields in forms, every submission in submissions (the CRM reads it), spam checks, a form on a public page in dev and production, the private submissions list and form editor. Use for any form a visitor sends. Not for team-only settings or a login."
---

# Forms

Every form in the project is a row in `forms`, and every submission,
from any app, is a row in `submissions`. A new form, or a new
question on one, is a change to a row, never a migration. The Website embeds
forms on its pages; the CRM and the Booking app read the submissions.

Version: 0.1.0 (taskandtool/skills)

## The rules

- **Look first.** `select key, title from forms` before
  making a form: another app may have made the one you need. Never create a
  table per form, a `leads` table, or a second submissions table.
- **`submissions` is where the CRM looks.** The person goes in the
  columns: a field named `email` fills `email` (lowercased by
  `normalizeEmail`, `citext`), `name` and `phone` likewise. Call those
  fields exactly that, or the CRM cannot match the person. Every other answer
  is in `data`, keyed by field name.
- **The renderer, the validator and the editor read one definition**
  (`fields.ts`). Validate on the server with `validate()`; the browser's
  `required` is a convenience. Fields not in the definition are ignored.
- **303 after the POST**, to `/forms/<key>/thanks` or the form's
  `redirect_to` (a path on this site only). A 422 re-renders the form in the
  app's own page with each message next to its field and the answers put
  back.
- **A page with a form is rendered per request**, not pre-rendered: it
  reads the definition the owner last saved, stamps the time it was served
  and reads the visit's UTM and referrer. A pre-rendered page in production
  is a static file that wins over the Worker, so its form would be stale,
  its stamp a build time and its origin empty.
- **Spam: a honeypot plus a minimum fill time (3 s), on the server**
  (`data/spam.tsx`). A filled honeypot, or a missing or forged stamp,
  is a bot: the post is dropped and still answered with the thank-you
  redirect, so it learns nothing. A post sent too fast is stored with
  `status = 'spam'` and nobody is emailed: an autofilled short form can be
  that fast, and the owner can find it under Spam. Set `SPAM_SECRET` (a
  Worker secret in production, the env in dev) so the stamp is signed;
  without it the stamp is a plain number a bot can fake. Add Turnstile only
  when these fail on a real site.
- **No IP addresses.** Nothing about the visitor is stored but what they
  typed, the page they sent it from, and where they came from: the
  `utm_source`, `utm_medium` and `utm_campaign` of the page holding the form
  as short tokens in `data._utm`, and the referrer's host alone in
  `data._referrer` (never its path or query). UTM is read from the page with
  the form, so put the form on the page an ad or a newsletter links to.
- **Marketing needs a `consent` field**, unticked by default. When ticked,
  `data.<name>` is `true` and `data._consent.<name>` keeps the exact words
  they agreed to, so a later change to the label does not change what was
  agreed. Never treat a contact form as permission to send marketing.
- **Never email through Task & Tool**: there is no route for it. The form's
  `notify_emails` are emailed only through a sender the owner connected
  (`data/send.ts`, below). Without one, a scheduled job can post new
  submissions as activity, or the CRM shows them. Tell the owner which is in
  place.
- **Production runs on Cloudflare**: web-standard APIs only, no Node
  built-ins (the `deploy` skill). The email goes out after the redirect (`afterResponse`).

## Telling the owner

Configured once for every skill that sends (bookings use the same):
`NOTIFY_FROM`, an address on a domain verified with the vendor, and
`NOTIFY_VIA=resend` or `postmark`, with `:<slug>` when the connection's
endpoint slug is not the vendor's name.

| Where | What it needs |
|---|---|
| production (the Worker) | the key bound to the Worker (`request_connection("resend", why, delivery="edge")`) |
| dev (this machine) | nothing more: the gateway adds the key, which never reaches the machine |

A bound key's env name is the connection's `env_name` in
`list_connections()` (`<SLUG>_API_KEY`, so `RESEND_API_KEY` for slug
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

## Files

| File | What it is |
|---|---|
| `schema.sql` | `forms`, `submissions`, their indexes |
| `fields.ts` | `Field`, `Form`, `validate()` (per-field errors, columns vs data), `checkFields()`, `sitePath()` |
| `origin.ts` | where the visitor came from: `originFields` for the page, `readOrigin` for the POST, `cameFrom` to show it |
| `render.tsx` | `FormView`: labels, autocomplete, inputmode, aria wiring, values refilled, the spam and origin fields |
| `store.ts` | `loadForm`, `seedForm` (never overwrites), `insertSubmission`, `CONTACT_FORM` |
| `routes.tsx` | `formRoutes(getDb, opts)`: POST `/forms/:key`, GET `/forms/:key/thanks`; `embedForm` |
| `admin.tsx` | `formsAdmin(getDb, opts)`: forms, submissions (search, form and status filters, bulk, CSV), detail, status, the form editor |
| `test/` | validator, render, and routes plus admin against a scratch database |

It needs `data/` (the handle, settings, spam, sending) and, for
`admin.tsx`, the `admin` skill beside it (`src/admin/`).

## Add a form to a page

1. Look: `select key, title, fields from forms`. Reuse a form that
   fits; otherwise pick a key (`quote-request`).
2. Copy `forms/` to `src/forms/` (with `test/`), and `data/` and
   `admin/` if the app lacks them. In the setup script (machine only):
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
