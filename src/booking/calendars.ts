// The calendar accounts this app holds and what each can see. Edge-safe (no
// Node APIs), so the Team page imports it as well as the sync job; its calls
// reach the vendor only where the gateway is, on the app's machine
// (data/gateway.ts). Each person connects their own Google or Microsoft in
// Task & Tool, and the app holds each under its own slug: `google-calendar`,
// then `google-calendar-7c2e1a` for a second person's.
import { q, type Db } from "../data/db";
import type { GrantedConnection } from "../data/gateway";

/**
 * Calls a vendor path through the gateway:
 * `(slug, path, init) => gatewayFetch(env, slug, path, init)`. Its
 * 60-second timeout keeps a hung call well inside the sync job's 10-minute
 * push claim, or the next run would re-claim a booking and write its event twice.
 */
export type Gateway = (slug: string, path: string, init?: RequestInit) => Promise<Response>;

/** The JSON body, or an Error saying who refused: Task & Tool (x-tasktool-refusal) or the vendor. */
export async function call(gw: Gateway, slug: string, path: string, init?: RequestInit, okStatuses: number[] = []): Promise<any> {
  const res = await gw(slug, path, init);
  const refusal = res.headers.get("x-tasktool-refusal");
  if (refusal) throw new Error(`Task & Tool refused the ${slug} call: ${refusal}${refusal === "needs_reconnect" ? " (the owner must reconnect it)" : ""}`);
  if (okStatuses.includes(res.status)) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${slug} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** A query string with %20 for spaces: Graph's $filter and $expand want it, not "+". */
export const query = (params: Record<string, string>) =>
  Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

const GRAPH = "https://graph.microsoft.com";

/** The gateway path of a Graph page's @odata.nextLink, or null on the last page. */
export function graphNext(body: any): string | null {
  const next: unknown = body?.["@odata.nextLink"];
  if (typeof next !== "string") return null;
  if (!next.startsWith(GRAPH + "/")) throw new Error("Microsoft nextLink points off graph.microsoft.com");
  return next.slice(GRAPH.length);
}

/** A calendar connection this app holds, as linkAccounts last recorded it. */
type CalendarAccount = { connection: string; provider: "google" | "microsoft"; account: string | null };

/**
 * Record the calendar connections this app holds (`held`, list-connections)
 * and give each one seen for the first time to the active person whose email
 * it is, as their main calendar: everyone who connects is synced without
 * anyone adding them. Only the first time, so a calendar someone removed
 * stays removed. Returns how many were given.
 */
export async function linkAccounts(db: Db, held: GrantedConnection[]): Promise<number> {
  const accounts = held.filter((c) => c.service === "calendar" && (c.provider === "google" || c.provider === "microsoft"));
  const [, linked] = await db.transaction([
    q`delete from calendar_accounts where not (connection = any(${accounts.map((a) => a.slug)}::text[]))`,
    q`with fresh as (
        insert into calendar_accounts (connection, provider, account)
        select * from unnest(${accounts.map((a) => a.slug)}::text[], ${accounts.map((a) => a.provider)}::text[], ${accounts.map((a) => a.account)}::text[])
        on conflict (connection) do nothing
        returning connection, provider, account)
      insert into calendars (resource_id, provider, connection)
      select r.id, f.provider, f.connection from fresh f join resources r on r.email = f.account::citext and r.active
      on conflict do nothing
      returning id`,
  ]);
  return linked.length;
}

/** One way to reach a calendar: through which account, under which id, and whether bookings can be written to it. */
type CalendarOption = { connection: string; account: string | null; externalId: string; canEdit: boolean };
/** A calendar some held account can read, with every account that reaches it, the ones that can add bookings first. */
export type FoundCalendar = { name: string; options: CalendarOption[] };
/** What Show available calendars turns up: the calendars, and each account that could not be asked. */
export type CalendarSearch = { calendars: FoundCalendar[]; errors: string[] };

/** What one account sees: a calendar's key (the same calendar seen by two accounts shares it), name and option. */
type Seen = { key: string; name: string; option: CalendarOption };

/**
 * Google calendarList, readers and up (free/busy alone is not enough: the
 * sync reads events). The account's own main calendar is `primary`, the id
 * the sync and linkAccounts use, and is keyed by the account's email so it
 * meets the same calendar seen through a teammate's account.
 */
async function googleCalendars(gw: Gateway, a: CalendarAccount): Promise<Seen[]> {
  const out: Seen[] = [];
  let pageToken = "";
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error("Google calendarList: more than 20 pages");
    const body = await call(gw, a.connection, `/calendar/v3/users/me/calendarList?${query({
      minAccessRole: "reader", fields: "items(id,summary,summaryOverride,accessRole,primary),nextPageToken", ...(pageToken ? { pageToken } : {}),
    })}`);
    for (const c of body?.items ?? []) {
      const option = { connection: a.connection, account: a.account, externalId: c.primary ? "primary" : String(c.id), canEdit: c.accessRole === "owner" || c.accessRole === "writer" };
      out.push({ key: c.primary ? (a.account ?? String(c.id)) : String(c.id), name: c.summaryOverride ?? c.summary ?? String(c.id), option });
    }
    if (typeof body?.nextPageToken !== "string") return out;
    pageToken = body.nextPageToken;
  }
}

/** Microsoft's calendars: the account's own (its default is `primary`) and those shared with it. */
async function microsoftCalendars(gw: Gateway, a: CalendarAccount): Promise<Seen[]> {
  const out: Seen[] = [];
  let path: string | null = `/v1.0/me/calendars?${query({ $select: "id,name,canEdit,owner,isDefaultCalendar", $top: "100" })}`;
  for (let page = 0; path; page++) {
    if (page >= 20) throw new Error("Microsoft calendars: more than 20 pages");
    const body = await call(gw, a.connection, path);
    for (const c of body?.value ?? []) {
      const owner: string | undefined = c.owner?.address;
      const theirs = owner && owner.toLowerCase() !== a.account?.toLowerCase() ? `${owner}: ` : "";
      const option = { connection: a.connection, account: a.account, externalId: c.isDefaultCalendar ? "primary" : String(c.id), canEdit: c.canEdit === true };
      out.push({ key: c.isDefaultCalendar ? (a.account ?? String(c.id)) : String(c.id), name: `${theirs}${c.name ?? c.id}`, option });
    }
    path = graphNext(body);
  }
  return out;
}

/**
 * Every calendar the held accounts (calendar_accounts) can read, one entry per
 * calendar with each account that reaches it. An account whose list fails is
 * named in `errors` and the others still answer.
 */
export async function findCalendars(db: Db, gw: Gateway): Promise<CalendarSearch> {
  const accounts = (await db.sql`select connection, provider, account from calendar_accounts order by account, connection`) as CalendarAccount[];
  const found = new Map<string, FoundCalendar>();
  const errors: string[] = [];
  for (const a of accounts) {
    try {
      for (const s of await (a.provider === "google" ? googleCalendars(gw, a) : microsoftCalendars(gw, a))) {
        if (!found.has(s.key)) found.set(s.key, { name: s.name, options: [] });
        found.get(s.key)!.options.push(s.option);
      }
    } catch (e) {
      errors.push(`${a.account ?? a.connection}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  const calendars = [...found.values()].map((f) => ({ ...f, options: f.options.sort((x, y) => Number(y.canEdit) - Number(x.canEdit)) }));
  return { calendars: calendars.sort((x, y) => x.name.localeCompare(y.name)), errors };
}
