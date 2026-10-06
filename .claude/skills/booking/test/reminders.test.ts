import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { createPerson, createType, setHosts } from "../hours";
import type { Message, Send } from "../notify";
import { sendReminders } from "../reminders";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");
const T = (iso: string) => new Date(iso);

/** A host, a video call type, and a booking at `start` made at `made`. */
async function setup(s: Scratch) {
  await applySchema(s.db, schema);
  const p = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "America/New_York" }, "o@x.com", "test");
  const t = await createType(s.db, {
    name: "Video consultation", slug: "video", duration_min: "30", interval_min: "30", buffer_before_min: "0", buffer_after_min: "0",
    min_notice_min: "0", horizon_days: "30", location_kind: "video", location: "https://meet.example/pat",
  }, "o@x.com", "test");
  assert.ok(p.ok && t.ok);
  await setHosts(s.db, t.value.id, [p.value.id]);
  const add = async (start: string, made: string, email = "ann@example.com", status = "confirmed") => {
    const [b] = await s.db.sql<{ id: string }>`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, location_kind, location, booker_time_zone, status, created_at)
      values (${t.value.id}::bigint, ${p.value.id}::bigint, ${start}::timestamptz, ${start}::timestamptz + interval '30 minutes', 'Ann', ${email},
              'video', 'https://meet.example/pat', 'Europe/London', ${status}, ${made}::timestamptz)
      returning id::text as id`;
    return b.id;
  };
  return { add };
}

function capture(result: Awaited<ReturnType<Send>> = { status: "sent", via: "test" }) {
  const sent: Message[] = [];
  const send: Send = async (m) => (sent.push(m), result);
  return { sent, send };
}

test("a day before and an hour before, once each; the words name what, who, when in their zone, and the link", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    const { add } = await setup(s);
    const id = await add("2026-03-10T15:00:00Z", "2026-03-01T00:00:00Z");
    const { sent, send } = capture();
    assert.deepEqual(await sendReminders(s.db, send, { now: T("2026-03-09T14:00:00Z") }), { sent: 0, none: 0, failed: 0, errors: [] }, "25 hours ahead: nothing yet");
    assert.equal((await sendReminders(s.db, send, { now: T("2026-03-09T15:10:00Z") })).sent, 1);
    assert.equal((await sendReminders(s.db, send, { now: T("2026-03-09T15:25:00Z") })).sent, 0, "never twice");
    assert.equal(sent[0].to, "ann@example.com");
    assert.equal(sent[0].subject, "Reminder: Video consultation");
    assert.equal(sent[0].replyTo, "pat@example.com");
    assert.match(sent[0].text, /^Hi Ann,\n\nA reminder of your Video consultation with Pat\.\n\nTuesday, March 10, 3:00 PM to 3:30 PM GMT\nVideo call: https:\/\/meet\.example\/pat\n\n/);
    assert.match(sent[0].text, /use the link in your booking confirmation, or reply to this email\./);
    assert.equal((await sendReminders(s.db, send, { now: T("2026-03-10T14:05:00Z") })).sent, 1, "the hour's");
    assert.equal((await sendReminders(s.db, send, { now: T("2026-03-10T15:30:00Z") })).sent, 0, "started: nothing more");
    assert.equal(sent.length, 2);
    // Moved to a new time: reminded again for it.
    await s.db.sql`update bookings set starts_at = '2026-03-12T15:00:00Z', ends_at = '2026-03-12T15:30:00Z' where id = ${id}::bigint`;
    assert.equal((await sendReminders(s.db, send, { now: T("2026-03-11T15:05:00Z") })).sent, 1);
  } finally {
    await s.drop();
  }
});

test("the nearest due reminder only; none for a booking made after its time, a cancelled one, or one whose form is unfinished", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    const { add } = await setup(s);
    await add("2026-03-10T15:00:00Z", "2026-03-01T00:00:00Z", "late-job@example.com"); // the job was down until 14:30
    await add("2026-03-10T15:00:00Z", "2026-03-10T09:00:00Z", "booked-today@example.com"); // made 6 hours ahead
    await add("2026-03-10T16:00:00Z", "2026-03-01T00:00:00Z", "gone@example.com", "cancelled");
    const held = await add("2026-03-10T15:00:00Z", "2026-03-01T00:00:00Z", "still-paying@example.com");
    await s.db.sql`update bookings set hold_until = '2026-03-10T15:00:00Z' where id = ${held}::bigint`;
    const { sent, send } = capture();
    const r = await sendReminders(s.db, send, { now: T("2026-03-10T14:30:00Z") });
    assert.deepEqual(sent.map((m) => m.to).sort(), ["booked-today@example.com", "late-job@example.com"]);
    assert.equal(r.sent, 2, "each gets the hour's reminder, and nobody the day's");
    const rows = await s.db.sql`select before_min, status from booking_reminders order by before_min`;
    assert.deepEqual(rows.map((x) => [x.before_min, x.status]), [[60, "sent"], [60, "sent"]]);
    // Booked 30 minutes ahead: it had its confirmation; no reminder.
    const { sent: s2, send: send2 } = capture();
    await add("2026-03-10T17:00:00Z", "2026-03-10T16:30:00Z", "last-minute@example.com");
    await sendReminders(s.db, send2, { now: T("2026-03-10T16:31:00Z") });
    assert.equal(s2.length, 0);
  } finally {
    await s.drop();
  }
});

test("no sender is recorded and not retried; a failure is reported and not retried; two runs at once send once", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    const { add } = await setup(s);
    await add("2026-03-10T15:00:00Z", "2026-03-01T00:00:00Z", "a@example.com");
    await add("2026-03-10T15:30:00Z", "2026-03-01T00:00:00Z", "b@example.com");
    const none = capture({ status: "none", why: "no email sender is connected to this app" });
    assert.deepEqual(await sendReminders(s.db, none.send, { now: T("2026-03-10T14:20:00Z"), before: [60] }), { sent: 0, none: 1, failed: 0, errors: [] });
    assert.equal((await s.db.sql`select detail from booking_reminders`)[0].detail, "no email sender is connected to this app");
    // A start stored to the microsecond (now() + an interval) is recorded too, not left as sending.
    await s.db.sql`insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, location_kind, created_at)
      select type_id, resource_id, '2026-03-10T14:55:00.123456Z', '2026-03-10T15:25:00.123456Z', 'Micro', 'micro@example.com', 'video', '2026-03-01T00:00:00Z'
      from bookings limit 1`;
    await sendReminders(s.db, none.send, { now: T("2026-03-10T14:20:00Z"), before: [60] });
    assert.deepEqual((await s.db.sql`select r.status from booking_reminders r join bookings b on b.id = r.booking_id where b.name = 'Micro'`).map((x) => x.status), ["none"]);
    const broken: Send = async () => { throw new Error("socket hang up"); };
    const r = await sendReminders(s.db, broken, { now: T("2026-03-10T14:40:00Z"), before: [60] });
    assert.deepEqual([r.failed, r.errors], [1, ["booking " + (await s.db.sql`select id::text as id from bookings where email = 'b@example.com'`)[0].id + ": socket hang up"]]);
    assert.equal((await sendReminders(s.db, capture().send, { now: T("2026-03-10T14:50:00Z"), before: [60] })).sent, 0, "claimed rows are done with");

    await add("2026-03-11T15:00:00Z", "2026-03-01T00:00:00Z", "c@example.com");
    const both = capture();
    const runs = await Promise.all([1, 2, 3].map(() => sendReminders(s.db, both.send, { now: T("2026-03-11T14:10:00Z"), before: [60] })));
    assert.equal(runs.reduce((n, x) => n + x.sent, 0), 1);
    assert.equal(both.sent.length, 1);
  } finally {
    await s.drop();
  }
});

const JOB = join(dirname(fileURLToPath(import.meta.url)), "..", "reminders-job.ts");
/** The job's command, with only the environment named (no sender, no database unless given). */
const job = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", JOB, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

test("the job's command: --help, bad options and no database say what to do", () => {
  const help = job(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--before/);
  for (const args of [["--before"], ["--before", "0,abc"], ["--soon"]]) {
    const r = job(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /Try: npx tsx src\/booking\/reminders-job\.ts/);
  }
  const noDb = job(["--before", "60"]);
  assert.equal(noDb.status, 1);
  assert.match(noDb.stderr, /DATABASE_URL/);
});

test("the job's command: one line of what was sent and what was left alone", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    const { add } = await setup(s);
    assert.match(job([], { DATABASE_URL: s.url }).stdout, /^booking reminders: none due/);
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    await add(soon, "2026-01-01T00:00:00Z");
    const r = job(["--before=60"], { DATABASE_URL: s.url });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "booking reminders: 0 sent, 1 not sent (no email sender connected; recorded, not retried)\n");
  } finally {
    await s.drop();
  }
});
