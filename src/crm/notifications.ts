// The bell: what happened without the team doing it, newest first, as
// Jobber's activity feed (docs/plans/crm-contacts-leads-deals.md).
// A booker's own move or cancel (the booking skill's booking_changes), a
// proposal the customer signed or declined at its link, and money paid
// through Stripe. News, not work: no Done. Each person's notifications_seen
// row says when they last opened the bell, which clears its count as
// HubSpot's does; unread is anything newer. Tables the project does not have
// are skipped (tables.ts).
import type { Db } from "../data/db";
import { ONLINE } from "../invoices/quotes";
import { present as presentTables } from "./tables";

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
/** A quote the customer answered at its link themselves: signed (accepted) or declined. One the team marked is not news. */
export type QuoteNotice = Base & { kind: "quote"; answer: "accepted" | "declined"; number: string; total_cents: string; currency: string };
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
      select 'quote' as kind, qt.id::text as id, qt.decided_at as at, qt.name, qt.email::text as email, qt.status as answer,
             qt.number, qt.total_cents::text as total_cents, qt.currency
      from quotes qt
      where ((qt.status = 'accepted' and qt.decided_by = ${ONLINE.accepted}) or (qt.status = 'declined' and qt.decided_by = ${ONLINE.declined}))
        and qt.decided_at is not null
      order by qt.decided_at desc, qt.id desc
      limit ${limit}`);
  }
  if (p.payments) {
    jobs.push(db.sql<PaymentNotice>`
      select 'payment' as kind, pm.id::text as id, coalesce(pm.paid_at, pm.created_at) as at, pm.name, pm.email::text as email,
             pm.amount_cents::text as amount_cents, pm.currency, pm.description, pm.livemode
      from payments pm
      where pm.status in ('paid', 'refunded', 'partially_refunded')
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
