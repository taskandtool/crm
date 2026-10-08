---
name: admin
description: "The private side of an app: lists of what came in (submissions, bookings, payments) with search, filters, Load more, a detail view, status changes, bulk actions and CSV export, behind the team-only guard by default. Use for any view the public should not see. Not for public pages."
---

# Admin

Private views over the project's tables: the CRM's starting surface and the
Website's `/admin`. The other skills build their own lists on these pieces.

Version: 0.1.0 (taskandtool/skills)

## Where private views live

Private views sit under one prefix (`/admin`, `/reports`) and are private by
default, with two locks:

1. **Task & Tool decides who reaches the path.** Only the team reaches dev.
   Production starts the same way: the first deploy publishes it to the
   team, and only a person makes it public, with the switch in Task & Tool.
   So declare the prefix when you build it, before anyone makes the site
   public: `python3 ~/tools/taskandtool.py add-private-path /admin`, once per
   prefix (the `serving` skill: keeping a path for the team). Once the site
   is public, that path still asks for a Task & Tool sign-in and the rest is
   open. Only a person can make a declared path public. Do not link to it
   from public pages.
2. **The app checks who arrived.** Mount the views as a sub-app with
   `admin.use("*", teamOnly())` (`guard.ts`). It answers 404 to any request
   without `X-TaskTool-User`. Only Task & Tool's edge sets that header, from
   a verified sign-in, and it strips the header from visitors' requests, so
   a path that was never declared stays shut in production too. The header
   also names who acted.
   The team is signed in by the platform, so never build a login for them.

- **Other audiences, when the owner asks.** The business's own clients can
  be people with the client role in Task & Tool: they arrive with the same
  `X-TaskTool-User`, and the app decides what each may see (rows scoped to
  that person). The business's customers who are not in Task & Tool need the
  app's own accounts (Better Auth or similar, sessions, password resets, every
  query scoped to the signed-in customer). That is a separate, careful piece
  of work: say so, and never let it replace `teamOnly` on the team's views.
- **Mutations are POSTs.** `teamOnly` refuses a cross-site one (Origin, else
  Sec-Fetch-Site), which stands in for a CSRF token. Record who acted:
  `updated_by = ${c.get("user")}` (and `updated_at = now()`) on every change.
- **One `/admin`, a section per skill.** Each skill's views mount under it
  (`/admin/forms`, `/admin/bookings`) on one guarded sub-app, all passing the
  same `nav`; `/admin` itself redirects to the list the owner reads most.
- Running locally, off the platform: set `ADMIN_DEV_USER=you@example.com`.
  It is honoured only for a localhost URL on a loopback connection with no
  proxy headers (the Host header alone is not enough: it is whatever the
  sender typed).

## Lists

- **Keyset, never offset** (`keyset.ts`). Order by `created_at desc, id
  desc`, fetch one row more than the page, `cut()` it. Select the sort key as
  text (`created_at::text as k`): a JavaScript Date drops microseconds, and a
  cursor built from one skips every row inside the lost part.
- **Search is `ilike` over `likePattern(q)`** (`query.ts`), which escapes `%`,
  `_` and `\`. Every project database has `pg_trgm`; the index belongs in the
  owning skill's `schema.sql`: `using gin (name gin_trgm_ops)`, and for a
  citext column `using gin ((email::text) gin_trgm_ops)` with the query
  saying `email::text ilike …` so the index applies.
- **Optional filters are written in the SQL**, never spliced:
  `(${status}::text is null or status = ${status})`. Validate a status
  against its options (`pickStatus`) before it reaches the query.
- **Times show in the business's zone** (`<When timeZone>`). Dev and
  production run in UTC.

## Words

A private view uses the words every CRM and admin tool already uses, never
new phrasing: Inbox, Add, Edit, Save, Archive, Mark done, Reschedule,
Owner, Assigned to, Due date, Status, Stage, Value, Lost reason, Notes,
Activity, Possible duplicates, Export CSV. Labels are nouns ("Due date",
not "Day"; "Title", not "What to do"). One name per action, everywhere.
An empty state is one line saying what goes there, and one action. Hints
only for a format ("Separate tags with commas"), never to explain the page.

## Export

`csvResponse(name, columns, everyPage((after, size) => listPage(db, f, after, size)))`:
`everyPage` (`keyset.ts`) walks the list's own keyset query 500 rows at a
time. `csvResponse` (`csv.ts`) streams the rows, BOM first so Excel reads
UTF-8, with formula cells defused so a submitted "=HYPERLINK(…)" stays text. Export
the current filter: the link carries the same query string.

## htmx, and the same thing without it

One URL answers a plain request with the whole page and htmx with a
fragment (`isPartial(c)`); a plain POST answers with a 303, htmx with the
fragment. The table, history restores, bulk forms and flash messages:
`references/htmx.md`.

## Files

| File | What it is |
|---|---|
| `guard.ts` | `teamOnly()`, `whoIs`, `sameOrigin`: the 404 gate and the cross-site check |
| `layout.tsx` | `AdminLayout`: the private page frame with nav, `aria-current`, htmx from cdnjs |
| `keyset.ts` | cursors (`makeCursor`, `readCursor`, `cut`), `everyPage` for exports, and the microsecond rule |
| `csv.ts` | `csvCell`, `csvResponse`: defused, streamed, BOM-first CSV |
| `query.ts` | `likePattern`, `listUrl`, `localPath`, `isPartial`, `formIds`, `idParam` |
| `list.tsx` | `DataTable`, `TableRows`, `TableRow`, `LoadMoreRow`, `SearchBar`, `When` |
| `status.tsx` | `StatusBadge` (token tones), `StatusForm` (plain or row-swapping), `pickStatus` |
| `bulk.tsx` | `BulkForm`: the form the row checkboxes post to |
| `detail.tsx` | `Section`, `FieldList`, `JsonData` (nested, escaped), `Activity` (log plus note box) |
| `flash.tsx` | `withFlash`, `Flash`: "Saved" after a 303 from a code in the URL |
| `example.tsx` | `adminRoutes(getDb, opts)`: all of the above over one table, tested end to end |
| `test/` | component rendering, the core, and `example.tsx` against a scratch database |

Keep the exports of `guard`, `layout`, `keyset` and `csv` as they are.

## Adding a list for a new table

1. Copy `example.tsx` to `<skill>/admin.tsx` (or the app's `src/admin/<name>.tsx`)
   and replace `example_rows` and its columns. Keep `id::text as id`
   and `created_at::text as k` in every select a cursor is made from.
2. Put the `(created_at desc, id desc)` index and the trigram indexes in the
   owning skill's `schema.sql`, not in admin.
3. Set `STATUSES` to the table's real statuses; give each a tone.
4. Mount it under the private prefix and add it to the `nav` every private
   view passes. Every route factory takes `(getDb, opts)`, opts named `base`, `css`, `timeZone`,
   `nav`, `pageSize` (and `source`, the app's slug, where it writes rows).
5. Copy `test/example.test.ts` beside it, point it at the real table, and
   keep the same-millisecond paging, cross-site and no-header cases.
