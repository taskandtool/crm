// The slot calculator. Pure: no database, no clock, no process time zone.
// It never reads the machine's zone (no getHours, getDay, setHours,
// getTimezoneOffset, or toLocale* without a timeZone): every wall time goes
// through Intl.DateTimeFormat with an explicit IANA zone, so the same input
// gives the same instants on a laptop, a machine in UTC, and a Worker.
//
//   const open = slots({ zone: "America/New_York", windows, timeOff, busy, bookings, settings, now, from, to });
//   // [{ start: Date, end: Date }, ...] sorted, as instants
//
// Words used here: an instant is a Date. A local date is "YYYY-MM-DD" in a
// zone. A wall time is minutes after local midnight (0 to 1440).
//
// The rules it keeps (tests in test/slots.test.ts):
// - Slots start at wall times: window start, then every interval_min, on
//   each local calendar day of the zone. Days are walked as dates, never by
//   adding 24 hours to an instant.
// - A slot whose start wall time does not exist (the clock skips it when
//   daylight saving starts) is not offered.
// - A start wall time that happens twice (the clock repeats it when daylight
//   saving ends) takes the earlier instant, the one before the change. The
//   second pass through the repeated hour offers nothing.
// - A slot lasts duration_min of real time and must end by the window's end
//   instant. A window end that does not exist moves forward past the gap.
// - Buffers: [start - before, end + after] must be clear of busy times and
//   time off, and clear of every confirmed booking padded the same way, so
//   two bookings are always at least after + before apart.
// - Minimum notice: start >= now + min_notice_min.
// - Horizon: the slot's local date is at most horizon_days after today's
//   local date in the zone (0 means today only).
// - A window that crosses midnight is not supported: store it as two rows,
//   one ending 24:00 and one starting 00:00 the next weekday.

export type Interval = { start: Date; end: Date };
export type Slot = Interval;

/** Weekly hours: weekday 0 is Sunday; start and end are "HH:MM" or "HH:MM:SS" wall times, end may be "24:00". */
export type Window = { weekday: number; start: string; end: string };

export type Settings = {
  durationMin: number;
  intervalMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  horizonDays: number;
};

export type SlotInput = {
  zone: string;
  windows: Window[];
  timeOff: Interval[];
  busy: Interval[];
  /** Confirmed bookings of this resource (raw times; buffers are applied here). */
  bookings: Interval[];
  settings: Settings;
  now: Date;
  /** Offer slots starting at or after `from` and before `to`. */
  from: Date;
  to: Date;
};

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_DAYS = 800;

// ---- the zone arithmetic ---------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** True when `zone` is an IANA zone this runtime knows. */
export function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number };

/** The wall clock in `zone` at instant `t` (ms). */
export function wallClock(t: number, zone: string): Wall {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(t))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second };
}

/** The zone's offset from UTC at instant `t`, in ms (New York in summer: -4h). */
export function offsetAt(t: number, zone: string): number {
  const w = wallClock(t, zone);
  const whole = t - (((t % 1000) + 1000) % 1000);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - whole;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`not a date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The local date in `zone` at instant `t`. */
export function localDate(t: Date | number, zone: string): string {
  const w = wallClock(typeof t === "number" ? t : t.getTime(), zone);
  return `${String(w.y).padStart(4, "0")}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Calendar arithmetic on a local date (no instants involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  return isoDate(Date.UTC(y, m - 1, d + n));
}

/** 0 Sunday to 6 Saturday, for a local date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Every instant at which `zone` shows `date` + `minutes` on the wall clock,
 * earliest first: none in a skipped gap, two in a repeated hour.
 */
export function instantsFor(date: string, minutes: number, zone: string): number[] {
  const [y, m, d] = parseDate(date);
  const guess = Date.UTC(y, m - 1, d, 0, minutes); // the wall time read as if it were UTC
  const offsets = new Set([offsetAt(guess - DAY, zone), offsetAt(guess, zone), offsetAt(guess + DAY, zone)]);
  const hits = new Set<number>();
  for (const o of offsets) {
    const t = guess - o;
    if (t + offsetAt(t, zone) === guess) hits.add(t);
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * A wall time as an instant. Repeated: the earlier one. Skipped: null with
 * "strict"; with "forward", the instant the wall time would have had before
 * the change, which lands just as far past the gap (02:30 on a spring-forward
 * night in New York becomes 03:30).
 */
export function wallToInstant(date: string, minutes: number, zone: string, gap: "strict" | "forward" = "strict"): Date | null {
  const hits = instantsFor(date, minutes, zone);
  if (hits.length) return new Date(hits[0]);
  if (gap === "strict") return null;
  const [y, m, d] = parseDate(date);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const before = Math.min(offsetAt(guess - DAY, zone), offsetAt(guess, zone), offsetAt(guess + DAY, zone));
  return new Date(guess - before);
}

/** The instants a local date covers: [its first instant, the next date's first instant). */
export function dayBounds(date: string, zone: string): Interval {
  return { start: wallToInstant(date, 0, zone, "forward")!, end: wallToInstant(addDays(date, 1), 0, zone, "forward")! };
}

/** "09:30", "09:30:00" or "24:00" as minutes after midnight; NaN when it is none of those. */
export function parseWallTime(s: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return NaN;
  const h = Number(m[1]), mi = Number(m[2]), sec = Number(m[3] ?? 0);
  if (mi > 59 || sec !== 0) return NaN;
  if (h === 24 && mi === 0) return 1440;
  return h < 24 ? h * 60 + mi : NaN;
}

// ---- intervals ---------------------------------------------------------------

/** Sorted, with overlapping and touching intervals joined. Input is not changed. */
export function mergeIntervals(list: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Whether [start, end) overlaps any of the merged, sorted `blocks`. */
function overlapsAny(blocks: { start: number; end: number }[], start: number, end: number): boolean {
  let lo = 0, hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo < blocks.length && blocks[lo].start < end;
}

// ---- the calculator --------------------------------------------------------

export function checkSettings(s: Settings): string[] {
  const bad: string[] = [];
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(s.durationMin, 5, 1440)) bad.push("duration_min must be 5 to 1440 minutes");
  if (!int(s.intervalMin, 5, 1440)) bad.push("interval_min must be 5 to 1440 minutes");
  if (!int(s.bufferBeforeMin, 0, 1440)) bad.push("buffer_before_min must be 0 to 1440 minutes");
  if (!int(s.bufferAfterMin, 0, 1440)) bad.push("buffer_after_min must be 0 to 1440 minutes");
  if (!int(s.minNoticeMin, 0, 525600)) bad.push("min_notice_min must be 0 to 525600 minutes");
  if (!int(s.horizonDays, 0, 730)) bad.push("horizon_days must be 0 to 730");
  return bad;
}

/** The open slots in [from, to), as instants, sorted by start. */
export function slots(input: SlotInput): Slot[] {
  const { zone, settings: st } = input;
  const bad = checkSettings(st);
  if (bad.length) throw new Error(bad.join("; "));
  if (!isValidZone(zone)) throw new Error(`unknown time zone: ${zone}`);

  const before = st.bufferBeforeMin * MINUTE;
  const after = st.bufferAfterMin * MINUTE;
  const duration = st.durationMin * MINUTE;
  const earliest = Math.max(input.from.getTime(), input.now.getTime() + st.minNoticeMin * MINUTE);
  const to = input.to.getTime();
  if (!(earliest < to)) return [];

  // A booking is padded like a candidate, so the padded candidate is tested
  // against [b.start - before, b.end + after]: the gap is at least after + before.
  const blocks = mergeIntervals([
    ...input.busy.map((i) => ({ start: i.start.getTime(), end: i.end.getTime() })),
    ...input.timeOff.map((i) => ({ start: i.start.getTime(), end: i.end.getTime() })),
    ...input.bookings.map((i) => ({ start: i.start.getTime() - before, end: i.end.getTime() + after })),
  ]);

  const byDay = new Map<number, { start: number; end: number }[]>();
  for (const w of input.windows) {
    const start = parseWallTime(w.start), end = parseWallTime(w.end);
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) continue;
    if (!(start < end)) continue; // also skips NaN: a window that crosses midnight is two rows
    byDay.set(w.weekday, [...(byDay.get(w.weekday) ?? []), { start, end }]);
  }

  const lastDate = addDays(localDate(input.now, zone), st.horizonDays);
  const firstDate = localDate(earliest, zone);
  const toDate = localDate(to - 1, zone);
  const endDate = toDate < lastDate ? toDate : lastDate;

  const found = new Map<number, Slot>();
  let date = firstDate;
  for (let n = 0; date <= endDate && n < MAX_DAYS; n++, date = addDays(date, 1)) {
    for (const win of byDay.get(weekdayOf(date)) ?? []) {
      const windowEnd = wallToInstant(date, win.end, zone, "forward")!.getTime();
      for (let m = win.start; m < win.end; m += st.intervalMin) {
        const s = wallToInstant(date, m, zone, "strict");
        if (!s) continue; // skipped by the clock: no slot
        const start = s.getTime();
        const end = start + duration;
        if (end > windowEnd || start < earliest || start >= to) continue;
        if (overlapsAny(blocks, start - before, end + after)) continue;
        found.set(start, { start: s, end: new Date(end) });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Whether a slot starting exactly at `start` is offered. What a booking re-checks before it is taken. */
export function isOffered(input: Omit<SlotInput, "from" | "to">, start: Date): Slot | null {
  const t = start.getTime();
  return slots({ ...input, from: new Date(t), to: new Date(t + 1) }).find((s) => s.start.getTime() === t) ?? null;
}

/** Slots grouped by their local date in `zone` (the viewer's), in order. */
export function byLocalDate<T extends Slot>(list: T[], zone: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of list) {
    const d = localDate(s.start, zone);
    out.set(d, [...(out.get(d) ?? []), s]);
  }
  return out;
}

// ---- showing a time to a person ---------------------------------------------

const shown = new Map<string, Intl.DateTimeFormat>();
function shownWith(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let f = shown.get(key);
  if (!f) shown.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}
// Newer ICU puts a narrow no-break space before AM/PM; plain spaces read the same and compare simply.
const spaces = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

/** "9:30 AM" in the viewer's zone. */
export function formatTime(t: Date, zone: string, locale = "en-US"): string {
  return spaces(shownWith(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(t));
}

/** "Tuesday, March 10" for a local date ("YYYY-MM-DD"); no zone arithmetic involved. */
export function formatDate(date: string, locale = "en-US"): string {
  const [y, m, d] = parseDate(date);
  return spaces(shownWith(locale, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d, 12))));
}

/** The zone's short name at that instant: "EDT", "GMT+5:30". */
export function zoneLabel(t: Date, zone: string, locale = "en-US"): string {
  const p = shownWith(locale, { timeZone: zone, timeZoneName: "short" }).formatToParts(t).find((x) => x.type === "timeZoneName");
  return p?.value ?? zone;
}

/** "Tuesday, March 10, 9:30 AM to 10:00 AM EDT": a slot for a viewer, in the viewer's zone, zone named. */
export function formatSlot(slot: Slot, zone: string, locale = "en-US"): string {
  const day = formatDate(localDate(slot.start, zone), locale);
  return `${day}, ${formatTime(slot.start, zone, locale)} to ${formatTime(slot.end, zone, locale)} ${zoneLabel(slot.start, zone, locale)}`;
}
