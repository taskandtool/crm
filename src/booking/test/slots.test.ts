import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDays, byLocalDate, dayBounds, formatSlot, formatTime, instantsFor, isValidZone, localDate, mergeIntervals,
  parseWallTime, slots, wallToInstant, weekdayOf, type Settings, type SlotInput, type Window,
} from "../slots";

const here = dirname(fileURLToPath(import.meta.url));
const T = (iso: string) => new Date(iso);
const iso = (list: { start: Date }[]) => list.map((s) => s.start.toISOString());
const every = (start: string, end: string): Window[] => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start, end }));
const base: Settings = { durationMin: 60, intervalMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 730 };

function run(zone: string, day: string, windows: Window[], settings: Partial<Settings> = {}, extra: Partial<SlotInput> = {}) {
  const { start, end } = dayBounds(day, zone);
  return slots({
    zone, windows, timeOff: [], busy: [], bookings: [], settings: { ...base, ...settings },
    now: T("2026-01-01T00:00:00Z"), from: start, to: end, ...extra,
  });
}

// ---- the zone arithmetic ------------------------------------------------------

test("a wall time maps to every instant that shows it: none in a gap, two in a repeat", () => {
  assert.deepEqual(instantsFor("2026-03-08", 150, "America/New_York"), []); // 02:30 skipped
  assert.deepEqual(instantsFor("2026-11-01", 90, "America/New_York").map((t) => new Date(t).toISOString()), [
    "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z",
  ]);
  assert.equal(wallToInstant("2026-11-01", 90, "America/New_York")!.toISOString(), "2026-11-01T05:30:00.000Z"); // earlier
  assert.equal(wallToInstant("2026-03-08", 150, "America/New_York"), null);
  assert.equal(wallToInstant("2026-03-08", 150, "America/New_York", "forward")!.toISOString(), "2026-03-08T07:30:00.000Z"); // 03:30 EDT
  assert.equal(wallToInstant("2026-07-01", 0, "UTC")!.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(wallToInstant("2026-07-01", 1440, "Asia/Kolkata")!.toISOString(), "2026-07-01T18:30:00.000Z"); // 24:00 is next midnight
});

test("a local day is walked as a date: the spring-forward day is 23 hours, fall-back 25", () => {
  const spring = dayBounds("2026-03-08", "America/New_York");
  const fall = dayBounds("2026-11-01", "America/New_York");
  assert.equal((spring.end.getTime() - spring.start.getTime()) / 3_600_000, 23);
  assert.equal((fall.end.getTime() - fall.start.getTime()) / 3_600_000, 25);
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayOf("2026-03-08"), 0);
  assert.equal(localDate(T("2026-03-09T03:00:00Z"), "America/New_York"), "2026-03-08");
  assert.equal(localDate(T("2026-03-09T03:00:00Z"), "Asia/Kolkata"), "2026-03-09");
});

test("wall times parse strictly", () => {
  assert.equal(parseWallTime("09:30"), 570);
  assert.equal(parseWallTime("09:30:00"), 570);
  assert.equal(parseWallTime("24:00"), 1440);
  assert.equal(parseWallTime("24:00:00"), 1440);
  for (const bad of ["24:30", "9", "12:60", "ab:cd", "10:00:30"]) assert.ok(Number.isNaN(parseWallTime(bad)), bad);
  assert.ok(isValidZone("Australia/Lord_Howe"));
  assert.ok(!isValidZone("Mars/Olympus"));
  assert.ok(!isValidZone(""));
});

// ---- daylight saving -----------------------------------------------------------

test("New York spring forward: 02:00 does not exist, so it has no slot", () => {
  assert.deepEqual(iso(run("America/New_York", "2026-03-08", every("01:00", "04:00"))), [
    "2026-03-08T06:00:00.000Z", // 01:00 EST
    "2026-03-08T07:00:00.000Z", // 03:00 EDT; ends 08:00Z = 04:00 EDT
  ]);
  assert.deepEqual(iso(run("America/New_York", "2026-03-08", every("01:00", "04:00"), { durationMin: 30, intervalMin: 30 })), [
    "2026-03-08T06:00:00.000Z", "2026-03-08T06:30:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z",
  ]);
});

test("New York spring forward: a window ending inside the gap ends after it", () => {
  // 00:00 to 02:30; 02:30 does not exist, the window ends at 03:30 EDT (07:30Z).
  assert.deepEqual(iso(run("America/New_York", "2026-03-08", every("00:00", "02:30"), { intervalMin: 30 })), [
    "2026-03-08T05:00:00.000Z", "2026-03-08T05:30:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-08T06:30:00.000Z",
  ]);
});

test("New York fall back: the repeated hour is offered once, at the earlier offset", () => {
  assert.deepEqual(iso(run("America/New_York", "2026-11-01", every("01:00", "04:00"))), [
    "2026-11-01T05:00:00.000Z", // 01:00 EDT
    "2026-11-01T07:00:00.000Z", // 02:00 EST
    "2026-11-01T08:00:00.000Z", // 03:00 EST; ends 09:00Z = 04:00 EST
  ]);
  const half = iso(run("America/New_York", "2026-11-01", every("01:00", "04:00"), { durationMin: 30, intervalMin: 30 }));
  assert.deepEqual(half, [
    "2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T07:00:00.000Z",
    "2026-11-01T07:30:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T08:30:00.000Z",
  ]);
  assert.ok(!half.includes("2026-11-01T06:00:00.000Z") && !half.includes("2026-11-01T06:30:00.000Z"), "no second pass through 01:xx");
  // A window that ends at the repeated 01:30 ends at its first occurrence.
  assert.deepEqual(iso(run("America/New_York", "2026-11-01", every("00:00", "01:30"), { durationMin: 30, intervalMin: 30 })), [
    "2026-11-01T04:00:00.000Z", "2026-11-01T04:30:00.000Z", "2026-11-01T05:00:00.000Z",
  ]);
});

test("London spring forward and fall back", () => {
  assert.deepEqual(iso(run("Europe/London", "2026-03-29", every("00:00", "03:00"))), [
    "2026-03-29T00:00:00.000Z", // 00:00 GMT
    "2026-03-29T01:00:00.000Z", // 02:00 BST (01:00 skipped)
  ]);
  assert.deepEqual(iso(run("Europe/London", "2026-10-25", every("00:00", "03:00"))), [
    "2026-10-24T23:00:00.000Z", // 00:00 BST
    "2026-10-25T00:00:00.000Z", // 01:00 BST, the earlier one
    "2026-10-25T02:00:00.000Z", // 02:00 GMT
  ]);
});

test("Lord Howe moves by thirty minutes", () => {
  // 4 Oct 2026: 02:00 +10:30 becomes 02:30 +11.
  assert.deepEqual(iso(run("Australia/Lord_Howe", "2026-10-04", every("01:00", "04:00"), { durationMin: 30, intervalMin: 30 })), [
    "2026-10-03T14:30:00.000Z", "2026-10-03T15:00:00.000Z", // 01:00, 01:30 at +10:30
    "2026-10-03T15:30:00.000Z", "2026-10-03T16:00:00.000Z", "2026-10-03T16:30:00.000Z", // 02:30, 03:00, 03:30 at +11
  ]);
  // 5 Apr 2026: 02:00 +11 becomes 01:30 +10:30; 01:30 to 02:00 happens twice.
  assert.deepEqual(iso(run("Australia/Lord_Howe", "2026-04-05", every("01:00", "03:00"), { durationMin: 30, intervalMin: 30 })), [
    "2026-04-04T14:00:00.000Z", "2026-04-04T14:30:00.000Z", // 01:00, first 01:30 at +11
    "2026-04-04T15:30:00.000Z", "2026-04-04T16:00:00.000Z", // 02:00, 02:30 at +10:30
  ]);
});

test("Kolkata at +05:30 and UTC have no daylight saving", () => {
  const monday = [{ weekday: 1, start: "09:00", end: "12:00" }];
  assert.deepEqual(iso(run("Asia/Kolkata", "2026-03-09", monday)), [
    "2026-03-09T03:30:00.000Z", "2026-03-09T04:30:00.000Z", "2026-03-09T05:30:00.000Z",
  ]);
  assert.deepEqual(iso(run("Asia/Kolkata", "2026-10-26", monday)), [
    "2026-10-26T03:30:00.000Z", "2026-10-26T04:30:00.000Z", "2026-10-26T05:30:00.000Z",
  ]);
  assert.deepEqual(iso(run("UTC", "2026-03-09", monday)), ["2026-03-09T09:00:00.000Z", "2026-03-09T10:00:00.000Z", "2026-03-09T11:00:00.000Z"]);
  assert.deepEqual(iso(run("UTC", "2026-03-10", monday)), [], "Tuesday has no hours");
});

// ---- what blocks a slot ------------------------------------------------------------

const workday = [{ weekday: 1, start: "09:00", end: "17:00" }]; // Monday 9 March 2026, UTC

test("buffers keep the padded slot clear of busy time", () => {
  const busy = [{ start: T("2026-03-09T12:00:00Z"), end: T("2026-03-09T13:00:00Z") }];
  const got = iso(run("UTC", "2026-03-09", workday, { intervalMin: 30, bufferBeforeMin: 15, bufferAfterMin: 15 }, { busy }));
  assert.ok(got.includes("2026-03-09T10:30:00.000Z"), "ends 11:30, +15 is 11:45");
  assert.ok(!got.includes("2026-03-09T11:00:00.000Z"), "ends 12:00, +15 overlaps");
  assert.ok(!got.includes("2026-03-09T13:00:00.000Z"), "-15 is 12:45, overlaps");
  assert.ok(got.includes("2026-03-09T13:30:00.000Z"), "-15 is 13:15");
  assert.ok(got.includes("2026-03-09T09:00:00.000Z"), "the buffer may fall outside the window");
});

test("two bookings stay after + before apart", () => {
  const bookings = [{ start: T("2026-03-09T12:00:00Z"), end: T("2026-03-09T13:00:00Z") }];
  const got = iso(run("UTC", "2026-03-09", workday, { intervalMin: 10, bufferBeforeMin: 10, bufferAfterMin: 20 }, { bookings }));
  const around = got.filter((s) => s >= "2026-03-09T10:00" && s < "2026-03-09T14:00");
  // Before it: this slot's after (20) + the booking's before (10) = 30 min gap, so the last ends 11:30.
  // After it: the booking's after (20) + this slot's before (10) = 30 min gap, so the first starts 13:30.
  assert.deepEqual(around, [
    "2026-03-09T10:00:00.000Z", "2026-03-09T10:10:00.000Z", "2026-03-09T10:20:00.000Z", "2026-03-09T10:30:00.000Z",
    "2026-03-09T13:30:00.000Z", "2026-03-09T13:40:00.000Z", "2026-03-09T13:50:00.000Z",
  ]);
});

test("time off blocks like busy time", () => {
  const timeOff = [{ start: T("2026-03-09T00:00:00Z"), end: T("2026-03-09T14:00:00Z") }];
  assert.deepEqual(iso(run("UTC", "2026-03-09", workday, {}, { timeOff })), [
    "2026-03-09T14:00:00.000Z", "2026-03-09T15:00:00.000Z", "2026-03-09T16:00:00.000Z",
  ]);
});

test("overlapping and touching busy times merge, in any order", () => {
  assert.deepEqual(mergeIntervals([{ start: 30, end: 40 }, { start: 0, end: 10 }, { start: 10, end: 20 }, { start: 5, end: 8 }, { start: 50, end: 50 }]), [
    { start: 0, end: 20 }, { start: 30, end: 40 },
  ]);
  const busy = [
    { start: T("2026-03-09T11:30:00Z"), end: T("2026-03-09T12:00:00Z") },
    { start: T("2026-03-09T10:00:00Z"), end: T("2026-03-09T10:45:00Z") },
    { start: T("2026-03-09T10:30:00Z"), end: T("2026-03-09T11:30:00Z") },
  ];
  assert.deepEqual(iso(run("UTC", "2026-03-09", [{ weekday: 1, start: "09:00", end: "13:00" }], {}, { busy })), [
    "2026-03-09T09:00:00.000Z", "2026-03-09T12:00:00.000Z",
  ]);
});

test("minimum notice counts from now", () => {
  const got = slots({
    zone: "UTC", windows: workday, timeOff: [], busy: [], bookings: [],
    settings: { ...base, intervalMin: 30, minNoticeMin: 60 },
    now: T("2026-03-09T08:10:00Z"), from: T("2026-03-09T00:00:00Z"), to: T("2026-03-10T00:00:00Z"),
  });
  assert.equal(got[0].start.toISOString(), "2026-03-09T09:30:00.000Z");
});

test("the horizon is counted in local dates of the zone", () => {
  const week = (zone: string, now: string, horizonDays: number) =>
    [...byLocalDate(slots({
      zone, windows: every("09:00", "10:00"), timeOff: [], busy: [], bookings: [], settings: { ...base, horizonDays },
      now: T(now), from: T("2026-03-01T00:00:00Z"), to: T("2026-03-20T00:00:00Z"),
    }), zone).keys()];
  assert.deepEqual(week("UTC", "2026-03-09T08:00:00Z", 2), ["2026-03-09", "2026-03-10", "2026-03-11"]);
  assert.deepEqual(week("UTC", "2026-03-09T08:00:00Z", 0), ["2026-03-09"]);
  // 03:00Z on the 9th is still the 8th in New York: today is the 8th.
  assert.deepEqual(week("America/New_York", "2026-03-09T03:00:00Z", 1), ["2026-03-09"]);
});

test("only slots that start inside [from, to) are returned", () => {
  const input = { zone: "UTC", windows: workday, timeOff: [], busy: [], bookings: [], settings: base, now: T("2026-01-01T00:00:00Z") };
  assert.deepEqual(iso(slots({ ...input, from: T("2026-03-09T10:00:00Z"), to: T("2026-03-09T12:00:00Z") })), [
    "2026-03-09T10:00:00.000Z", "2026-03-09T11:00:00.000Z",
  ]);
});

test("a window that crosses midnight gives nothing; 24:00 ends at midnight", () => {
  assert.deepEqual(run("UTC", "2026-03-09", [{ weekday: 1, start: "22:00", end: "02:00" }]), []);
  assert.deepEqual(iso(run("UTC", "2026-03-09", [{ weekday: 1, start: "23:00", end: "24:00" }])), ["2026-03-09T23:00:00.000Z"]);
});

test("bad settings and unknown zones are refused, not guessed", () => {
  assert.throws(() => run("UTC", "2026-03-09", workday, { durationMin: 0 }), /duration_min/);
  assert.throws(() => run("UTC", "2026-03-09", workday, { intervalMin: 7.5 }), /interval_min/);
  assert.throws(() => slots({ zone: "Mars/Base", windows: workday, timeOff: [], busy: [], bookings: [], settings: base, now: T("2026-01-01T00:00:00Z"), from: T("2026-03-09T00:00:00Z"), to: T("2026-03-10T00:00:00Z") }), /time zone/);
});

// ---- the process zone never matters --------------------------------------------------

test("the source never reads the process time zone", () => {
  const src = readFileSync(join(here, "..", "slots.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const banned of [/\.get(FullYear|Month|Date|Day|Hours|Minutes|Seconds)\(/, /\.set(FullYear|Month|Date|Hours|Minutes)\(/, /getTimezoneOffset/, /toLocale\w*String\(\)/, /new Date\(\d{4},/]) {
    assert.doesNotMatch(src, banned);
  }
});

test("the same input gives the same instants under any process TZ", () => {
  const outs = ["UTC", "Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kathmandu"].map((tz) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "tz-fixture.ts")], {
      cwd: join(here, "..", ".."), env: { ...process.env, TZ: tz }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  for (const o of outs) assert.equal(o, outs[0]);
  const parsed = JSON.parse(outs[0]) as { zone: string; n: number; starts: string }[];
  // New York over both changes: spring forward loses the 02:00 and 02:30 starts, fall back offers 01:xx once.
  const ny = parsed.find((p) => p.zone === "America/New_York")!.starts.split(",");
  assert.ok(ny.includes("2026-03-08T06:30:00.000Z") && !ny.some((s) => s.startsWith("2026-11-01T06:")));
});

// ---- showing a slot to a viewer --------------------------------------------------------

test("a slot is shown in the viewer's zone, with the zone named", () => {
  const slot = { start: T("2026-03-09T13:30:00Z"), end: T("2026-03-09T14:30:00Z") };
  assert.equal(formatSlot(slot, "Asia/Kolkata"), "Monday, March 9, 7:00 PM to 8:00 PM GMT+5:30");
  assert.equal(formatSlot(slot, "America/Los_Angeles"), "Monday, March 9, 6:30 AM to 7:30 AM PDT");
  assert.equal(formatSlot(slot, "UTC"), "Monday, March 9, 1:30 PM to 2:30 PM UTC");
  const late = { start: T("2026-03-10T02:00:00Z"), end: T("2026-03-10T03:00:00Z") };
  assert.equal(formatSlot(late, "America/New_York"), "Monday, March 9, 10:00 PM to 11:00 PM EDT");
  assert.equal(formatSlot(late, "Asia/Kolkata"), "Tuesday, March 10, 7:30 AM to 8:30 AM GMT+5:30");
  assert.equal(formatTime(late.start, "Europe/London"), "2:00 AM");
  assert.deepEqual([...byLocalDate([slot, late], "America/New_York").keys()], ["2026-03-09"]);
  assert.deepEqual([...byLocalDate([slot, late], "Asia/Kolkata").keys()], ["2026-03-09", "2026-03-10"]);
});
