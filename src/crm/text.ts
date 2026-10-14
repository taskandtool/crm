// Small input helpers shared by the routes and the scripts.
import { amountInput } from "../invoices/lines";
import { decimals, toMinor } from "../payments/money";

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

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A wall time said the way the owner says it, resolved in `tz`: "today 9:30",
 * "tomorrow 2pm", "friday 14:00", "next friday 9:30". A weekday, with or
 * without "next", is the coming one, never today. Null for anything else.
 */
export function relativeWall(v: unknown, tz: string, now = new Date()): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().toLowerCase().match(/^(today|tomorrow|(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday))(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = +m[3];
  const minute = m[4] ? +m[4] : 0;
  if (m[5]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[5] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const today = nowIn(tz, now).slice(0, 10);
  const [y, mo, d] = today.split("-").map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d));
  const ahead = m[1] === "today" ? 0 : m[1] === "tomorrow" ? 1 : ((DAYS.indexOf(m[2]) - base.getUTCDay() + 7) % 7) || 7;
  base.setUTCDate(base.getUTCDate() + ahead);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())} ${pad(hour)}:${pad(minute)}:00`;
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

/** A total at a glance, to the whole unit: "$14,500" on a board column or a card. */
export function formatWholeMoney(cents: number | string, currency: string, locale = "en-US"): string {
  const whole = Number(cents) / 10 ** decimals(currency);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(whole);
  } catch {
    return `${Math.round(whole)} ${currency.toUpperCase()}`;
  }
}

/**
 * "1,245.50" or "$90" as minor units of `currency`, read as the skills read a
 * price (payments' toMinor): null for an empty box, "invalid" for anything
 * else that is not an amount ("12,50", a decimal comma, among them).
 */
export function parseAmount(v: unknown, currency: string): number | null | "invalid" {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/^\p{Sc}\s*/u, "") : "";
  return s ? (toMinor(s, currency) ?? "invalid") : null;
}

/** Minor units as a plain amount for an input or a CSV cell: 124550 USD is "1245.50". */
export function amountText(cents: string | number | null, currency: string): string {
  return cents === null || cents === "" ? "" : amountInput(cents, currency);
}
