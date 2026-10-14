---
name: customers
description: "The project's customers and their notes (calls, emails, meetings, texts): one record per person, matched by email, read by every app. Use when an app shows or notes the people who got in touch. Not for the CRM's pipeline, deals or tasks (those are the CRM's own)."
---

# Customers

One `customers` row per person the business deals with, keyed by email, and
their timeline in `customer_notes`. The CRM lists and edits them; any other
app (the Website's submission page) reads them and adds notes, and both see
the same rows.

Version: 0.1.2 (taskandtool/skills)

## The rules

- **Find before making.** Use `customerFor`, never an insert: it finds them
  first, by an address gained in a merge too.
- **A note's time is a wall time** in the business's zone (`wallTime`), or
  now. A call, email, meeting or text moves `last_contact_at` forward; a
  plain note does not.
- **Archived, never deleted.** A merged duplicate keeps `merged_into`.

## Files

| File | What |
|---|---|
| `schema.sql` | `customers`, `customer_notes`; the CRM adds its own tables beside them |
| `customer.ts` | `customerByEmail`, `customerFor` |
| `notes.ts` | `addNote`, `listNotes`, `NOTE_KINDS`, `NOTE_LABELS`, `pickNoteKind`, `wallTime` |
| `note-form.tsx` | `NoteForm`: the box a note is written in, posting `body`, `kind`, `at` (the `admin` skill's controls) |
