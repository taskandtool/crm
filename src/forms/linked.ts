// What a submission led to: its booking (bookings.submission_id) and its
// payment (payments.ref_type 'submission'), read for showing beside it.
// Forms writes neither table and needs neither: a project without them
// shows nothing more. Edge-safe.
//
//   const linked = await linkedTo(db, rows.map((r) => r.id));
//   linked.get(id)?.payment?.label   // "Paid $116.00", "Awaiting payment", "Not paid"
import type { Db } from "../data/db";
import { formatMoney } from "../payments/money";

export type Linked = {
  booking: { id: string; starts_at: Date; status: string; held: boolean } | null;
  payment: { id: string; status: string; cents: string; currency: string; livemode: boolean | null; label: string } | null;
};

/** The person's payment state in a few words. */
export function paymentLabel(p: { status: string; cents: string; currency: string; livemode: boolean | null }): string {
  const amount = formatMoney(Number(p.cents), p.currency);
  const test = p.livemode === false ? " (test)" : "";
  if (p.status === "paid") return `Paid ${amount}${test}`;
  if (p.status === "partially_refunded") return `Paid ${amount}, partly refunded${test}`;
  if (p.status === "refunded") return `Refunded${test}`;
  if (p.status === "pending") return "Awaiting payment";
  return "Not paid";
}

export async function linkedTo(db: Db, ids: string[]): Promise<Map<string, Linked>> {
  const out = new Map<string, Linked>(ids.map((id) => [id, { booking: null, payment: null }]));
  if (!ids.length) return out;
  // A table that is not there cannot be named even in a query that would not reach it.
  // A bookings table made by an older booking skill has no submission_id yet.
  const [has] = await db.sql<{ bookings: boolean; payments: boolean }>`
    select exists (select 1 from information_schema.columns where table_schema = any(current_schemas(false))
                   and table_name = 'bookings' and column_name = 'submission_id') as bookings,
           to_regclass('payments') is not null as payments`;
  const [bookings, payments] = await Promise.all([
    has.bookings
      ? db.sql`
          select distinct on (submission_id) submission_id::text as sid, id::text as id, starts_at, status, hold_until
          from bookings where submission_id = any(${ids}::bigint[])
          order by submission_id, (status = 'confirmed') desc, created_at desc`
      : [],
    has.payments
      ? db.sql`
          select distinct on (ref_id) ref_id as sid, id::text as id, status, coalesce(total_cents, amount_cents)::text as cents, currency, livemode
          from payments where ref_type = 'submission' and ref_id = any(${ids}::text[])
          order by ref_id, (status in ('paid', 'partially_refunded', 'refunded')) desc, created_at desc`
      : [],
  ]);
  for (const b of bookings) {
    out.get(b.sid)!.booking = { id: b.id, starts_at: new Date(b.starts_at), status: b.status, held: !!b.hold_until && b.status === "confirmed" };
  }
  for (const p of payments) {
    const pay = { id: p.id, status: p.status, cents: p.cents, currency: p.currency, livemode: p.livemode ?? null };
    out.get(p.sid)!.payment = { ...pay, label: paymentLabel(pay) };
  }
  return out;
}
