---
name: customers
description: "The project's customers, their leads (one per enquiry) and their notes (calls, emails, meetings, texts): one record per person, matched by email, read by every app. Use when an app saves, shows or notes the people who got in touch. Not for the CRM's pipeline, deals or tasks (those are the CRM's own)."
---

# Customers

One `customers` row per person the business deals with, keyed by email, a
`leads` row per enquiry they make, and their timeline in `customer_notes`.
The CRM lists and edits them; any other app (the Website's submission page)
reads them and adds notes, and both see the same rows.

## The rules

- **Everyone who gets in touch is a customer, at once.** Whatever saves a
  submission, a booking or a call calls `savePerson` in the same request
  (the forms, booking and phone skills already do). It matches by email (an
  address gained in a merge too), else by phone where either side has no
  email, never by name; it makes the customer in the CRM's first open status
  when there is none, and fills address, company and custom fields from the
  answers. Outside the CRM, never insert a customer yourself: `savePerson`
  takes the same locks as the CRM's own create, so two saves at once make
  one record.
- **Each enquiry is a lead** (`saveLead`): one per submission or booking (a
  second call returns the first), open until the CRM converts it to a deal
  or archives it. A form with `leads` off (a newsletter, a job application)
  saves the person and no lead.
- **Custom fields** are the CRM's, published in `customer_fields` at its
  start and deploy. An answer under one of their keys fills it when it is a
  valid value for the field's type (`answerFields`); anything else is left
  out.
- **A note's time is a wall time** in the business's zone (`wallTime`), or
  now. A call, email, meeting or text moves `last_contact_at` forward; a
  plain note does not.
- **A customer is archived, never deleted.** A merged duplicate keeps
  `merged_into`.

## Files

| File | What |
|---|---|
| `schema.sql` | `customers`, `customer_notes`, `customer_fields`, `leads`; the CRM adds its own tables beside them |
| `customer.ts` | `savePerson`, `saveLead`, `customerByEmail`, `phoneKey`, `answerFields` |
| `notes.ts` | `addNote`, `listNotes`, `NOTE_KINDS`, `NOTE_LABELS`, `pickNoteKind`, `wallTime` |
| `note-form.tsx` | `NoteForm`: the box a note is written in, posting `body`, `kind`, `at` (the `admin` skill's controls) |
| `test/` | phone keys, custom fields, `savePerson` and `saveLead` on a scratch database |
