// The small pieces every private list route needs and gets quietly wrong:
// a search box that treats % and _ as text, list URLs that keep the filter,
// a return path that cannot leave the app, htmx partials that survive a
// history restore, and selected ids from a bulk form.
import type { Context } from "hono";

/**
 * An `ilike` pattern for a search box, or null for no search. `%`, `_` and
 * `\` are escaped, so "50%" finds "50%" and not "50 anything". A `gin
 * (col gin_trgm_ops)` index serves `col ilike pattern` at any table size.
 */
export function likePattern(q: string | null | undefined): string | null {
  const s = (q ?? "").trim().slice(0, 100);
  return s ? "%" + s.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%" : null;
}

/** `base?a=1&b=2`, leaving out empty values, so a list link carries its filter. */
export function listUrl(base: string, params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

/** A `return` field, accepted only as a path under `base` ("//evil" is not a path). */
export function localPath(p: string, base: string, fallback: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return fallback;
  // Judge the path the browser will follow: dot segments resolved
  // ("/admin/..//evil.example" is "//evil.example"), the query kept.
  let resolved: string;
  try {
    const u = new URL(p, "http://x");
    resolved = u.pathname + u.search;
  } catch {
    return fallback;
  }
  const ok =
    !resolved.startsWith("//") &&
    (resolved === base || resolved.startsWith(base + "/") || resolved.startsWith(base + "?"));
  return ok ? resolved : fallback;
}

/**
 * True when htmx wants a fragment. A history restore (back after a pushed
 * URL whose snapshot is gone) is also an htmx request but needs the whole
 * page, so it does not count.
 */
export function isPartial(c: Context): boolean {
  return c.req.header("hx-request") === "true" && c.req.header("hx-history-restore-request") !== "true";
}

/**
 * The ids a bulk form posted (`name="id"`, one per checked box), from
 * `await c.req.parseBody({ all: true })`. Digits only, deduplicated, capped.
 */
export function formIds(value: unknown, max = 500): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const ids = list.filter((v): v is string => typeof v === "string" && /^\d{1,18}$/.test(v));
  return [...new Set(ids)].slice(0, max);
}

/** A route's `:id`, or null when it is not a bigint-sized number. */
export function idParam(v: string | undefined): string | null {
  return v && /^\d{1,18}$/.test(v) ? v : null;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
