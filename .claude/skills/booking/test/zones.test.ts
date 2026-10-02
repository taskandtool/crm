// The zone arithmetic against zones whose changes are odd: at midnight, by
// 30 minutes or 2 hours, a whole skipped day, a negative-DST zone, a
// suspension for Ramadan. Expected instants were worked out by hand from the
// tzdata rules and match a brute-force scan of the wall clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBounds, instantsFor, localDate, slots, wallClock, type Settings, type Window } from "../slots";

const every = (start: string, end: string): Window[] => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start, end }));
const base: Settings = { durationMin: 60, intervalMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 30 };

/** Slots on one local date, as "startZ-endHH:MM" (UTC), with `now` the day before. */
function run(zone: string, day: string, windows: Window[], settings: Partial<Settings> = {}) {
  const { start, end } = dayBounds(day, zone);
  return slots({
    zone, windows, timeOff: [], busy: [], bookings: [], settings: { ...base, ...settings },
    now: new Date(start.getTime() - 86_400_000), from: start, to: end,
  }).map((s) => `${s.start.toISOString().slice(0, 16)}-${s.end.toISOString().slice(11, 16)}`);
}

test("Havana changes at midnight: the spring day starts at 01:00, the fall day repeats its first hour", () => {
  assert.deepEqual(run("America/Havana", "2026-03-08", every("00:00", "02:00"), { durationMin: 30, intervalMin: 30 }), [
    "2026-03-08T05:00-05:30", "2026-03-08T05:30-06:00", // 01:00 and 01:30 CDT; 00:00 and 00:30 never happen
  ]);
  assert.deepEqual(run("America/Havana", "2026-11-01", every("00:00", "02:00")), [
    "2026-11-01T04:00-05:00", // 00:00 CDT, the first midnight
    "2026-11-01T06:00-07:00", // 01:00 CST; the second pass through 00:xx offers nothing
  ]);
  // The evening before ends at the first midnight.
  assert.deepEqual(run("America/Havana", "2026-10-31", every("22:00", "24:00")), ["2026-11-01T02:00-03:00", "2026-11-01T03:00-04:00"]);
});

test("Santiago springs forward at 24:00: Saturday's 24:00 is Sunday's 01:00", () => {
  assert.deepEqual(run("America/Santiago", "2026-09-05", every("22:00", "24:00")), ["2026-09-06T02:00-03:00", "2026-09-06T03:00-04:00"]);
  assert.deepEqual(run("America/Santiago", "2026-09-06", every("00:00", "02:00")), ["2026-09-06T04:00-05:00"]);
});

test("Apia skipped 30 December 2011: no slots that day, and the day before ends at the jump", () => {
  assert.deepEqual(run("Pacific/Apia", "2011-12-30", every("00:00", "24:00")), []);
  const skipped = dayBounds("2011-12-30", "Pacific/Apia");
  assert.equal(skipped.end.getTime() - skipped.start.getTime(), 0);
  assert.deepEqual(run("Pacific/Apia", "2011-12-29", every("21:00", "24:00")), [
    "2011-12-30T07:00-08:00", "2011-12-30T08:00-09:00", "2011-12-30T09:00-10:00",
  ]);
  assert.deepEqual(run("Pacific/Apia", "2011-12-31", every("00:00", "02:00")), ["2011-12-30T10:00-11:00", "2011-12-30T11:00-12:00"]);
});

test("Lord Howe moves by 30 minutes both ways", () => {
  const half = { durationMin: 30, intervalMin: 30 };
  // 02:00 to 02:30 is skipped.
  assert.deepEqual(run("Australia/Lord_Howe", "2026-10-04", every("01:30", "03:00"), half), ["2026-10-03T15:00-15:30", "2026-10-03T15:30-16:00"]);
  // 01:30 to 02:00 happens twice; the second 01:30 (15:00Z) is not offered.
  assert.deepEqual(run("Australia/Lord_Howe", "2026-04-05", every("01:00", "02:30"), half), [
    "2026-04-04T14:00-14:30", "2026-04-04T14:30-15:00", "2026-04-04T15:30-16:00",
  ]);
});

test("Troll jumps two hours; Dublin's negative DST is an ordinary spring forward in instants", () => {
  assert.deepEqual(run("Antarctica/Troll", "2026-03-29", every("00:00", "04:00")), ["2026-03-29T00:00-01:00", "2026-03-29T01:00-02:00"]);
  assert.deepEqual(run("Europe/Dublin", "2026-03-29", every("00:00", "03:00")), ["2026-03-29T00:00-01:00", "2026-03-29T01:00-02:00"]);
});

test("Casablanca falls back for Ramadan and springs forward after it", () => {
  assert.deepEqual(run("Africa/Casablanca", "2026-02-15", every("01:00", "04:00")), [
    "2026-02-15T00:00-01:00", "2026-02-15T01:00-02:00", "2026-02-15T03:00-04:00",
  ]);
  assert.deepEqual(run("Africa/Casablanca", "2026-03-22", every("01:00", "04:00")), ["2026-03-22T01:00-02:00", "2026-03-22T02:00-03:00"]);
});

test("instantsFor matches a brute-force scan of the wall clock around every change", () => {
  const zones = ["America/Havana", "America/Santiago", "Pacific/Apia", "Australia/Lord_Howe", "Europe/Dublin", "Africa/Casablanca", "Antarctica/Troll", "Asia/Tehran", "Pacific/Chatham"];
  const H = 3_600_000, STEP = 15 * 60_000;
  for (const zone of zones) {
    const changes: number[] = [];
    let prev = NaN;
    for (let t = Date.UTC(zone === "Pacific/Apia" ? 2011 : 2023, 0, 1); t < Date.UTC(2027, 0, 1); t += H) {
      const w = wallClock(t, zone);
      const o = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - t;
      if (o !== prev && !Number.isNaN(prev)) changes.push(t);
      prev = o;
    }
    assert.ok(zone === "Asia/Tehran" || changes.length >= 3, zone); // Tehran stopped changing in 2022
    for (const c of changes) {
      const seen = new Map<string, number[]>();
      for (let t = c - 90 * H; t < c + 90 * H; t += STEP) {
        const w = wallClock(t, zone);
        const k = `${localDate(t, zone)}|${w.h * 60 + w.mi}`;
        seen.set(k, [...(seen.get(k) ?? []), t]);
      }
      const dates = new Set<string>();
      for (let t = c - 30 * H; t < c + 30 * H; t += H) dates.add(localDate(t, zone));
      for (const d of dates) {
        for (let m = 0; m < 1440; m += 15) assert.deepEqual(instantsFor(d, m, zone), seen.get(`${d}|${m}`) ?? [], `${zone} ${d} ${m}`);
      }
    }
  }
});
