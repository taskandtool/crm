// What the CRM adds to the invoices skill's quotes: the customer a quote is
// for, and "Make it a job" for an accepted quote that has none.
import { q, type Db } from "../data/db";
import type { Quote } from "../invoices/quotes";
import type { SavedLine } from "../invoices/lines";
import { createCustomer, findMatch, type Customer } from "./customers";
import { firstOpenStage } from "./stages";

/**
 * A job for the quote: its customer (matched by email or phone, or added),
 * its first line as the title, its total as the amount. One per quote: the
 * job is made and linked in one statement, behind a lock on the quote, so a
 * second click finds the first job. Null when there is no open stage to add
 * a customer to, or no such quote.
 */
export async function jobFromQuote(
  db: Db,
  qt: Quote & { lines: SavedLine[] },
  user: string,
): Promise<{ visitId: string; customer: Customer } | null> {
  let customer = await findMatch(db, qt.email, qt.phone);
  if (!customer) {
    const stage = await firstOpenStage(db);
    if (!stage) return null;
    customer = (await createCustomer(db, { name: qt.name ?? qt.email, email: qt.email, phone: qt.phone, stage: stage.key, source: "Quote" }, user)).customer;
    if (qt.address) await db.sql`update customers set address = ${qt.address} where id = ${customer.id}::bigint and address is null`;
  }
  const title = (qt.lines.length === 1 ? qt.lines[0].description : `Quote ${qt.number}`).slice(0, 200);
  const [, made] = await db.transaction([
    q`select visit_id from quotes where id = ${qt.id}::bigint for update`,
    q`with v as (
        insert into customer_visits (customer_id, title, status, amount_cents, currency, notes, created_by, updated_by)
        select ${customer.id}::bigint, ${title}, 'planned', ${qt.total_cents}::bigint, ${qt.currency.toUpperCase()}, ${`From quote ${qt.number}.`}, ${user}, ${user}
        where exists (select 1 from quotes where id = ${qt.id}::bigint and visit_id is null)
        returning id)
      update quotes set visit_id = (select id from v), updated_by = ${user}, updated_at = now()
      where id = ${qt.id}::bigint and visit_id is null and exists (select 1 from v)
      returning visit_id::text`,
    ]);
  if (made[0]) return { visitId: made[0].visit_id, customer };
  const [now] = await db.sql<{ visit_id: string | null }>`select visit_id::text from quotes where id = ${qt.id}::bigint`;
  return now?.visit_id ? { visitId: now.visit_id, customer } : null;
}
