---
name: admin
description: "Builds the private side of an app: lists of what came in (submissions, bookings, payments) with search, filters, Load more, a detail view, status changes, bulk actions and CSV export, behind the team-only guard by default. Use for any view the public should not see."
---

# Admin

Private views over the project's tables: the CRM's starting surface and the
Website's `/admin`. The other skills' lists are built from these pieces.

## Where private views go

Put private views under one prefix (`/admin`, `/reports`). They are private
by default, with two locks:

1. **Task & Tool decides who reaches the path:** only people placed on
   the app, in dev and in production until a person makes it public.
   Declare the prefix when you build it: `python3 ~/tools/taskandtool.py
   add-private-path /admin` (the `serving` skill). Once the site is
   public, a declared path still needs a Task & Tool sign-in. Never link it
   from public pages.
2. **The app checks who arrived.** Mount the views on one sub-app with
   `admin.use("*", teamOnly())` (`guard.ts`). The edge sets the
   `X-TaskTool-User` header from a verified sign-in; without it, `teamOnly`
   answers 404. `c.get("user")` is who acted, for `updated_by`. Never build
   a team login.

- **`teamOnly` admits everyone placed on the app**, a person with the
  client role in Task & Tool included. The header carries their email, and
  nothing marks them as a client. On an app the owner places clients on,
  decide by email in the app what each may see. The business's customers
  who are not in Task & Tool need the app's own accounts (Better Auth or
  similar, every query scoped to the signed-in customer). That is a
  separate, careful piece of work: say so, and never let it replace
  `teamOnly` on the team's views.
- **Mutations are POSTs.** `teamOnly` refuses a cross-site POST (by
  Origin, else Sec-Fetch-Site), and that check takes the place of a CSRF
  token.
- **One `/admin`, a section per skill.** Mount each skill's views under it
  (`/admin/submissions`, `/admin/schedule`) on one guarded sub-app, and pass
  them all the same `nav`. `/admin` itself redirects to the list the owner
  reads most.
- Running locally, off the platform: set `ADMIN_DEV_USER=you@example.com`
  (honoured only for a request from this computer).

## Lists

- **Keyset, never offset** (`keyset.ts`). Order by `created_at desc, id
  desc`, fetch one row more than the page, `cut()` it. Select the sort key as
  text (`created_at::text as k`): a JavaScript Date drops microseconds, and a
  cursor built from one skips every row inside the lost part.
- **Search is `ilike` over `likePattern(q)`** (`query.ts`). `likePattern`
  escapes `%`, `_` and `\`. Every project database has `pg_trgm`. Put the
  index in the owning skill's `schema.sql`: `using gin (name gin_trgm_ops)`.
  For a citext column use `using gin ((email::text) gin_trgm_ops)`, and
  write the query as `email::text ilike …` for the index to apply.
- **Optional filters are written in the SQL**, never spliced:
  `(${status}::text is null or status = ${status})`. Validate a status
  against its options (`pickStatus`) before it reaches the query.
- **Times show in the reader's zone.** `<When>` handles this itself.
  Other code on a team page uses `viewerZone(c, business)` in a route or
  `shownZone(business)` in a component (`viewer.tsx`). `timeZone` is the
  fallback when no reader is known. `pin` keeps `timeZone` for a date with
  no time or a host's own hours. Dev and production run in UTC.

## Words

In a private view, use the words other CRM and admin tools use, not new
phrasing: Inbox, Add, Edit, Save, Archive, Mark done, Reschedule,
Owner, Assigned to, Due date, Status, Stage, Value, Lost reason, Notes,
Activity, Possible duplicates, Export CSV. Labels are nouns ("Due date",
not "Day"; "Title", not "What to do"). One name per action, everywhere.
An empty state is one line saying what goes there, and one action. Hints
only for a format ("Separate tags with commas"), never to explain the page.

## Export

Export the current filter: `csvResponse(name, columns, everyPage((after, size) => listPage(db, f, after, size)))`
streams it with a BOM first and formula cells defused.

## htmx, and the same thing without it

One URL answers a plain request with the whole page and htmx with a
fragment (`isPartial(c)`); a plain POST answers with a 303, htmx with the
fragment. The table, history restores, bulk forms and flash messages:
`references/htmx.md`.

## Files

| File | What it is |
|---|---|
| `viewer.tsx` | `viewerZone`, `shownZone`, `ViewerZoneScript`: each team member's own time zone |
| `guard.ts` | `teamOnly()`, `whoIs`, `sameOrigin`: the 404 gate and the cross-site check |
| `layout.tsx` | `AdminLayout`: the private page frame with nav, `aria-current`, htmx from cdnjs; `sectionPages`: a skill section's page maker (its tabs, or the app's own `Frame`, and its flash); `SectionTabs`; the `Frame` and `Head` types |
| `keyset.ts` | cursors (`makeCursor`, `readCursor`, `cut`), `everyPage` for exports, and the microsecond rule |
| `csv.ts` | `csvCell`, `csvResponse`: defused, streamed, BOM-first CSV |
| `query.ts` | `likePattern`, `listUrl`, `localPath`, `isPartial`, `formIds`, `idParam` |
| `list.tsx` | `DataTable`, `TableRows`, `TableRow`, `LoadMoreRow`, `SearchBar`, `When`, `rowClick`, `rowLink`; `EmptyState`, `EmptyCard`, `NoMatches`, `SetupNeeded`, `AskAi` (words to say to the AI, with Copy) |
| `status.tsx` | `StatusBadge` (token tones), `StatusForm` (plain or row-swapping), `pickStatus`; `controlClass`, `inputClass`, `buttonClass`, `primaryClass`, `quietClass`, `SELECTED_ONLY`, `fieldClass`, `linkClass`, `smallText`, `Select`, `FieldError`: the shared look of every control |
| `bulk.tsx` | `BulkForm`: the form the row checkboxes post to, shown only once a row is ticked (`SELECTED_ONLY`) |
| `detail.tsx` | `Section`, `FieldList`, `JsonData` (nested, escaped) |
| `flash.tsx` | `withFlash`, `Flash`: "Saved" after a 303 from a code in the URL |
| `example.tsx` | `adminRoutes(getDb, opts)`: all of the above over one table, tested end to end |
| `test/` | component rendering, the core, and `example.tsx` against a scratch database |

## Adding a list for a new table

Done when the copied test passes with its same-millisecond paging,
cross-site and no-header cases kept.

1. Copy `example.tsx` and `test/example.test.ts`.
2. Swap `example_rows` for the table and `STATUSES` for its real ones,
   each with a tone.
3. Put its `(created_at desc, id desc)` and trigram indexes in the owning
   skill's `schema.sql`.
4. Keep `id::text as id` and `created_at::text as k` in every select a
   cursor is made from.
5. Mount it under the private prefix with the shared `nav`.
