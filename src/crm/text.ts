// Small input helpers shared by the routes and the scripts.

/** Trimmed text up to `max` characters, or null when empty. */
export function clean(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s || null;
}

/** Tags from "a, b; c" or a list: trimmed, deduplicated case-blind, at most 30. */
export function parseTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (typeof t !== "string") continue;
    const s = t.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.slice(0, 30);
}

/** A key from a label: "Estimate sent" is estimate-sent. */
export function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");
  return s || "stage";
}

/**
 * "2026-10-02T14:30" or "2026-10-02 14:30[:00]": a wall time, or null. Only
 * a real calendar time: "2026-02-30 10:00" or "25:00" is null here, not an
 * error from Postgres.
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

/** Now as a wall time in `tz`, for a datetime-local input's default. */
export function nowIn(tz: string, now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * The instant a wall time ("2026-10-02 00:00:00", from wallTime) names in
 * `tz`, as Postgres's `timestamp at time zone` would give it: the zone's
 * offset is read at the guess and again at the answer, so a day that starts
 * or ends a DST change lands on the right hour.
 */
export function wallToInstant(wall: string, tz: string): Date {
  const guess = Date.parse(wall.replace(" ", "T") + "Z");
  const offset = (ms: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

/** Money in minor units, in its currency's own decimals. */
export function money(cents: number | string, currency: string, locale = "en-US"): string {
  const code = currency.toUpperCase();
  try {
    const f = new Intl.NumberFormat(locale, { style: "currency", currency: code });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(Number(cents) / 10 ** digits);
  } catch {
    return `${(Number(cents) / 100).toFixed(2)} ${code}`;
  }
}
