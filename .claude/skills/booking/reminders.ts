// The reminder job (machine only): a message to each booker a set time
// before their booking, through a `Send` (notify.ts; email by default).
//
//   npx tsx src/booking/reminders.ts                  # a day and an hour before
//   npx tsx src/booking/reminders.ts --before 1440,120
//
// Schedule it every 15 minutes (the platform's floor), so an hour's
// reminder goes 45 to 60 minutes before. Each reminder is claimed by a row
// in booking_reminders before it is sent, so two runs never send one twice
// and a failed send is not retried into a flood. The rules:
// - Only confirmed bookings still to come.
// - Not when the booking was made after the reminder's time: someone who
//   books an hour ahead was just sent the confirmation.
// - Only the nearest reminder that is due: a job that was down for a day
//   sends the hour's reminder, not both.
// - A booking moved to a new time is reminded again for that time.
import { pathToFileURL } from "node:url";
import { q, type Db } from "../data/db";
import { toBooking, toResource, toType } from "./book";
import { bookingMessage, emailSend, type Send } from "./notify";

export const DEFAULT_BEFORE = [1440, 60];

export type Run = { sent: number; none: number; failed: number; errors: string[] };

/** Claim and send every reminder due at `now`. `before` is minutes before the start, any order. */
export async function sendReminders(db: Db, send: Send, opts: { now?: Date; before?: number[]; limit?: number } = {}): Promise<Run> {
  const now = (opts.now ?? new Date()).toISOString();
  const before = [...new Set((opts.before ?? DEFAULT_BEFORE).filter((m) => Number.isInteger(m) && m >= 1 && m <= 10080))].sort((a, b) => a - b);
  const limit = opts.limit ?? 200;
  const run: Run = { sent: 0, none: 0, failed: 0, errors: [] };
  for (const [i, min] of before.entries()) {
    // The nearest due one wins: a longer reminder only while every shorter one is still ahead.
    const shorter = i > 0 ? before[i - 1] : 0;
    const [claimed] = await db.transaction([
      q`insert into booking_reminders (booking_id, before_min, starts_at)
        select b.id, ${min}::int, b.starts_at from bookings b
        where b.status = 'confirmed'
          and b.starts_at > ${now}::timestamptz
          and b.starts_at - ${min}::int * interval '1 minute' <= ${now}::timestamptz
          and b.starts_at - ${shorter}::int * interval '1 minute' > ${now}::timestamptz
          and b.created_at < b.starts_at - ${min}::int * interval '1 minute'
        order by b.starts_at
        limit ${limit}
        on conflict do nothing
        returning booking_id::text as id, starts_at::text as starts_at`,
    ]);
    // starts_at stays Postgres's text: a Date keeps milliseconds and would
    // miss a start stored to the microsecond.
    for (const c of claimed as { id: string; starts_at: string }[]) {
      const outcome = await remind(db, send, c.id);
      const status = outcome.status === "sent" ? "sent" : outcome.status === "none" ? "none" : "failed";
      run[status]++;
      if (outcome.status === "failed") run.errors.push(`booking ${c.id}: ${outcome.error}`);
      const detail = outcome.status === "sent" ? outcome.via : outcome.status === "none" ? outcome.why : outcome.error;
      await db.sql`
        update booking_reminders set status = ${status}, detail = ${detail.slice(0, 500)}, updated_at = now()
        where booking_id = ${c.id}::bigint and before_min = ${min}::int and starts_at = ${c.starts_at}::timestamptz`;
    }
  }
  return run;
}

async function remind(db: Db, send: Send, bookingId: string) {
  const [row] = await db.sql`
    select to_jsonb(b) as booking, to_jsonb(t) as type, to_jsonb(r) as host
    from bookings b join booking_types t on t.id = b.type_id join resources r on r.id = b.resource_id
    where b.id = ${bookingId}::bigint`;
  if (!row) return { status: "failed" as const, via: "none", error: "the booking is gone" };
  const booking = toBooking(row.booking), type = toType(row.type), host = toResource(row.host);
  const { subject, text } = bookingMessage("reminder", { booking, type, host });
  try {
    return await send({ to: booking.email, subject, text, replyTo: host.email });
  } catch (e) {
    return { status: "failed" as const, via: "send", error: e instanceof Error ? e.message : String(e) };
  }
}

// `npx tsx src/booking/reminders.ts [--before 1440,60]`: one run; exits 1
// when a send failed, so the job's run history shows why.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pg } = await import("pg");
  const { fromPool } = await import("../data/pg");
  const i = process.argv.indexOf("--before");
  const before = i > 0 ? process.argv[i + 1].split(",").map(Number) : DEFAULT_BEFORE;
  if (!process.env.DATABASE_URL) {
    console.error("Needs DATABASE_URL: run it on the machine.");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const r = await sendReminders(fromPool(pool), emailSend(process.env), { before });
    console.log(`reminders: ${r.sent} sent, ${r.none} with no sender connected, ${r.failed} failed`);
    for (const e of r.errors) console.error(e);
    process.exitCode = r.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}
