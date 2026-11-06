---
name: forms
description: "Forms as rows in the project's database: contact forms, surveys and orders, with steps, things to buy, a booking step and a payment step, and every submission in the one table the CRM reads, each lead sent on to a CRM, webhook or email if asked. Use for any form a visitor fills in, an order page, or sending leads somewhere."
---

# Forms

Every form in the project is a row in `forms`, every submission from any
app a row in `submissions`. A form is the one noun: an order, a survey, a
paid appointment with questions are each a form, named for what it takes
(`order`, `intake`), and "my orders" is that form's submissions. A new
form or a new question is a change to a row, never a migration.

## The rules

- **Look first, and use the command.** `node scripts/forms.mjs list` before
  making one; another app may have made it. Make and change forms with
  `node scripts/forms.mjs save <key> --file form.json` (it checks the
  definition as the editor does), never with SQL, never a table per form.
- **The person goes in the columns**: name the fields `name`, `email` and
  `phone`, or the CRM cannot match them. Every other answer is in `data`;
  one named `address`, `company` or a CRM custom field's key fills it on
  their customer. Each submission saves its person and a lead as it comes
  in, or when the team marks it not spam (`saveSubmitter`, the customers
  skill). A newsletter sign-up or a job application is saved with
  `"leads": false`: the person, no lead.
- **One definition** (`fields.ts`) drives the page, the server's
  validation and the editor; the browser's `required` is a convenience.
- **A page with a form is rendered per request**, never pre-rendered: it
  needs the owner's latest definition, a fresh spam stamp and the visit's
  UTM. A pre-rendered page is a static file, served in place of the Worker.
- **Spam** is a honeypot and a 3-second minimum (`data/spam.tsx`), nothing
  to set up. A post with no valid stamp is thanked and dropped; a filled
  honeypot or a post too fast is kept as spam, since a browser can fill the
  honeypot for a real person, and nobody is told.
- **No IP addresses**: store only what the visitor typed, the page, and
  where they came from (`origin.ts`): the five UTMs, click ids, the
  referrer's host, the landing page, the first visit. A public site's layout
  (the Website's) carries `ORIGIN_SCRIPT` inline, so a visitor keeps their tags
  from page to page.
- **A failed save keeps the answers**: a form's first post saves once however
  often it arrives, a failure is tried again while they wait, and after that they
  get Try again, with their answers kept, and the team gets a copy.
- **Marketing needs a `consent` field**, unticked; `data._consent` keeps
  the exact words agreed to. A contact form is not permission to market.
- **The texting box** shows under the phone field of a form with "Follow
  up automatically" on, and on the booking page, once the business has a
  number and a name: pass `textConsent: (c) => textingBox(getDb(c),
  "request")` (`consent.ts`). What was ticked is kept word for word in
  `text_consent`. Never write the box's words yourself.
- **A photo field stores `/_files/<id>`.** The app's addresses serve it; in
  dev, `devFiles()` does, at `localhost:<port>/_files/<id>`.
- **A form's `notify_emails` hear of each submission** (`team: true`
  mail, `data/send.ts`), through Task & Tool email or the owner's Resend or
  Postmark; the submission's `notified` says who it reached or why not.
  No sender: say so.

## Steps, things to buy, a time and a payment

A form's fields say all of it; `node scripts/forms.mjs --help` lists every
field type with its settings.

- A `radio` with `"cards": true` draws big answer cards, with a picture on
  each from `option_images`; a step that is only that question moves on at a
  click. A picture ending in `.svg` is drawn as an icon. Steps of questions
  have Back. `embedForm(c, db, key)` puts the first step on your own page.
- `page` starts a step; for one question per page, put a `page` before
  each question. Answers wait as a draft and become a submission when the
  questions are done; drafts never finished are listed as not finished,
  the team is not emailed about them, and a `follow_up` form nudges the
  person (the phone skill's Stopped before booking or paying). A
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

## Sending a lead elsewhere

A destination sends each lead to a CRM, a webhook or an email address, after it
is saved. `node scripts/forms.mjs destination-save <key> --file d.json`, then
`destination-test <key>` to read what it would send; `--help` lists the fields.

- **A webhook's address is a secret**: `python3 ~/tools/taskandtool.py request-secret
  LEAD_WEBHOOK_URL`, and `target` names it. A vendor is a `connection`
  (`request-connection`), so its key stays in Task & Tool: its instructions say its
  path and field names, and `template` maps ours to theirs. A destination is the
  project's, but its secret or connection must be on the app that takes the form. An
  `email` to anyone off the app needs Resend or Postmark.
- **Default `answered`**, so no lead waits on a calendar. A vendor that takes one
  create per person gets one moment: a second send can make a duplicate.
- **A failed send** gets up to three tries over seconds (a timeout gets one, as the
  vendor may have it), then shows as Failed on the submission with what was sent and
  what came back, Resend, and one email to the team. Nothing retries later.

The forms routes do this. Anything else that makes a submission calls
`leadMoment(db, env, id, "complete", { link })` after the response, as the
Website's booking page does. `formRoutes` takes `adminPath`, which the emails link
to when it is not `/admin/submissions`, and `background`, for an app whose database
closes with the response.

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
