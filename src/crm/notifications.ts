// The bell: what happened without the team doing it, newest first, as
// Jobber's activity feed (docs/plans/crm-contacts-leads-deals.md).
// A booker's own move or cancel (the booking skill's booking_changes), a
// quote the customer accepted by paying it online, and money paid through
// Stripe. News, not work: no Done. Each person's notifications_seen
// row says when they last opened the bell, which clears its count as
// HubSpot's does; unread is anything newer. Tables the project does not have
// are skipped (tables.ts).
import type { Db } from "../data/db";
import { spliced } from "./sql";
import { present as presentTables } from "./tables";

/** A quote's `decided_by` when its Pay button was paid: the invoices skill's webhook writes it. */
const PAID_ONLINE = "paid online";
// Money that moved. A quote's own invoice paid through its Pay button is the
// quote's notice ("accepted and paid"), where the project has quotes.
const paymentSql = (quotes: boolean) =>
  spliced({
    not_a_quote: quotes
      ? `not exists (select 1 from invoices i join quotes qt on qt.id = i.quote_id
          where pm.ref_type = 'invoice' and i.id::text = pm.ref_id and qt.decided_by = '${PAID_ONLINE}')`
      : "true",
  });
const PAYMENTS = paymentSql(true), PAYMENTS_NO_QUOTES = paymentSql(false);

/** The newest this many, as Jobber's feed: the bell's list, and the most its count says. */
export const NOTICE_LIMIT = 100;

type Base = { id: string; at: Date; name: string | null; email: string | null };
export type ChangeNotice = Base & {
  kind: "change";
  change: "rescheduled" | "cancelled";
  booking_id: string;
  type_name: string | null;
  was_starts_at: Date;
  /** The new start of a move; null for a cancel. */
  starts_at: Date | null;
};
export type QuoteNotice = Base & { kind: "quote"; number: string; total_cents: string; currency: string };
export type PaymentNotice = Base & { kind: "payment"; amount_cents: string; currency: string; description: string | null; livemode: boolean | null };
export type Notice = ChangeNotice | QuoteNotice | PaymentNotice;

/** The newest notifications across every kind the project has. */
export async function notices(db: Db, limit = NOTICE_LIMIT): Promise<Notice[]> {
  const p = await presentTables(db);
  const jobs: Promise<Notice[]>[] = [];
  jobs.push(db.sql<ChangeNotice>`
    select 'change' as kind, x.id::text as id, x.created_at as at, b.name, b.email::text as email, x.kind as change,
           b.id::text as booking_id, t.name as type_name, x.was_starts_at, x.starts_at
    from booking_changes x
    join bookings b on b.id = x.booking_id
    left join booking_types t on t.id = b.type_id
    order by x.created_at desc, x.id desc
    limit ${limit}`);
  if (p.quotes) {
    jobs.push(db.sql<QuoteNotice>`
      select 'quote' as kind, qt.id::text as id, qt.decided_at as at, qt.name, qt.email::text as email,
             qt.number, qt.total_cents::text as total_cents, qt.currency
      from quotes qt
      where qt.status = 'accepted' and qt.decided_by = ${PAID_ONLINE} and qt.decided_at is not null
      order by qt.decided_at desc, qt.id desc
      limit ${limit}`);
  }
  if (p.payments) {
    jobs.push((p.invoices && p.quotes ? PAYMENTS : PAYMENTS_NO_QUOTES).sql(db)<PaymentNotice>`
      select 'payment' as kind, pm.id::text as id, coalesce(pm.paid_at, pm.created_at) as at, pm.name, pm.email::text as email,
             pm.amount_cents::text as amount_cents, pm.currency, pm.description, pm.livemode
      from payments pm
      where pm.status in ('paid', 'refunded', 'partially_refunded') and {not_a_quote}
      order by coalesce(pm.paid_at, pm.created_at) desc, pm.id desc
      limit ${limit}`);
  }
  const all = (await Promise.all(jobs)).flat();
  return all.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** When this person last opened the bell; null when they never have (everything is unread). */
export async function seenAt(db: Db, user: string): Promise<Date | null> {
  const [r] = await db.sql<{ seen_at: Date }>`select seen_at from notifications_seen where email = ${user}::citext`;
  return r?.seen_at ?? null;
}

export const isUnread = (n: Notice, seen: Date | null) => !seen || n.at > seen;

/** The bell was opened: everything up to now is seen. */
export async function markSeen(db: Db, user: string): Promise<void> {
  await db.sql`
    insert into notifications_seen (email, seen_at) values (${user}::citext, now())
    on conflict (email) do update set seen_at = excluded.seen_at`;
}
