// Where a submission came from, so a report can say which ad brought it.
//
// A page that holds a form reads its own query string and the Referer of the
// visit, and carries them in two hidden fields. The POST checks them again
// (they are the visitor's to change) and stores them on the submission:
//
//   data._utm       { source, medium, campaign, term, content, and any other utm_ field }, the last visit
//   data._click     { fbclid, gclid, msclkid, ttclid }, the ad platforms' click ids
//   data._referrer  a host, never a whole URL
//   data._landing   the page that visit arrived on
//   data._first     { utm, click, page }, the first visit, when it differs
//
// A visitor often arrives on one page and fills in a form on another, and a
// pre-rendered page never reaches the app's code. ORIGIN_SCRIPT, inline in the
// site's layout, keeps the first and last tagged visit in a first-party cookie
// for 30 days, and the POST reads that when its own page had none. An untagged
// visit keeps only the page it arrived on, until the browser closes.
//
// Only short values are kept: never a whole referrer URL, whose path and query
// can hold someone's search or a token, and never an email address. Edge-safe.
import type { Context } from "hono";

export const UTM_FIELD = "_utm";
export const REFERRER_FIELD = "_ref";
const TOUCH_COOKIE = "tt_touch";
const LANDING_COOKIE = "tt_land";
export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export const CLICK_KEYS = ["fbclid", "gclid", "msclkid", "ttclid"] as const;

export type Utm = Partial<Record<string, string>>;
export type Click = Partial<Record<(typeof CLICK_KEYS)[number], string>>;
export type Touch = { utm?: Utm; click?: Click; page?: string };
export type Origin = { _utm?: Utm; _click?: Click; _referrer?: string; _landing?: string; _first?: Touch };

const MAX_VALUE = 120;
/** A visitor can put anything in a link, so the other utm_ fields are bounded: how many, and how they are named. */
const MAX_OTHER_UTMS = 10;
const OTHER_UTM = /^utm_([a-z0-9][a-z0-9_]{0,39})$/;
const PAGE = /^\/[^\s<>"'`@]{0,199}$/;
const SAFE = /[^\p{L}\p{N}._+|:()/#%,=~!-]+/gu;

/**
 * A UTM value as reports group it: lowercase, spaces as hyphens, at most 120
 * characters. Meta's ad names carry `|`, `:` and `(`, which stay. Anything that
 * could be markup or an address is refused, an apostrophe is dropped ("Bob's Roof" is a fine ad name), and
 * other odd characters become hyphens.
 */
export function token(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/[<>"`@\u0000-\u001f]/.test(v)) return null;
  const s = v.replace(/'/g, "").trim().toLowerCase().replace(/\s+/g, "-").replace(SAFE, "-").slice(0, MAX_VALUE);
  return /[\p{L}\p{N}]/u.test(s) ? s : null;
}

/** An ad platform's click id: long, case-sensitive and opaque. */
const clickId = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9._-]{1,300}$/.test(v) ? v : null);

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

/** The utm_ fields beyond the five every report reads, checked, by name without the prefix, in one order. */
function otherUtms(p: URLSearchParams): [string, string][] {
  const out = new Map<string, string>();
  for (const [k, v] of p) {
    const name = OTHER_UTM.exec(k.toLowerCase())?.[1];
    const t = name && !(UTM_KEYS as readonly string[]).includes(name) ? token(v) : null;
    if (name && t && !out.has(name)) out.set(name, t);
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, MAX_OTHER_UTMS);
}

/** The two hidden fields' values for a form on the page this request is for. */
export function originFields(c: Context): { utm: string; ref: string } {
  const u = new URL(c.req.url);
  const out = new URLSearchParams();
  for (const k of UTM_KEYS) {
    const t = token(u.searchParams.get(`utm_${k}`));
    if (t) out.set(k, t);
  }
  for (const [k, t] of otherUtms(u.searchParams)) out.set(`utm_${k}`, t);
  for (const k of CLICK_KEYS) {
    const t = clickId(u.searchParams.get(k));
    if (t) out.set(k, t);
  }
  const own = c.req.header("x-forwarded-host") || c.req.header("host") || u.host;
  return { utm: out.toString(), ref: referrerHost(c.req.header("referer"), own) ?? "" };
}

/** A touch from name=value pairs (`source=` or `utm_source=`), every value checked. Null when it holds nothing. */
function touchFrom(p: URLSearchParams): Touch | null {
  const utm: Utm = {};
  for (const k of UTM_KEYS) {
    const t = token(p.get(k) ?? p.get(`utm_${k}`));
    if (t) utm[k] = t;
  }
  for (const [k, t] of otherUtms(p)) utm[k] = t;
  const click: Click = {};
  for (const k of CLICK_KEYS) {
    const t = clickId(p.get(k));
    if (t) click[k] = t;
  }
  const hasUtm = Object.keys(utm).length > 0;
  const hasClick = Object.keys(click).length > 0;
  if (!hasUtm && !hasClick) return null;
  const page = p.get("page");
  return { ...(hasUtm ? { utm } : {}), ...(hasClick ? { click } : {}), ...(page && PAGE.test(page) ? { page } : {}) };
}

/** The first and last tagged visits the cookie holds, or null. */
function readTouches(cookieHeader: unknown): { first: Touch | null; last: Touch | null } | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return null;
  const m = new RegExp(`(?:^|;\\s*)${TOUCH_COOKIE}=([^;]*)`).exec(cookieHeader);
  if (!m) return null;
  try {
    const both = new URLSearchParams(decodeURIComponent(m[1]));
    const of = (name: string) => {
      const v = both.get(name);
      return v ? touchFrom(new URLSearchParams(v)) : null;
    };
    return { first: of("first"), last: of("last") };
  } catch {
    return null;
  }
}

/** The page an untagged visit arrived on, from its cookie. */
function landedOn(cookieHeader: unknown): string | undefined {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return undefined;
  const m = new RegExp(`(?:^|;\\s*)${LANDING_COOKIE}=([^;]*)`).exec(cookieHeader);
  if (!m) return undefined;
  try {
    const page = decodeURIComponent(m[1]);
    return PAGE.test(page) ? page : undefined;
  } catch {
    return undefined;
  }
}

const sameTouch = (a: Touch, b: Touch) => JSON.stringify([a.utm, a.click]) === JSON.stringify([b.utm, b.click]);

/**
 * What a POST's hidden fields and the visitor's cookie say, checked again, as
 * the keys to add to `data`. The page's own tags win over the cookie's.
 */
export function readOrigin(utmField: unknown, refField: unknown, cookieHeader?: unknown, page?: unknown): Origin {
  const out: Origin = {};
  const here = typeof utmField === "string" && utmField.length <= 1500 ? touchFrom(new URLSearchParams(utmField)) : null;
  const touches = readTouches(cookieHeader);
  const last = here ?? touches?.last ?? null;
  if (last?.utm) out._utm = last.utm;
  if (last?.click) out._click = last.click;
  // Landing on the form's own page: its tags are the cookie's, and only the cookie has the page.
  const landing = last?.page ?? (here && touches?.last && sameTouch(here, touches.last) ? touches.last.page : undefined);
  // An untagged visit: the page it arrived on, or with no cookie, the page the form was on.
  const arrived = landing ?? landedOn(cookieHeader) ?? (typeof page === "string" && PAGE.test(page) && !/\/forms\//.test(page) ? page : undefined);
  if (arrived) out._landing = arrived;
  const first = touches?.first;
  if (first && (!last || !sameTouch(first, last))) out._first = first;
  // The field holds a host already; it is checked as one (a URL around it is refused).
  const host = typeof refField === "string" && !refField.includes("/") ? referrerHost(`https://${refField}`, "") : null;
  if (host) out._referrer = host;
  return out;
}

/**
 * The layout's inline script: a visit tagged with a UTM or a click id goes in
 * the cookie as the last touch, and as the first when there is none yet. An
 * untagged visit keeps its first page until the browser closes. Other utm_ fields
 * come after the known ones, while the cookie has room. Works with no framework; a failure is silent,
 * since the form's own fields still say where this page's visit came from.
 */
export const ORIGIN_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search),o=new URLSearchParams(),secure=location.protocol==="https:"?"; Secure":"";${JSON.stringify([...UTM_KEYS.map((k) => `utm_${k}`), ...CLICK_KEYS])}.forEach(function(k){var v=q.get(k);if(v)o.set(k,v.slice(0,300))});q.forEach(function(v,k){if(k.indexOf("utm_")===0&&v&&!o.has(k)&&o.toString().length<800)o.set(k,v.slice(0,120))});if(!o.toString()){if(document.cookie.indexOf("${LANDING_COOKIE}=")<0&&document.cookie.indexOf("${TOUCH_COOKIE}=")<0)document.cookie="${LANDING_COOKIE}="+encodeURIComponent(location.pathname.slice(0,200))+"; Path=/; SameSite=Lax"+secure;return}o.set("page",location.pathname.slice(0,200));var m=document.cookie.match(/(?:^|; )${TOUCH_COOKIE}=([^;]*)/),c=m?new URLSearchParams(decodeURIComponent(m[1])):null,n=new URLSearchParams();n.set("first",c&&c.get("first")||o.toString());n.set("last",o.toString());document.cookie="${TOUCH_COOKIE}="+encodeURIComponent(n.toString())+"; Path=/; Max-Age=2592000; SameSite=Lax"+secure}catch(e){}})();`;

/** A stored tag as a person reads it: "roof-|-4:5" is "roof | 4:5". */
export const tagWords = (tag: string) => tag.replace(/[-_]/g, " ");

/** Where a submission came from, each UTM under its own name, others after the five: for the team's views, null where unknown. */
export function sourceRows(data: Record<string, unknown> | null | undefined, termLabel = "Keyword"): { label: string; value: string | null }[] {
  const utm = (data?._utm ?? {}) as Utm;
  const word = (v?: string) => (v ? tagWords(v) : null);
  return [
    { label: "Landing page", value: typeof data?._landing === "string" ? data._landing : null },
    { label: "Source", value: word(utm.source) ?? (typeof data?._referrer === "string" ? data._referrer : null) },
    { label: "Medium", value: word(utm.medium) },
    { label: "Campaign", value: word(utm.campaign) },
    { label: termLabel, value: word(utm.term) },
    { label: "Ad", value: word(utm.content) },
    ...Object.keys(utm).filter((k) => !(UTM_KEYS as readonly string[]).includes(k)).map((k) => ({ label: tagWords(k), value: word(utm[k]) })),
  ];
}

/** "google (cpc, spring sale)", "news.example", or null: for the team's views and the owner's email. */
export function cameFrom(data: Record<string, unknown> | null | undefined): string | null {
  const utm = (data?._utm ?? null) as Utm | null;
  const ref = typeof data?._referrer === "string" ? data._referrer : null;
  if (utm?.source) {
    const more = [utm.medium, utm.campaign].filter((v): v is string => !!v).map(tagWords);
    return more.length ? `${tagWords(utm.source)} (${more.join(", ")})` : tagWords(utm.source);
  }
  return ref;
}

/** The keys `data` holds about where they came from: never answers, never shown as answers. */
export const ORIGIN_KEYS = ["_utm", "_click", "_referrer", "_landing", "_first"] as const;
