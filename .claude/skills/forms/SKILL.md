---
name: forms
description: "Forms as rows in the project's database: contact forms, surveys and orders, with steps, things to buy, a booking step and a payment step, and every submission in the one table the CRM reads. Use for any form a visitor fills in or an order page. Not for team-only settings or a login."
---

# Forms

Every form in the project is a row in `forms`, every submission from any
app a row in `submissions`. A form is the one noun: an order, a survey, a
paid appointment with questions are each a form, named for what it takes
(`order`, `intake`), and "my orders" is that form's submissions. A new
form or a new question is a change to a row, never a migration.

Version: 0.2.0 (taskandtool/skills)

## The rules

- **Look first, and use the command.** `node scripts/forms.mjs list` before
  making one; another app may have made it. Make and change forms with
  `node scripts/forms.mjs save <key> --file form.json` (it checks the
  definition as the editor does), never with SQL, never a table per form.
- **The person goes in the columns**: name the fields `name`, `email` and
  `phone`, or the CRM cannot match them. Every other answer is in `data`.
- **One definition** (`fields.ts`) drives the page, the server's
  validation and the editor; the browser's `required` is a convenience.
- **A page with a form is rendered per request**, never pre-rendered: it
  needs the owner's latest definition, a fresh spam stamp and the visit's
  UTM. A pre-rendered page is a static file, served in place of the Worker.
- **Spam** is a honeypot and a 3-second minimum on the server
  (`data/spam.tsx`), nothing to set up. A bot is
  thanked and dropped; a post too fast is kept as spam and nobody is told.
- **No IP addresses**: store only what the visitor typed, the page, and
  where they came from (`data._utm`, the referrer's host in `data._referrer`).
- **Marketing needs a `consent` field**, unticked; `data._consent` keeps
  the exact words agreed to. A contact form is not permission to market.
- **A photo field stores `/_files/<id>`**; open one at
  `localhost:<port>/_files/<id>`.
- **The owner is emailed only through their own sender** (`data/send.ts`);
  Task & Tool sends nothing. No sender: say so.

## Steps, things to buy, a time and a payment

A form's fields say all of it; `node scripts/forms.mjs --help` lists every
field type with its settings.

- `page` starts a step; for one question per page, put a `page` before
  each question. Answers wait as a draft and become a submission when the
  questions are done; drafts never finished are listed as not finished,
  and nobody is emailed about them. A
  submission is complete (`completed_at`) once its last step is done; one
  that ends in payment completes when Stripe says paid (the webhook's
  `afterPaid` calls `completePaidSubmission`). `onComplete` is what the
  app does then (the booking skill's `confirmFormBooking`).
- `items` sells things at a price per unit, `{ key: quantity }` as the
  answer; size or colour is an ordinary field beside it. The cart is
  `cart.js`: "Add to order" buttons (`data-add-to="<form>"
  data-item="<item>"`) and a count (`data-cart-count`) on any page fill the
  form, and submitting is the checkout.
- `booking` (a booking type's slug) and `payment` (fees, a tax rate) are
  steps after the questions, payment last, run by the booking and payments
  skills once the app wires them (`references/setup.md`). How a submission,
  its booking and its payment link: the payments skill's "Submissions,
  bookings and payments".
- `priceOf` (`price.ts`) says what a submission costs: items, the fees that
  apply, a booking's price, from the stored definition, never from the page.

## Files

| File | What |
|---|---|
| `schema.sql` | `forms`, `submissions`, `submission_drafts` |
| `fields.ts` | `Field`, `Form`, `validate`, `checkFields` (step order too), `stepsOf` |
| `routes.tsx` | `formRoutes(getDb, { source, page, steps? })`: POST `/forms/:key`, `/forms/:key/next` (a step), `/forms/:key/start` (a page of its own), `/forms/:key/thanks`; `embedForm` |
| `render.tsx` | `FormView`: one step of a form, accessible, answers put back |
| `store.ts` | `loadForm`, `seedForm`, `insertSubmission`, drafts, `CONTACT_FORM` |
| `steps.ts` | the contract a booking or payment step implements |
| `price.ts`, `linked.ts` | what a submission costs; its booking and payment, for showing |
| `admin.tsx` | `formsAdmin(getDb, { base, css, timeZone, source, Frame?, links? })`: submissions by form with their booking and payment, not finished, the editor |
| `files.ts` | `devFiles()`: `/_files` on the dev server (`src/server.ts`) |
| `origin.ts`, `cart.js`, `cli.ts` | where the visitor came from; the cart; `formsCli` for `scripts/forms.mjs` |
| `test/` | validation, rendering, steps, items, routes and admin on a scratch database |
| `references/setup.md` | when an app takes its first form, wires steps, or sets up the owner's email |
