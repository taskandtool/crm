// Where a submission came from, so a report can say "Google ads" rather than
// "website". The page that holds the form reads its own query string
// (utm_source, utm_medium, utm_campaign) and the Referer of the visit, and
// carries them in two hidden fields; the POST checks them again (they are
// the visitor's to change) and stores them as `data._utm` and
// `data._referrer` on the submission.
//
// Only short tokens are kept: a campaign name, a host. Never a whole
// referrer URL: its path and query can hold someone's search, an email
// address or a token. A visit from this site itself is not a referrer.
// Edge-safe.
import type { Context } from "hono";

export const UTM_FIELD = "_utm";
export const REFERRER_FIELD = "_ref";
const UTM_KEYS = ["source", "medium", "campaign"] as const;

export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;
export type Origin = { _utm?: Utm; _referrer?: string };

/** A short lowercase token (letters, digits, . _ + -), spaces as hyphens, or null. */
export function token(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(s) ? s : null;
}

/** The host a referrer URL names, without "www.", or null for none, ours, or anything that is not a web address. */
export function referrerHost(referrer: unknown, ownHost: string): string | null {
  if (typeof referrer !== "string" || !referrer) return null;
  let host: string;
  try {
    const u = new URL(referrer);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const bare = (h: string) => h.replace(/^www\./, "").replace(/:\d+$/, "").toLowerCase();
  host = bare(host);
  if (host === bare(ownHost) || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) || host.length > 100) return null;
  return host;
}

/** The two hidden fields' values for a form on the page this request is for. */
export function originFields(c: Context): { utm: string; ref: string } {
  const u = new URL(c.req.url);
  const utm = new URLSearchParams();
  for (const k of UTM_KEYS) {
    const t = token(u.searchParams.get(`utm_${k}`));
    if (t) utm.set(k, t);
  }
  const own = c.req.header("x-forwarded-host") || c.req.header("host") || u.host;
  return { utm: utm.toString(), ref: referrerHost(c.req.header("referer"), own) ?? "" };
}

/** What a POST's hidden fields say, checked again, as the keys to add to `data`. */
export function readOrigin(utmField: unknown, refField: unknown): Origin {
  const out: Origin = {};
  if (typeof utmField === "string" && utmField.length <= 400) {
    const p = new URLSearchParams(utmField);
    const utm: Utm = {};
    for (const k of UTM_KEYS) {
      const t = token(p.get(k));
      if (t) utm[k] = t;
    }
    if (Object.keys(utm).length) out._utm = utm;
  }
  // The field holds a host already; it is checked as one (a URL around it is refused).
  const host = typeof refField === "string" && !refField.includes("/") ? referrerHost(`https://${refField}`, "") : null;
  if (host) out._referrer = host;
  return out;
}

/** "google (cpc, spring-sale)", "news.example", or null: for the team's views and the owner's email. */
export function cameFrom(data: Record<string, unknown> | null | undefined): string | null {
  const utm = (data?._utm ?? null) as Utm | null;
  const ref = typeof data?._referrer === "string" ? data._referrer : null;
  if (utm?.source) {
    const more = [utm.medium, utm.campaign].filter(Boolean);
    return more.length ? `${utm.source} (${more.join(", ")})` : utm.source;
  }
  return ref;
}
