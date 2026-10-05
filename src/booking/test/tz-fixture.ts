// Run by slots.test.ts in a child process with a different TZ: prints the
// slots for a fixed input, which must not depend on the process zone.
import { slots, formatSlot } from "../slots";

const out = ["America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata"].map((zone) => {
  const list = slots({
    zone,
    windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:30", end: "04:00" })),
    timeOff: [],
    busy: [],
    bookings: [],
    settings: { durationMin: 30, intervalMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 730 },
    now: new Date("2026-01-01T00:00:00Z"),
    from: new Date("2026-03-07T00:00:00Z"),
    to: new Date("2026-11-03T00:00:00Z"),
  });
  return { zone, n: list.length, starts: list.map((s) => s.start.toISOString()).join(","), shown: formatSlot(list[0], "Asia/Tokyo") };
});
process.stdout.write(JSON.stringify(out));
