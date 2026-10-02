// The database handle every snippet takes. Two functions, so the same
// snippet runs on the machine (pg) and at the edge (the Neon HTTP driver):
//
//   const rows = await db.sql<{ id: number }>`select id from bookings where email = ${email}`;
//   await db.transaction([q`select pg_advisory_xact_lock(${key})`, q`insert into …`]);
//
// A transaction is non-interactive: every statement is built before it runs
// and no JavaScript runs between them. That is what the Neon HTTP driver
// allows, so it is all a snippet may assume. Decide inside the SQL instead
// (`insert … select … where not exists …`, `returning`).
//
// Values are always parameters ($1, $2 …), never spliced into the text. There
// are no fragments: an optional filter is written in the SQL,
// `where (${status}::text is null or status = ${status})`.
//
// Every route factory takes a GetDb, never a Db: at the edge the handle is
// made per request from the Worker's binding, and on the machine the function
// just returns the app's one handle.
//
//   app.route("/admin/rows", adminRoutes((c) => fromNeon(envVar(c, "DATABASE_URL")), opts));   // the edge
//   app.route("/admin/rows", adminRoutes(() => db, opts));                                // the machine
import type { Context } from "hono";

export type Row = Record<string, any>;
export type Query = { text: string; values: unknown[] };

export type Sql = <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

export interface Db {
  /** Run one statement; resolves to its rows. */
  sql: Sql;
  /** Run statements in one transaction, all or nothing; resolves to each one's rows. */
  transaction(queries: Query[]): Promise<Row[][]>;
}

/** The database for this request. */
export type GetDb = (c: Context) => Db;

/** Build a statement without running it, for `db.transaction([...])`. */
export function q(strings: TemplateStringsArray, ...values: unknown[]): Query {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
  return { text, values };
}
