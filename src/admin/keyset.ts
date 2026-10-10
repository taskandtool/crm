// Paging a list by keyset: the page after the last row shown, not page N. It
// stays fast on a long table and never skips or repeats a row when new ones
// arrive between pages. The cursor is the last row's sort key and id, opaque
// to the browser.
//
// Select the sort key as text (`created_at::text as k`). Postgres keeps
// microseconds and a JavaScript Date keeps milliseconds, so a cursor made from
// a Date skips every row that falls inside the lost microseconds.
//
//   const after = readCursor(c.req.query("after"));
//   const rows = await db.sql<Row & Keyed>`
//     select s.*, s.created_at::text as k from submissions s
//     where (${after?.k ?? null}::timestamptz is null
//            or (s.created_at, s.id) < (${after?.k ?? null}::timestamptz, ${after?.id ?? null}::bigint))
//     order by s.created_at desc, s.id desc
//     limit ${PAGE + 1}`;
//   const { page, next } = cut(rows, PAGE);   // next goes in the "Load more" link
//
// An export walks every page of the same query (`everyPage`), so it never
// holds the whole table in memory:
//
//   csvResponse("rows.csv", columns, everyPage((after, size) => listPage(db, filter, after, size)));
import { fromB64url, toB64url } from "../data/token";

export type Keyed = { k: string; id: number | string | bigint };
export type Cursor = { k: string; id: string };

export function makeCursor(row: Keyed): string {
  return toB64url(new TextEncoder().encode(JSON.stringify([row.k, String(row.id)])));
}

export function readCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  try {
    const [k, id] = JSON.parse(new TextDecoder().decode(fromB64url(s)));
    if (typeof k !== "string" || k.length > 64 || typeof id !== "string" || !/^\d{1,18}$/.test(id)) return null;
    return { k, id };
  } catch {
    return null;
  }
}

/** Fetch one more row than the page holds; the extra one says whether there is a next page. */
export function cut<T extends Keyed>(rows: T[], size: number): { page: T[]; next: string | null } {
  const page = rows.slice(0, size);
  return { page, next: rows.length > size ? makeCursor(page[page.length - 1]) : null };
}

/**
 * Every row of a keyset query, a page at a time. `fetchPage` returns up to
 * `size + 1` rows after the cursor, as for a list page.
 */
export async function* everyPage<T extends Keyed>(fetchPage: (after: Cursor | null, size: number) => Promise<T[]>, size = 500): AsyncGenerator<T> {
  let after: Cursor | null = null;
  for (;;) {
    const { page, next } = cut(await fetchPage(after, size), size);
    yield* page;
    if (!next) return;
    after = readCursor(next);
  }
}
