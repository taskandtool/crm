// Everything one customer did across the project's tables: their form
// submissions, bookings and payments, and the quotes and invoices sent to
// them, by email (theirs, and any they also go by after a merge; where one
// side has no email, by phone), newest first. Tables the project does not have are
// skipped. Read only: the CRM never changes another app's rows here.
import type { Db } from "../data/db";
import type { Customer } from "./customers";
import { phoneKey } from "./phone";
import { present as presentTables, type Present } from "./tables";

export type HistoryItem =
  | { kind: "submission"; id: string; at: Date; form_key: string; form_title: string | null; status: string; data: Record<string, unknown>; page: string | null }
  | {
      kind: "booking"; id: string; at: Date; starts_at: Date; ends_at: Date; status: string; resource_name: string | null;
      type_name: string | null; location_kind: string; location: string | null;
      /** The job made from it, if one was. */
      visit_id: string | null;
    }
  | { kind: "payment"; id: string; at: Date; amount_cents: string; currency: string; status: string; pay_kind: string; description: string | null; livemode: boolean | null }
  | { kind: "quote"; id: string; at: Date; number: string | null; status: string; total_cents: string; currency: string }
  | { kind: "invoice"; id: string; at: Date; number: string | null; status: string; total_cents: string; currency: string };

export async function everythingFrom(db: Db, c: Pick<Customer, "email" | "phone"> & { other_emails?: string[] }, limit = 50): Promise<{ items: HistoryItem[]; present: Present }> {
  const p = await presentTables(db);
  const email = c.email;
  const emails = [c.email, ...(c.other_emails ?? [])].filter((e): e is string => !!e);
  const key = phoneKey(c.phone);
  if (!emails.length && !key) return { items: [], present: p };
  const jobs: Promise<HistoryItem[]>[] = [];
  if (p.submissions) {
    jobs.push(db.sql<HistoryItem>`
      select 'submission' as kind, s.id::text as id, s.created_at as at, s.form_key, null::text as form_title, s.status, s.data, s.page
      from submissions s
      where s.status <> 'spam'
        and (s.email = any(${emails}::citext[])
             or ((${email}::citext is null or s.email is null) and ${key}::text is not null
                 and right(regexp_replace(regexp_replace(s.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key}))
      order by s.created_at desc, s.id desc limit ${limit}`);
  }
  if (p.bookings) {
    jobs.push(db.sql<HistoryItem>`
      select 'booking' as kind, b.id::text as id, b.created_at as at, b.starts_at, b.ends_at, b.status, r.name as resource_name,
             t.name as type_name, b.location_kind, b.location,
             (select v.id::text from customer_visits v where v.booking_id = b.id) as visit_id
      from bookings b left join resources r on r.id = b.resource_id left join booking_types t on t.id = b.type_id
      where b.email = any(${emails}::citext[])
         or ((${email}::citext is null or b.email is null) and ${key}::text is not null
             and right(regexp_replace(regexp_replace(b.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key})
      order by b.created_at desc, b.id desc limit ${limit}`);
  }
  if (p.payments && emails.length) {
    jobs.push(db.sql<HistoryItem>`
      select 'payment' as kind, id::text as id, created_at as at, amount_cents::text as amount_cents, currency, status, kind as pay_kind, description, livemode
      from payments where email = any(${emails}::citext[]) and status <> 'pending'
      order by created_at desc, id desc limit ${limit}`);
  }
  // What the team sent them: a quote once it went out (or was answered), an invoice once Stripe has it.
  if (p.quotes && emails.length) {
    jobs.push(db.sql<HistoryItem>`
      select 'quote' as kind, id::text as id, coalesce(sent_at, decided_at) as at, number, status, total_cents::text as total_cents, currency
      from quotes where email = any(${emails}::citext[]) and coalesce(sent_at, decided_at) is not null
      order by coalesce(sent_at, decided_at) desc, id desc limit ${limit}`);
  }
  if (p.invoices && emails.length) {
    jobs.push(db.sql<HistoryItem>`
      select 'invoice' as kind, id::text as id, coalesce(paid_at, sent_at, updated_at) as at, number, status, total_cents::text as total_cents, currency
      from invoices where email = any(${emails}::citext[]) and status <> 'draft'
      order by coalesce(paid_at, sent_at, updated_at) desc, id desc limit ${limit}`);
  }
  const items = (await Promise.all(jobs)).flat().sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  if (p.forms && items.some((i) => i.kind === "submission")) {
    const titles = new Map((await db.sql<{ key: string; title: string }>`select key, title from forms`).map((f) => [f.key, f.title]));
    for (const i of items) if (i.kind === "submission") i.form_title = titles.get(i.form_key) ?? null;
  }
  return { items, present: p };
}

/**
 * When each of these emails last came in: their latest submission (not
 * spam), booking or payment that moved money, across the tables the project
 * has. Emails with none are absent. The import's last contact for people it
 * has no date for.
 */
export async function latestActivity(db: Db, emails: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!emails.length) return out;
  const p = await presentTables(db);
  type L = { email: string; at: Date };
  const jobs: Promise<L[]>[] = [];
  if (p.submissions) {
    jobs.push(db.sql<L>`
      select lower(email::text) as email, max(created_at) as at from submissions
      where email = any(${emails}::citext[]) and status <> 'spam' group by 1`);
  }
  if (p.bookings) {
    jobs.push(db.sql<L>`
      select lower(email::text) as email, max(created_at) as at from bookings
      where email = any(${emails}::citext[]) group by 1`);
  }
  if (p.payments) {
    jobs.push(db.sql<L>`
      select lower(email::text) as email, max(created_at) as at from payments
      where email = any(${emails}::citext[]) and status in ('paid', 'refunded', 'partially_refunded') group by 1`);
  }
  for (const r of (await Promise.all(jobs)).flat()) {
    const cur = out.get(r.email);
    if (!cur || r.at > cur) out.set(r.email, r.at);
  }
  return out;
}
