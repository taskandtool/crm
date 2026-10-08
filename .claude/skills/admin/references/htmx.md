# htmx, and the same thing without it

Read when a list, a status change or a bulk action answers htmx and a
plain request; `example.tsx` already does all of it.

One URL answers three ways (`isPartial(c)` in `query.ts`):

| Request | Answer |
|---|---|
| plain GET | the whole page in `AdminLayout` |
| htmx, `after` set | `<TableRows>` alone: it replaces the Load more row |
| htmx, otherwise | the `#results` block |

- **A history restore is an htmx request that needs the whole page**
  (`HX-History-Restore-Request`); `isPartial` already says no to it. Every
  private response is `no-store`, so the browser never shows a fragment as a
  page.
- Without JavaScript, Load more opens the next page whole: offer "Back to
  the newest" there. A row's status change answers htmx with `<TableRow>`
  and a plain post with a 303.
- **Bulk**: row checkboxes carry `form="bulk"` instead of sitting inside the
  form, so Load more rows join it and row forms never nest. Read ids with
  `formIds((await c.req.parseBody({ all: true })).id)`.
- **After a plain POST**, redirect (303) to the `return` field, checked by
  `localPath` (a path under the prefix, never a host), with
  `withFlash(ret, code, n)`. `<Flash>` maps the code to the app's own words,
  so a crafted link cannot put text on the page. Answer htmx with the
  fragment, not a 303: an htmx request that receives a redirect follows it
  and swaps the whole page into the target.
- Values a visitor sent render as text (hono/jsx escapes them) and never as
  links: a stored `javascript:` URL is one click from running.
