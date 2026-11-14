---
name: customers
description: "Saves the project's customers, their leads (one per enquiry) and their notes (calls, emails, meetings, texts): one record per person, matched by email, shared by every app. Use when an app saves, shows or notes the people who got in touch. Not for the CRM's pipeline, deals or tasks (those are the CRM's own)."
---

# Customers

One `customers` row per person the business deals with, keyed by email, a
`leads` row per enquiry they make, and their timeline in `customer_notes`.
The team lists and edits them in the CRM. Other apps (the Website's
submission page) read the same rows and add notes to them.

## The rules

- **Everyone who gets in touch is a customer, at once.** Code that saves a
  submission, a booking or a call also calls `savePerson` in the same
  request (the forms, booking and phone skills already do). `savePerson`
  matches by email, including an address gained in a merge. Where either
  side has no email it matches by phone, and it never matches by name.
  With no match it makes the customer in the CRM's first open status. It
  fills address, company and custom fields from the answers. Outside the
  CRM, never insert a customer yourself. Two saves at once make one
  record: `savePerson` takes the same locks as the CRM's own create.
- **Each enquiry is a lead** (`saveLead`): one per submission or booking (a
  second call returns the first). It stays open until the team converts it
  to a deal or archives it in the CRM. A form with `leads` off (a
  newsletter, a job application) saves the person and no lead.
- **Custom fields** are the CRM's. The CRM writes them to
  `customer_fields` at each start and deploy. An answer under one of their
  keys fills the field when the value is valid for the field's type
  (`answerFields`). Other answers are left out.
- **A note's time is a wall time** in the business's zone (`wallTime`), or
  now. A note for a call, email, meeting or text moves `last_contact_at`
  forward; a plain note does not.
- **A customer is archived, never deleted.** A merged duplicate keeps
  `merged_into`.

## Where a lead got to

`setLeadOutcome` records the outcome in our words (`appointment_set`,
`showed`, `no_show`, `sold`, `lost`), what it sold for, and the same lead's
id and status in another CRM. The CRM's own bookings and won deals count
without it. For a job that reads another CRM, see the reports skill's
`references/daily-numbers.md`.

## Files

| File | What |
|---|---|
| `schema.sql` | `customers`, `customer_notes`, `customer_fields`, `leads`; the CRM adds its own tables beside them |
| `customer.ts` | `savePerson`, `saveLead`, `customerByEmail`, `phoneKey`, `answerFields` |
| `notes.ts` | `addNote`, `listNotes`, `NOTE_KINDS`, `NOTE_LABELS`, `pickNoteKind`, `wallTime` |
| `note-form.tsx` | `NoteForm`: the box a note is written in, posting `body`, `kind`, `at` (the `admin` skill's controls) |
| `test/` | phone keys, custom fields, `savePerson` and `saveLead` on a scratch database |
