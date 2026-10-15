// Search everything at once, as Pipedrive's, HubSpot's and Salesforce's top
// search do: contacts, leads, deals, quotes and invoices whose words match,
// each kind newest first. Quotes and invoices only where the project has them.
import { likePattern } from "../admin/query";
import type { Db } from "../data/db";
import { present } from "./tables";

/** One match: where it opens, what it is called, and a line under it. */
export type Hit = { id: string; title: string; sub: string | null };
export type Hits = { contacts: Hit[]; leads: Hit[]; deals: Hit[]; quotes: Hit[]; invoices: Hit[] };

const none = (): Hits => ({ contacts: [], leads: [], deals: [], quotes: [], invoices: [] });

/** Up to `limit` of each kind, archived ones last. A query under two characters finds nothing. */
export async function search(db: Db, q: string | null, limit: number): Promise<Hits> {
  const text = q?.trim() ?? "";
  if (text.length < 2) return none();
  const pat = likePattern(text);
  // "555 0102" finds "(555) 010-2": four or more digits match the phone's digits, as the contacts list does.
  const digits = /^[\d\s()+.-]+$/.test(text) ? text.replace(/\D/g, "") : "";
  const digitPat = digits.length >= 4 ? `%${digits}%` : null;
  const has = await present(db);
  const [contacts, leads, deals, quotes, invoices] = await Promise.all([
    db.sql<Hit>`
      select c.id::text as id, c.name as title, concat_ws(' · ', c.company, c.email::text, c.phone) as sub
      from customers c
      where c.name ilike ${pat} or c.email::text ilike ${pat} or c.phone ilike ${pat} or c.company ilike ${pat}
         or (${digitPat}::text is not null and regexp_replace(c.phone, '[^0-9]', '', 'g') like ${digitPat})
      order by (c.archived_at is null) desc, c.updated_at desc, c.id desc limit ${limit}`,
    db.sql<Hit>`
      select l.id::text as id, c.name as title, concat_ws(' · ', l.title, initcap(l.status)) as sub
      from leads l join customers c on c.id = l.customer_id
      where l.title ilike ${pat} or c.name ilike ${pat} or c.email::text ilike ${pat} or c.phone ilike ${pat}
      order by (l.status = 'open') desc, l.created_at desc, l.id desc limit ${limit}`,
    db.sql<Hit>`
      select d.id::text as id, d.title, c.name as sub
      from deals d join customers c on c.id = d.customer_id
      where d.title ilike ${pat} or c.name ilike ${pat} or c.email::text ilike ${pat}
      order by (d.archived_at is null and d.closed_at is null) desc, d.updated_at desc, d.id desc limit ${limit}`,
    has.quotes ? db.sql<Hit>`
      select id::text as id, number as title, coalesce(name, email::text) as sub
      from quotes where number ilike ${pat} or name ilike ${pat} or email::text ilike ${pat}
      order by created_at desc, id desc limit ${limit}` : [],
    has.invoices ? db.sql<Hit>`
      select id::text as id, coalesce(number, 'Draft invoice') as title, coalesce(name, email::text) as sub
      from invoices where number ilike ${pat} or name ilike ${pat} or email::text ilike ${pat}
      order by created_at desc, id desc limit ${limit}` : [],
  ]);
  return { contacts, leads, deals, quotes, invoices };
}
