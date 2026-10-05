import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import {
  book, bookingByToken, cancelByToken, openSlotAt, openSlotsFor, reschedule, resourceById, setStatus, takeSlot, tokenHash, type Resource,
} from "../book";
import { addMember, addTimeOff, addWindow, createResource, weeklyHours } from "../hours";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");
const NOW = new Date("2026-03-01T00:00:00Z");
const T = (iso: string) => new Date(iso);
const who = { name: "Ann Lee", email: " Ann@Example.com ", source: "website", now: NOW };

async function person(s: Scratch, name: string, extra: Record<string, string> = {}): Promise<Resource> {
  const r = await createResource(s.db, {
    name, slug: null, email: `${name.toLowerCase()}@example.com`, time_zone: "UTC", duration_min: "60", interval_min: "60",
    buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "60", ...extra,
  }, "owner@example.com", "test");
  assert.ok(r.ok, JSON.stringify(r));
  for (let d = 0; d < 7; d++) assert.ok((await addWindow(s.db, r.value.id, String(d), "09:00", "17:00", "owner@example.com")).ok);
  return r.value;
}

async function withDb(t: { skip: (m: string) => void }, fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    await applySchema(s.db, schema); // every app runs it at start; the second run changes nothing
    await fn(s);
  } finally {
    await s.drop();
  }
}

test("two people booking the same slot at once: exactly one gets it", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const tries = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => book(s.db, { ...who, email: `p${i}@example.com`, resourceId: r.id, start: T("2026-03-09T10:00:00Z") })),
    );
    assert.equal(tries.filter((x) => x.ok).length, 1);
    assert.deepEqual(tries.filter((x) => !x.ok).map((x) => !x.ok && x.reason), ["taken", "taken", "taken", "taken"]);
    const [{ n }] = await s.db.sql`select count(*)::int as n from bookings`;
    assert.equal(n, 1);
  }));

test("moves and a new booking racing for one slot: exactly one gets it", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const held = await Promise.all(["10", "12", "14"].map((h, i) => book(s.db, { ...who, email: `h${i}@example.com`, resourceId: r.id, start: T(`2026-03-09T${h}:00:00Z`) })));
    const tokens = held.map((x) => (x.ok ? x.token : assert.fail("setup booking failed")));
    const target = T("2026-03-09T16:00:00Z");
    const tries = await Promise.all([
      ...tokens.map((tok) => reschedule(s.db, tok, target, NOW)),
      book(s.db, { ...who, email: "new@example.com", resourceId: r.id, start: target }),
    ]);
    assert.equal(tries.filter((x) => x.ok).length, 1);
    assert.deepEqual(tries.filter((x) => !x.ok).map((x) => !x.ok && x.reason), ["taken", "taken", "taken"]);
    const [{ n }] = await s.db.sql`select count(*)::int as n from bookings where status = 'confirmed' and starts_at = ${target.toISOString()}::timestamptz`;
    assert.equal(n, 1);
  }));

test("a booking that has started can no longer be cancelled by its link", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const b = await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T10:00:00Z") });
    assert.ok(b.ok);
    const late = await cancelByToken(s.db, b.token, T("2026-03-09T10:05:00Z"));
    assert.equal(!late.ok && late.reason, "closed");
    assert.equal((await bookingByToken(s.db, b.token))!.status, "confirmed");
  }));

test("the lock is taken before the check: a booking committed while waiting is seen", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const slot = (await openSlotAt(s.db, r, T("2026-03-09T10:00:00Z"), NOW))!;
    // Another booking holds the lock and has inserted, not yet committed.
    const other = await s.pool.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtext('booking:' || $1::text))", [r.id]);
      await other.query(`insert into bookings (resource_id, starts_at, ends_at, name, email)
        values ($1::bigint, '2026-03-09T10:00:00Z', '2026-03-09T11:00:00Z', 'First', 'first@example.com')`, [r.id]);
      const racing = Promise.all([1, 2].map((i) => takeSlot(s.db, r, slot, { ...who, email: `p${i}@example.com`, resourceId: r.id, start: slot.start })));
      await new Promise((ok) => setTimeout(ok, 300)); // both are now waiting on the lock
      await other.query("commit");
      const results = await racing;
      assert.deepEqual(results.map((x) => !x.ok && x.reason), ["taken", "taken"]);
    } finally {
      other.release();
    }
    const [{ n }] = await s.db.sql`select count(*)::int as n from bookings`;
    assert.equal(n, 1);
  }));

test("the transaction re-checks in SQL even when the page's check was stale", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const slot = (await openSlotAt(s.db, r, T("2026-03-09T11:00:00Z"), NOW))!;
    assert.ok(slot);
    // Between the page's check and the insert: a calendar sync adds a busy row.
    const [k] = await s.db.sql`insert into calendars (resource_id, provider) values (${r.id}::bigint, 'google') returning id::text as id`;
    await s.db.sql`insert into busy (calendar_id, starts_at, ends_at) values (${k.id}::bigint, '2026-03-09T11:30:00Z', '2026-03-09T12:30:00Z')`;
    const r1 = await takeSlot(s.db, r, slot, { ...who, resourceId: r.id, start: slot.start });
    assert.equal(!r1.ok && r1.reason, "taken");
    // And a booking someone else just took.
    const slot2 = (await openSlotAt(s.db, r, T("2026-03-09T14:00:00Z"), NOW))!;
    assert.ok((await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T14:00:00Z") })).ok);
    const r2 = await takeSlot(s.db, r, slot2, { ...who, resourceId: r.id, start: slot2.start });
    assert.equal(!r2.ok && r2.reason, "taken");
    // The page no longer offers either.
    assert.equal(await openSlotAt(s.db, r, T("2026-03-09T11:00:00Z"), NOW), null);
  }));

test("a busy row from a synced calendar blocks a slot", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const [k] = await s.db.sql`insert into calendars (resource_id, provider) values (${r.id}::bigint, 'microsoft') returning id::text as id`;
    await s.db.sql`insert into busy (calendar_id, starts_at, ends_at) values (${k.id}::bigint, '2026-03-09T10:15:00Z', '2026-03-09T10:45:00Z')`;
    const r1 = await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T10:00:00Z") });
    assert.equal(!r1.ok && r1.reason, "taken");
    assert.ok((await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T11:00:00Z") })).ok);
  }));

test("buffers hold in the page and in the transaction", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat", { buffer_after_min: "30", interval_min: "30" });
    assert.ok((await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T10:00:00Z") })).ok);
    const starts = (await openSlotsFor(s.db, r, T("2026-03-09T09:00:00Z"), T("2026-03-09T13:00:00Z"), NOW)).map((x) => x.start.toISOString());
    assert.deepEqual(starts, ["2026-03-09T11:30:00.000Z", "2026-03-09T12:00:00.000Z", "2026-03-09T12:30:00.000Z"]);
    // 09:00 is blocked too (it ends at 10:00 and needs 30 minutes after). Forcing 11:00 past the page check fails in SQL.
    const forced = { start: T("2026-03-09T11:00:00Z"), end: T("2026-03-09T12:00:00Z"), members: [r.id] };
    const r1 = await takeSlot(s.db, r, forced, { ...who, resourceId: r.id, start: forced.start });
    assert.equal(!r1.ok && r1.reason, "taken");
  }));

test("time off and minimum notice are honoured; a slot off the grid is refused", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat", { min_notice_min: "1440" });
    assert.ok((await addTimeOff(s.db, r, "2026-03-10T00:00", "2026-03-11T00:00", "Away", "owner@example.com")).ok);
    const go = (iso: string) => book(s.db, { ...who, resourceId: r.id, start: T(iso), now: T("2026-03-09T08:00:00Z") });
    assert.equal(((await go("2026-03-09T15:00:00Z")) as { reason: string }).reason, "taken", "inside the notice");
    assert.equal(((await go("2026-03-10T10:00:00Z")) as { reason: string }).reason, "taken", "time off");
    assert.equal(((await go("2026-03-11T10:30:00Z")) as { reason: string }).reason, "taken", "off the grid");
    assert.ok((await go("2026-03-11T10:00:00Z")).ok);
  }));

test("cancelling frees the slot; a wrong token does nothing", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const first = await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T10:00:00Z") });
    assert.ok(first.ok);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    const [stored] = await s.db.sql`select manage_token_hash from bookings`;
    assert.equal(stored.manage_token_hash, await tokenHash(first.token));
    assert.notEqual(stored.manage_token_hash, first.token);
    assert.equal(first.booking.email, "ann@example.com");

    const wrong = first.token.slice(0, -1) + (first.token.endsWith("A") ? "B" : "A");
    assert.equal(await bookingByToken(s.db, wrong), null);
    assert.equal(await bookingByToken(s.db, "short"), null);
    assert.equal(((await cancelByToken(s.db, wrong, NOW)) as { reason: string }).reason, "not_found");
    assert.equal((await bookingByToken(s.db, first.token))!.status, "confirmed");

    const c = await cancelByToken(s.db, first.token, NOW);
    assert.ok(c.ok);
    assert.equal(c.booking.status, "cancelled");
    assert.equal(c.booking.sequence, 1);
    assert.equal(((await cancelByToken(s.db, first.token, NOW)) as { reason: string }).reason, "closed");
    assert.ok((await book(s.db, { ...who, email: "bo@example.com", resourceId: r.id, start: T("2026-03-09T10:00:00Z") })).ok);
  }));

test("reschedule by token moves the booking and raises SEQUENCE", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const a = await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T10:00:00Z") });
    const b = await book(s.db, { ...who, email: "bo@example.com", resourceId: r.id, start: T("2026-03-09T12:00:00Z") });
    assert.ok(a.ok && b.ok);
    assert.equal(((await reschedule(s.db, a.token, T("2026-03-09T12:00:00Z"), NOW)) as { reason: string }).reason, "taken");
    const moved = await reschedule(s.db, a.token, T("2026-03-09T11:00:00Z"), NOW);
    assert.ok(moved.ok);
    assert.equal(moved.booking.starts_at.toISOString(), "2026-03-09T11:00:00.000Z");
    assert.equal(moved.booking.sequence, 1);
    // A move by one hour overlapping its own old time is fine: it does not block itself.
    assert.ok((await reschedule(s.db, a.token, T("2026-03-09T10:00:00Z"), NOW)).ok);
    assert.equal(((await reschedule(s.db, a.token, T("2026-03-09T13:00:00Z"), T("2026-03-09T10:30:00Z"))) as { reason: string }).reason, "closed", "already started");
  }));

test("a crew booking goes to the free member booked least recently", (t) =>
  withDb(t, async (s) => {
    const ann = await person(s, "Ann"), bo = await person(s, "Bo"), cy = await person(s, "Cy");
    const crew = await createResource(s.db, {
      kind: "crew", name: "Crew", slug: "crew", email: "", time_zone: "UTC", duration_min: "60", interval_min: "60",
      buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "60",
    }, "owner@example.com", "test");
    assert.ok(crew.ok);
    for (const m of [ann, bo, cy]) assert.ok((await addMember(s.db, crew.value.id, m.id)).ok);
    assert.ok(!(await addMember(s.db, crew.value.id, crew.value.id)).ok, "a crew is not its own member");

    // History: Ann booked on 1 Feb, Bo on 2 Feb, Cy never.
    for (const [m, at] of [[ann, "2026-02-01T00:00:00Z"], [bo, "2026-02-02T00:00:00Z"]] as const) {
      await s.db.sql`insert into bookings (resource_id, starts_at, ends_at, name, email, status, created_at)
        values (${m.id}::bigint, '2026-02-10T10:00:00Z', '2026-02-10T11:00:00Z', 'Old', 'old@example.com', 'completed', ${at}::timestamptz)`;
    }
    const go = (iso: string, email: string) => book(s.db, { ...who, email, resourceId: crew.value.id, start: T(iso) });
    const r1 = await go("2026-03-09T10:00:00Z", "a@example.com");
    assert.ok(r1.ok);
    assert.equal(r1.booking.resource_id, cy.id, "never booked comes first");
    assert.equal(r1.booking.crew_id, crew.value.id);
    const r2 = await go("2026-03-09T10:00:00Z", "b@example.com");
    assert.ok(r2.ok);
    assert.equal(r2.booking.resource_id, ann.id, "then the oldest last booking");
    // Bo is the only one left free at 10:00.
    const r3 = await go("2026-03-09T10:00:00Z", "c@example.com");
    assert.ok(r3.ok);
    assert.equal(r3.booking.resource_id, bo.id);
    const r4 = await go("2026-03-09T10:00:00Z", "d@example.com");
    assert.equal(!r4.ok && r4.reason, "taken");
    // At 11:00 all three are free again; Cy's latest booking (r1) is the oldest.
    const r5 = await go("2026-03-09T11:00:00Z", "e@example.com");
    assert.ok(r5.ok);
    assert.equal(r5.booking.resource_id, cy.id);
    // A busy member is skipped even when least recently booked.
    await s.db.sql`insert into time_off (resource_id, starts_at, ends_at) values (${ann.id}::bigint, '2026-03-09T12:00:00Z', '2026-03-09T13:00:00Z')`;
    const r6 = await go("2026-03-09T12:00:00Z", "f@example.com");
    assert.ok(r6.ok);
    assert.equal(r6.booking.resource_id, bo.id);
    const slot = await openSlotAt(s.db, (await resourceById(s.db, crew.value.id))!, T("2026-03-09T12:00:00Z"), NOW);
    assert.deepEqual(slot?.members, [cy.id]);
  }));

test("the team marks a booking; a cancelled one stays cancelled", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const a = await book(s.db, { ...who, resourceId: r.id, start: T("2026-03-09T10:00:00Z") });
    assert.ok(a.ok);
    const done = await setStatus(s.db, a.booking.id, "completed", "owner@example.com");
    assert.equal(done?.status, "completed");
    assert.equal(done?.updated_by, "owner@example.com");
    assert.equal(done?.sequence, 0);
    const cancelled = await setStatus(s.db, a.booking.id, "cancelled", "owner@example.com");
    assert.equal(cancelled?.sequence, 1);
    assert.equal(await setStatus(s.db, a.booking.id, "no_show", "owner@example.com"), null);
  }));

test("the hours editor refuses bad and overlapping windows", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    assert.equal(((await addWindow(s.db, r.id, "1", "17:00", "09:00", "o@x.com")) as { errors: Record<string, string> }).errors.end !== undefined, true);
    assert.equal(((await addWindow(s.db, r.id, "1", "16:00", "18:00", "o@x.com")) as { errors: Record<string, string> }).errors.start, "These hours overlap hours already set for that day.");
    assert.ok((await addWindow(s.db, r.id, "1", "17:00", "24:00", "o@x.com")).ok, "touching is fine; 24:00 is midnight");
    assert.ok(!(await addWindow(s.db, r.id, "9", "10:00", "11:00", "o@x.com")).ok);
    const mon = (await weeklyHours(s.db, r.id)).filter((w) => w.weekday === 1);
    assert.deepEqual(mon.map((w) => [w.start, w.end]), [["09:00", "17:00"], ["17:00", "24:00"]]);
    const bad = await createResource(s.db, { name: "", slug: "Bad Slug", email: "nope", time_zone: "Mars/Base", duration_min: "0", interval_min: "30", buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "60" }, "o@x.com", "test");
    assert.ok(!bad.ok);
    assert.deepEqual(Object.keys(bad.errors).sort(), ["duration_min", "email", "name", "slug", "time_zone"]);
  }));

test("a booking that has not started cannot be marked completed or no-show: that would free its slot", (t) =>
  withDb(t, async (s) => {
    const r = await person(s, "Pat");
    const soon = new Date(Math.ceil((Date.now() + 2 * 86_400_000) / 3_600_000) * 3_600_000);
    soon.setUTCHours(10);
    const a = await book(s.db, { ...who, now: new Date(), resourceId: r.id, start: soon });
    assert.ok(a.ok, JSON.stringify(a));
    assert.equal(await setStatus(s.db, a.booking.id, "completed", "owner@example.com"), null);
    assert.equal(await setStatus(s.db, a.booking.id, "no_show", "owner@example.com"), null);
    const second = await book(s.db, { ...who, email: "bo@example.com", now: new Date(), resourceId: r.id, start: soon });
    assert.equal(!second.ok && second.reason, "taken", "the slot is still held");
    assert.equal((await setStatus(s.db, a.booking.id, "cancelled", "owner@example.com"))?.status, "cancelled", "cancelling a future booking is fine");
  }));
