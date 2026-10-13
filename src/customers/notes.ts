// A customer's timeline: notes, calls, emails, meetings and texts. A note
// written now is stamped now; one about something earlier carries the wall
// time it happened in the business's zone, which Postgres turns into an
// instant (DST included). A call, email, meeting or text also moves the
// customer's last contact forward; a plain note does not.
import { q, type Db } from "../data/db";

export const NOTE_KINDS = ["note", "call", "email", "meeting", "text"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_LABELS: Record<NoteKind, string> = { note: "Note", call: "Call", email: "Email", meeting: "Meeting", text: "Text" };
export const pickNoteKind = (v: unknown): NoteKind | null => (NOTE_KINDS.includes(v as NoteKind) ? (v as NoteKind) : null);

export type Note = { id: string; customer_id: string; kind: NoteKind; body: string; author: string | null; happened_at: Date; created_at: Date };

/**
 * Add a note. `at` is a wall time ("2026-10-02 14:30:00") in `timeZone`, or
 * null for now. Returns null when the customer does not exist.
 */
export async function addNote(
  db: Db,
  customerId: string,
  note: { kind: NoteKind; body: string; at?: string | null; timeZone: string },
  author: string,
): Promise<Note | null> {
  const body = note.body.trim().slice(0, 10_000);
  if (!body) return null;
  const [rows] = await db.transaction([
    q`insert into customer_notes (customer_id, kind, body, author, happened_at)
      select ${customerId}::bigint, ${note.kind}, ${body}, ${author},
             coalesce(${note.at ?? null}::timestamp at time zone ${note.timeZone}::text, now())
      where exists (select 1 from customers where id = ${customerId}::bigint)
      returning *`,
    q`update customers set
        last_contact_at = greatest(last_contact_at,
          (select max(happened_at) from customer_notes where customer_id = ${customerId}::bigint and kind <> 'note')),
        updated_at = now(), updated_by = ${author}
      where id = ${customerId}::bigint`,
  ]);
  return (rows[0] as Note | undefined) ?? null;
}

export function listNotes(db: Db, customerId: string, limit = 200): Promise<Note[]> {
  return db.sql<Note>`
    select * from customer_notes where customer_id = ${customerId}::bigint
    order by happened_at desc, id desc limit ${limit}`;
}

/**
 * "2026-10-02T14:30" (a datetime-local box) or "2026-10-02 14:30[:00]": a
 * wall time, or null. Only a real calendar time: "2026-02-30 10:00" is null
 * here, not an error from Postgres.
 */
export function wallTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, sec = "00"] = m.slice(1);
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));
  const same = t.getUTCFullYear() === +y && t.getUTCMonth() === +mo - 1 && t.getUTCDate() === +d && t.getUTCHours() === +h && t.getUTCMinutes() === +mi && t.getUTCSeconds() === +sec;
  return same ? `${y}-${mo}-${d} ${h}:${mi}:${sec}` : null;
}
