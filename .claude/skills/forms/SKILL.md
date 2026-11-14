---
name: forms
description: "Builds forms stored as rows in the project's database: contact forms, surveys and orders, with steps, things to buy, a booking step and a payment step. Every submission goes in one table the CRM reads; leads go to a CRM, webhook or email when asked. Use for any form a visitor fills in, an order page, or sending leads somewhere."
---

# Forms

Every form in the project is a row in `forms`, every submission from any
app a row in `submissions`. Orders, surveys and paid appointments with
questions are all forms, named for what they take (`order`, `intake`).
"My orders" is that form's submissions. A new form or a new question is a
change to a row, never a migration.

## The rules

- **Look first, and use the command.** `node scripts/forms.mjs list` before
  making one; another app may have made it. Make and change forms with
  `node scripts/forms.mjs save <key> --file form.json`. `save` checks the
  definition the same way the editor does. Never write forms with SQL or
  make a table per form.
- **The person goes in the columns**: name the fields `name`, `email` and
  `phone`, or the CRM cannot match them. Every other answer is in `data`.
  An answer named `address`, `company` or a CRM custom field's key is
  copied to their customer record. The person and a lead are saved when a
  submission comes in, or when the team marks it not spam (`saveSubmitter`,
  the customers skill). Save a newsletter sign-up or a job application
  with `"leads": false`: the person is saved and no lead is made.
- **One definition** (`fields.ts`) is used by the page, the server's
  validation and the editor. The browser's `required` is only a
  convenience.
- **A page with a form is rendered per request**, never pre-rendered: it
  needs the owner's latest definition, a fresh spam stamp and the visit's
  UTM. A pre-rendered page is a static file, served in place of the Worker.
- **Spam** is a honeypot and a 3-second minimum (`data/spam.tsx`), nothing
  to set up. A post with no valid stamp gets a thank-you and is dropped. A
  filled honeypot or a post that comes too fast is kept as spam, because a
  browser can fill the honeypot for a real person. Nobody is told.
- **No IP addresses**: store only what the visitor typed, the page, and
  where they came from (`origin.ts`): the five UTMs, click ids, the
  referrer's host, the landing page, the first visit. Put `ORIGIN_SCRIPT`
  inline in a public site's layout (the Website's has it) to keep a
  visitor's tags from page to page.
- **A failed save keeps the answers.** A form's first post is saved once,
  however often it arrives. A failed save is tried again while the visitor
  waits. If that fails too, the visitor gets Try again with their answers
  kept, and the team gets a copy.
- **Marketing needs a `consent` field**, unticked; `data._consent` keeps
  the exact words agreed to. A contact form is not permission to market.
- **The texting box** shows under the phone field of a form with "Follow
  up automatically" on, and on the booking page, once the business has a
  number and a name: pass `textConsent: (c) => textingBox(getDb(c),
  "request")` (`consent.ts`). What was ticked is kept word for word in
  `text_consent`. Never write the box's words yourself.
- **A photo field stores `/_files/<id>`.** The file is served from the
  app's addresses, and in dev from `devFiles()` at
  `localhost:<port>/_files/<id>`.
- **A form's `notify_emails` get an email for each submission**
  (`team: true` mail, `data/send.ts`), through Task & Tool email or the
  owner's Resend or Postmark. The submission's `notified` says who it
  reached, or why not. With no sender, tell the owner.

## Steps, things to buy, a time and a payment

The form's fields define all of these. `node scripts/forms.mjs --help`
lists every field type with its settings.

- A `radio` with `"cards": true` draws big answer cards, with a picture on
  each from `option_images`. A step with only that question moves on when
  the visitor clicks a card. A picture ending in `.svg` is drawn as an icon. Steps of questions
  have Back. `embedForm(c, db, key)` puts the first step on your own page.
- `page` starts a step; for one question per page, put a `page` before
  each question. Answers are kept as a draft until the questions are done,
  then become a submission. Unfinished drafts are listed as not finished,
  and the team gets no email about them. On a `follow_up` form the person
  gets a nudge (the phone skill's Stopped before booking or paying). A
  submission is complete (`completed_at`) once its last step is done. One
  that ends in payment completes when Stripe reports it paid (the
  webhook's `afterPaid` calls `completePaidSubmission`). `onComplete` is
  the app's hook for that moment (the booking skill's
  `confirmFormBooking`).
- `items` sells things at a price per unit, `{ key: quantity }` as the
  answer; size or colour is an ordinary field beside it. The cart is
  `cart.js`. "Add to order" buttons (`data-add-to="<form>"
  data-item="<item>"`) and a count (`data-cart-count`) work on any page and
  fill the form. Submitting the form is the checkout.
- `booking` (a booking type's slug) and `payment` (fees, a tax rate) are
  steps after the questions, payment last. They need the booking and payments skills, wired as in `references/setup.md`. How a submission,
  its booking and its payment link: the payments skill's "Submissions,
  bookings and payments".
- `priceOf` (`price.ts`) works out what a submission costs (items, the
  fees that apply, a booking's price) from the stored definition, never
  from the page.

## Sending a lead elsewhere

A destination sends each lead to a CRM, a webhook or an email address, after it
is saved. `node scripts/forms.mjs destination-save <key> --file d.json`, then
`destination-test <key>` to read what it would send; `--help` lists the fields.

- **A webhook's address is a secret**: `python3 ~/tools/taskandtool.py request-secret
  LEAD_WEBHOOK_URL`, and `target` names it. Reach a vendor through a
  `connection` (`request-connection`); its key stays in Task & Tool. The
  connection's instructions give its path and field names, and `template`
  maps our fields to theirs. A destination belongs to the project, but its
  secret or connection must be on the app that takes the form. An `email`
  to anyone off the app needs Resend or Postmark.
- **`send_when` defaults to `answered`**: no lead waits on a booking or
  payment. Give a vendor that takes one create per person one destination only, because a second send can make a duplicate.
- **A failed send** gets up to three tries within a few seconds. A timeout
  gets one try, because the vendor may have received it. After that it is
  marked Failed on the submission, next to what was sent, what came back
  and Resend. The team gets one email. Nothing retries later.

The forms routes send leads themselves. Other code that makes a submission
calls `leadMoment(db, env, id, "complete", { link })` after the response;
the Website's booking page does this. Give `formRoutes` an `adminPath` when
the submissions page is not at `/admin/submissions` (the emails link to
it), and `background` for an app whose database closes with the response.

## Files

| File | What |
|---|---|
| `schema.sql` | `forms`, `submissions`, `submission_drafts`, `lead_destinations`, `lead_deliveries` |
| `fields.ts` | `Field`, `Form`, `validate`, `checkFields` (step order too), `stepsOf` |
| `routes.tsx` | `formRoutes(getDb, { source, page, steps? })`: POST `/forms/:key`, `/forms/:key/next` (a step), `/forms/:key/start` (a page of its own), `/forms/:key/thanks`; `embedForm` |
| `render.tsx` | `FormView`: one step of a form, accessible, answers put back |
| `destinations.ts` | `leadMoment`, `leadFields`, `fillTemplate`, `deliveriesOf`, `resendDelivery`, `destinationsOf`, `checkDestination` |
| `store.ts` | `loadForm`, `seedForm`, `insertOnce`, `submitKey`, `saveSubmitter`, drafts, `completePaidSubmission`, `CONTACT_FORM` (the name, email, phone and message form, seeded as `contact`) |
| `steps.ts` | the contract a booking or payment step implements |
| `price.ts`, `linked.ts` | what a submission costs; its booking and payment, for showing |
| `admin.tsx` | `formsAdmin(getDb, { base, css, timeZone, nav?, Frame?, links? })`: the submissions list (Open, Archived, Spam) with each one's booking, payment and the person's notes, so it needs the `booking`, `payments` and `customers` skills' code beside it; `formEditor(getDb, { base, css, timeZone, source, submissions })`: the forms, the editor, not finished; both export CSV, for an app that lets the team set forms up (the CRM) |
| `files.ts` | `devFiles()`: `/_files` on the dev server (`src/server.ts`) |
| `consent.ts` | `textingBox`, `consentWords`: the texting box's words, from the business (`data/business.ts`) |
| `origin.ts`, `cart.js`, `cli.ts` | where the visitor came from; the cart; `formsCli` for `scripts/forms.mjs` |
| `test/` | validation, rendering, steps, items, the cart, photos, the command, and the routes and admin on a scratch database |
| `references/setup.md` | when an app takes its first form, wires steps, or sets up the owner's email |
