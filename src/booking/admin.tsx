// The team's side of booking, private (teamOnly): the week's Schedule,
// booking for someone (a phone call), and a booking's reschedule and cancel,
// which come back to where the app shows it (the Website's submission, the
// CRM's event); typeRoutes, the services (what each is, its rules, who takes
// it); and peopleRoutes, the team (each person's details, weekly hours, time
// off and, where the app runs the sync, calendars). Built on admin/; every
// form works without JavaScript.
//
//   const sections = { schedule: "/admin/schedule", services: "/admin/services", team: "/admin/team" };
//   app.route("/admin/schedule", bookingAdmin(getDb, { base: "/admin/schedule", css, source: "website", sections }));
//   app.route("/admin/services", typeRoutes(getDb, { base: "/admin/services", css, source: "website", sections }));
//   app.route("/admin/team", peopleRoutes(getDb, { base: "/admin/team", css, source: "website", sections }));
//
// `getDb` makes the request's handle (data/db.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { GetDb } from "../data/db";
import { Section } from "../admin/detail";
import { alertClass, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { sectionPages, type Frame, type NavItem } from "../admin/layout";
import { When } from "../admin/list";
import { idParam, listUrl, str } from "../admin/query";
import { buttonClass, FieldError, fieldClass, inputClass, linkClass, pickStatus, primaryClass, Select, smallText, StatusBadge, type StatusOption } from "../admin/status";
import { book, bookableTypes, hostsOf, LOCATION_KINDS, rescheduleById, resourceById, setStatus, toBooking, typeById, whereText, type Booking, type BookingType, type Resource } from "./book";
import {
  addCalendar, addTimeOff, addWindow, allPeople, allTypes, calendars, createPerson, createType, LOCATION_LABELS, removeCalendar, removeTimeOff, removeWindow, savePerson, saveType, setHosts,
  timeOffList, typesHostedBy, weeklyHours, WEEKDAYS, type Errors, type HoursWindow, type PersonFields, type TypeFields,
} from "./hours";
import { decimals } from "../payments/money";
import { addDays, dayBounds, durationText, formatShortDate, formatSlot, formatTime, localDate, weekdayOf, zoneName } from "./slots";
import { chip, chipOn, DayAndTimes, upcoming } from "./public";
import { noticeFor, runOnBooked, type BookingNotice } from "./notify";
import { findCalendars, linkAccounts, type CalendarSearch } from "./calendars";
import { envOf } from "../data/env";
import { gatewayFetch, gatewayReachable, listConnections } from "../data/gateway";

export type BookingAdminOptions = {
  base: string;
  css: string;
  /** This app's slug, stored on the bookings, services and people the team makes. */
  source: string;
  nav?: NavItem[];
  /** The app's own page frame (the CRM's layout and nav) instead of AdminLayout. */
  Frame?: Frame;
  /** This app makes deals (the CRM): a service can make each online booking a deal straight away. */
  deals?: boolean;
  /** Where each section is mounted, so one links to another (a service's Book for someone, a person's services). */
  sections: { schedule: string; services: string; team: string };
  /** The business's zone: the Schedule shows times in it. Absent, the first person's. */
  timeZone?: string;
  /**
   * The public booking pages' address, absolute ("https://acme.com/book"), so
   * a booking the team makes gets a manage link the booker can use. Without
   * it the confirmation says to reply instead.
   */
  manageBase?: string;
  /** After the team books, reschedules or cancels: send the confirmation (notify.ts), file it. Never throws into the response. */
  onBooked?: (c: Context<{ Variables: TeamVars }>, e: BookingNotice) => void | Promise<void>;
  /**
   * Where a booking opens, and where its Reschedule and Cancel come back to:
   * the page the app shows it on (the Website: its submission; the CRM: its
   * event), with that page's name for the way back. Null, or absent, is the Schedule.
   */
  returnTo?: (b: { id: string; name: string; submission_id: string | null }) => { href: string; label: string } | null;
  /** After the team changes a booking's status: the CRM counts a completed one as contact. */
  afterStatus?: (c: Context<{ Variables: TeamVars }>, b: Booking) => void | Promise<void>;
  /** The Schedule's buttons, in place of Book for someone (the CRM's New event). */
  scheduleActions?: Child;
  /** false where the app does not run the calendar sync (the CRM does): each person's calendars are left out. Default true. */
  calendars?: boolean;
  /** The business's currency ("usd"): a service priced in it does not ask for one. */
  currency?: string;
};

type Team = Context<{ Variables: TeamVars }>;

export const BOOKING_STATUSES: StatusOption[] = [
  { value: "confirmed", label: "Scheduled", tone: "accent" },
  { value: "completed", label: "Completed", tone: "neutral" },
  { value: "no_show", label: "No-show", tone: "muted" },
  { value: "cancelled", label: "Cancelled", tone: "muted" },
];

/** What a booking's Book, Reschedule and status routes say on the page they come back to: the Schedule, or the app's own page for it. */
export const BOOKING_MESSAGES: FlashMessages = {
  booked: "Booked. They are sent a confirmation if email is on.",
  rescheduled: "Booking moved. They have been told the new time.",
  cancelled: "Booking cancelled. They have been told.",
  status: "Status saved.",
  unchanged: { error: "Nothing changed. A cancelled or past booking cannot be moved." },
};

const MESSAGES: FlashMessages = {
  ...BOOKING_MESSAGES,
  saved: "Saved.",
  hours: "Hours saved.",
  "time-off": "Time off saved.",
  hosts: "Who takes it saved.",
  created: "Added. Now set their weekly hours.",
  "type-created": "Added. Now choose who takes it.",
  calendar: "Calendar saved. The next sync, within 15 minutes, reads it.",
};

/** Minor units as the editor shows them: 12000 usd is "120.00". */
const amountText = (cents: number, currency: string) => (cents / 10 ** decimals(currency)).toFixed(decimals(currency));

type CalendarView = "day" | "week" | "month";

/** First of the month a day is in, and the first of the months around it. */
const monthOf = (day: string, step = 0) => {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + step, 1));
  return d.toISOString().slice(0, 10);
};

/**
 * What a calendar view shows around a day: its days, the whole weeks a month's
 * grid needs (Monday first), the day the arrows go to, and its heading.
 */
function calendarSpan(view: CalendarView, anchor: string): { days: string[]; grid: string[]; before: string; after: string; heading: string } {
  const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));
  if (view === "day") {
    return { days: [anchor], grid: [anchor], before: addDays(anchor, -1), after: addDays(anchor, 1), heading: formatShortDate(anchor) };
  }
  if (view === "week") {
    const monday = mondayOf(anchor);
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
    return { days, grid: days, before: addDays(monday, -7), after: addDays(monday, 7), heading: `Week of ${formatShortDate(monday, { long: true })}` };
  }
  const first = monthOf(anchor), next = monthOf(anchor, 1);
  const days: string[] = [];
  for (let d = first; d < next; d = addDays(d, 1)) days.push(d);
  const grid: string[] = [];
  for (let d = mondayOf(first); d < next || weekdayOf(d) !== 1; d = addDays(d, 1)) grid.push(d);
  const [y, m] = first.split("-").map(Number);
  const heading = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 1, 12)));
  return { days, grid, before: monthOf(anchor, -1), after: next, heading };
}

export function bookingAdmin(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "Schedule" }];
  const framed = sectionPages({ Frame: opts.Frame, css: opts.css, label: "Schedule", links, messages: MESSAGES });
  /** Where a booking opens and its actions come back to: the app's page for it, or the Schedule. */
  const homeOf = (raw: Record<string, unknown>) => {
    const b = { id: String(raw.id), name: String(raw.name ?? ""), submission_id: raw.submission_id == null ? null : String(raw.submission_id) };
    return opts.returnTo?.(b) ?? { href: base, label: "Schedule" };
  };
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  // ---- the calendar (day, week, month), and booking for someone ----------------------

  const zoneOf = async (c: Team) => opts.timeZone ?? (await allPeople(getDb(c)))[0]?.time_zone ?? "UTC";

  app.get("/", async (c) => {
    const d = getDb(c);
    const zone = await zoneOf(c);
    const people = await allPeople(d);
    const person = idParam(c.req.query("person"));
    // Day, Week (the default) or Month, as Jobber's, Salesforce's and HubSpot's calendars; `date` is any day in it.
    const view: CalendarView = (["day", "month"] as const).find((v) => v === c.req.query("view")) ?? "week";
    const asked = c.req.query("date") ?? "";
    const today = localDate(new Date(), zone);
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(asked) && !Number.isNaN(Date.parse(asked)) ? asked : today;
    const span = calendarSpan(view, anchor);
    const days = span.days;
    const from = dayBounds(span.grid[0], zone).start.toISOString();
    const to = dayBounds(span.grid[span.grid.length - 1], zone).end.toISOString();
    // A booking the team scheduled may have no service (its title says what) and nobody yet. One held
    // for a form still being paid is not the business's yet: its time is kept, but it is not here.
    const rows = await d.sql<{ id: string; submission_id: string | null; starts_at: Date; ends_at: Date; name: string; status: string; what: string | null; booked: boolean; host: string | null; resource_id: string | null; location_kind: Booking["location_kind"]; location: string | null }>`
      select b.id::text as id, b.submission_id::text as submission_id, b.starts_at, b.ends_at, b.name, b.status, coalesce(b.title, t.name) as what,
             t.id is not null as booked, r.name as host, b.resource_id::text as resource_id, b.location_kind, b.location
      from bookings b left join booking_types t on t.id = b.type_id left join resources r on r.id = b.resource_id
      where b.status <> 'cancelled' and b.hold_until is null and b.starts_at < ${to}::timestamptz and b.ends_at > ${from}::timestamptz
        and (${person}::bigint is null or b.resource_id = ${person}::bigint)
      order by b.starts_at, b.id`;
    const off = await d.sql<{ name: string; resource_id: string; starts_at: Date; ends_at: Date; note: string | null }>`
      select r.name, t.resource_id::text as resource_id, t.starts_at, t.ends_at, t.note from time_off t join resources r on r.id = t.resource_id
      where t.starts_at < ${to}::timestamptz and t.ends_at > ${from}::timestamptz
        and (${person}::bigint is null or t.resource_id = ${person}::bigint)
      order by t.starts_at`;
    const self = (date: string, v: CalendarView = view) => listUrl(base, { view: v === "week" ? null : v, date: date === today ? null : date, person });
    const time = (t: Date) => formatTime(new Date(t), zone);
    const arrow = buttonClass + " w-9 px-0";
    const unit = view === "day" ? "Day" : view === "week" ? "Week" : "Month";
    const onDay = (day: string) => {
      const b = dayBounds(day, zone);
      return { b, mine: rows.filter((r) => new Date(r.starts_at) < b.end && new Date(r.ends_at) > b.start), away: off.filter((t) => new Date(t.starts_at) < b.end && new Date(t.ends_at) > b.start) };
    };
    // A booking opens on the app's page for it; one without (the Website's, made elsewhere) opens on its Reschedule, which can also cancel it.
    const opened = (r: (typeof rows)[number]) =>
      opts.returnTo?.(r)?.href ?? (r.booked && r.status === "confirmed" && new Date(r.starts_at) > new Date() ? `${base}/${r.id}/reschedule` : null);
    const listOf = (ds: string[]) => (
      <ol class="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {ds.map((day) => {
            const { b, mine, away } = onDay(day);
            return (
              <li class={"flex flex-col gap-2 px-4 py-3 sm:flex-row sm:gap-6 " + (day === today ? "bg-accent/5" : "")}>
                <h3 class={"w-36 shrink-0 text-label " + (day === today ? "font-semibold text-accent" : "font-semibold text-ink-2")}>
                  {view === "day" ? <>{formatShortDate(day)}{day === today ? " · Today" : ""}</> : <a href={self(day, "day")} class="text-inherit no-underline hover:underline">{formatShortDate(day)}{day === today ? " · Today" : ""}</a>}
                </h3>
                {mine.length || away.length ? (
                  <ul class="flex min-w-0 flex-1 flex-col gap-2">
                    {away.map((t) => {
                      // Off all day, or from and to the times that fall on this day.
                      const s0 = new Date(t.starts_at), e0 = new Date(t.ends_at);
                      const allDay = s0 <= b.start && e0 >= b.end;
                      const span = allDay ? "all day" : `${s0 > b.start ? time(s0) : "until"}${s0 > b.start ? " to " : " "}${e0 < b.end ? time(e0) : "the end of the day"}`;
                      return <li class={`${smallText} text-ink-2`}>{t.name} is off, {span}{t.note ? ` (${t.note})` : ""}</li>;
                    })}
                    {mine.map((r) => (
                      <li class="flex flex-wrap gap-x-4">
                        <span class="w-44 shrink-0 whitespace-nowrap tabular-nums text-ink-2">{time(r.starts_at)} – {time(r.ends_at)}</span>
                        <span class="min-w-0">
                          {opened(r) ? <a href={opened(r)!} class="font-semibold no-underline hover:underline">{r.name}</a> : <span class="font-semibold">{r.name}</span>}
                          {r.what || r.host ? <span class="text-ink-2"> · {[r.what, r.host ? `with ${r.host}` : null].filter(Boolean).join(" ")}</span> : null}
                          {r.status !== "confirmed" ? <> <StatusBadge value={r.status} options={BOOKING_STATUSES} /></> : null}
                          {r.location || r.booked ? (
                            <span class={`block break-words ${smallText} text-ink-3`}>{r.location_kind === "their_place" && !r.location ? "Address not given yet" : whereText(r, { link: true, team: true })}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <p class={`${smallText} text-ink-3`}>Nothing scheduled</p>}
              </li>
            );
          })}
      </ol>
    );
    // A day for the whole team: a column a person against the hours, as Jobber's and Housecall Pro's crew
    // schedule and Google Calendar's day by people, so who is free when shows at a glance. One person, one
    // picked, or a phone (below sm the columns are too narrow to read) keeps the list.
    const team = people.filter((p) => p.active);
    const board = view === "day" && !person && team.length > 1 ? (() => {
      const { b, mine, away } = onDay(anchor);
      const at = (t: Date) => Math.min(Math.max(Math.round((new Date(t).getTime() - b.start.getTime()) / 60000), 0), 24 * 60);
      // 7am to 6pm, or wider to take an early start or a late finish, on the hour.
      const first = Math.min(7 * 60, ...mine.map((r) => Math.floor(at(r.starts_at) / 60) * 60));
      const last = Math.max(18 * 60, ...mine.map((r) => Math.ceil(at(r.ends_at) / 60) * 60));
      const hours = Array.from({ length: (last - first) / 60 }, (_, i) => first + i * 60);
      const top = (m: number) => `${(((m - first) / (last - first)) * 100).toFixed(3)}%`;
      const span = (s: number, e: number) => `top:${top(s)};height:${(((Math.max(e, s + 15) - s) / (last - first)) * 100).toFixed(3)}%`;
      const columns = [...team.map((p) => ({ id: p.id as string | null, name: p.name })), ...(mine.some((r) => !r.resource_id) ? [{ id: null, name: "Not assigned" }] : [])];
      const height = `height:${hours.length * 4}rem`;
      // Hour lines behind every column, the same for each.
      const lines = `background-image:repeating-linear-gradient(to bottom, var(--color-line) 0, var(--color-line) 1px, transparent 1px, transparent 4rem)`;
      const nowAt = anchor === today ? at(new Date()) : -1;
      return (
        <div class="hidden overflow-x-auto rounded-card border border-line bg-surface shadow-card sm:block">
          <div class="grid min-w-full" style={`grid-template-columns:4.5rem repeat(${columns.length}, minmax(11rem, 1fr))`}>
            <div class="sticky top-0 border-b border-line bg-panel" />
            {columns.map((col) => {
              const n = mine.filter((r) => r.resource_id === col.id).length;
              return (
                <p class={`border-b border-l border-line bg-panel px-3 py-2 font-semibold ${col.id ? "text-ink" : "text-ink-2"}`}>
                  {/* A count, not a noun: the app names its own (the CRM's jobs, a clinic's appointments). */}
                  {col.name}{n ? <span class={`ml-2 rounded-full bg-surface px-2 py-0.5 ${smallText} font-medium tabular-nums text-ink-2 ring-1 ring-line`}>{n}</span> : null}
                </p>
              );
            })}
            <div class="relative" style={height}>
              {hours.map((m) => (
                <span class={`absolute right-2 -translate-y-1/2 ${smallText} tabular-nums text-ink-3`} style={`top:${top(m)}`}>{m === first ? "" : time(new Date(b.start.getTime() + m * 60000))}</span>
              ))}
            </div>
            {columns.map((col) => {
              const theirs = mine.filter((r) => r.resource_id === col.id).sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime());
              // Two at once side by side: each to the first lane free by its start.
              const lanes: number[] = [];
              const placed = theirs.map((r) => {
                const s = at(r.starts_at), e = at(r.ends_at);
                let lane = lanes.findIndex((end) => end <= s);
                if (lane < 0) lane = lanes.push(e) - 1;
                else lanes[lane] = e;
                return { r, s, e, lane };
              });
              const width = 100 / Math.max(lanes.length, 1);
              return (
                <div class="relative border-l border-line" style={`${height};${lines}`}>
                  {away.filter((t) => t.resource_id === col.id).map((t) => (
                    <div class={`absolute inset-x-0 bg-panel/80 px-3 py-1 ${smallText} text-ink-2`} style={span(at(t.starts_at), at(t.ends_at))}>
                      Off{t.note ? `: ${t.note}` : ""}
                    </div>
                  ))}
                  {placed.map(({ r, s, e, lane }) => (
                    <div class={"absolute overflow-hidden rounded-control border-l-4 px-2 py-1 " + (r.status === "confirmed" ? "border-accent bg-accent/10" : "border-line-strong bg-panel text-ink-2")}
                      style={`${span(s, e)};left:calc(${lane * width}% + 2px);width:calc(${width}% - 4px)`}>
                      {/* Who first, then when and what on one line: an hour's block holds both. */}
                      <p class="truncate font-semibold">{opened(r) ? <a href={opened(r)!} class="text-ink no-underline hover:underline">{r.name}</a> : r.name}</p>
                      <p class={`truncate ${smallText} text-ink-2`}><span class="tabular-nums">{time(r.starts_at)} – {time(r.ends_at)}</span>{r.what ? ` · ${r.what}` : ""}</p>
                      {e - s >= 90 && (r.location || r.booked) ? <p class={`truncate ${smallText} text-ink-3`}>{r.location_kind === "their_place" && !r.location ? "Address not given yet" : whereText(r, { team: true })}</p> : null}
                    </div>
                  ))}
                  {nowAt > first && nowAt < last ? <div class="pointer-events-none absolute inset-x-0 border-t-2 border-late" style={`top:${top(nowAt)}`} aria-hidden="true" /> : null}
                </div>
              );
            })}
          </div>
        </div>
      );
    })() : null;
    // A month as a grid of weeks, Monday first, as every calendar's month view; each day its first few, then "+ more" to the day.
    // Below sm the grid is too narrow to read, so a phone gets the month's days that have something, as a list.
    const month = view === "month" ? (
      <>
        <div class="hidden overflow-hidden rounded-card border border-line bg-line shadow-card sm:grid sm:grid-cols-7 sm:gap-px">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => <p class={`bg-panel px-2 py-1.5 ${smallText} font-semibold text-ink-2`}>{w}</p>)}
          {span.grid.map((day) => {
            const { mine, away } = onDay(day);
            const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
            return (
              <div class={"min-h-28 min-w-0 px-2 py-1.5 " + (inMonth ? "bg-surface" : "bg-canvas")}>
                <a href={self(day, "day")} aria-label={formatShortDate(day)}
                  class={"inline-flex size-6 items-center justify-center rounded-full text-label font-semibold no-underline " + (day === today ? "bg-accent text-accent-ink" : inMonth ? "text-ink hover:bg-panel" : "text-ink-3 hover:bg-panel")}>
                  {Number(day.slice(8))}
                </a>
                <ul class="mt-1 flex flex-col gap-0.5">
                  {away.length ? <li class={`truncate ${smallText} text-ink-3`}>{away.map((t) => t.name).join(", ")} off</li> : null}
                  {mine.slice(0, 3).map((r) => (
                    <li class={`truncate ${smallText}`}>
                      <span class="tabular-nums text-ink-3">{time(r.starts_at)}</span>{" "}
                      {opened(r) ? <a href={opened(r)!} class="font-medium text-ink no-underline hover:underline">{r.name}</a> : <span class="font-medium">{r.name}</span>}
                    </li>
                  ))}
                  {mine.length > 3 ? <li><a href={self(day, "day")} class={`${smallText} font-medium text-ink-2 no-underline hover:text-ink`}>+{mine.length - 3} more</a></li> : null}
                </ul>
              </div>
            );
          })}
        </div>
        <div class="sm:hidden">
          {days.some((day) => onDay(day).mine.length || onDay(day).away.length) ? null : <p class="text-ink-3">Nothing scheduled this month.</p>}
        </div>
      </>
    ) : null;
    return framed(c, base, { title: "Schedule", actions: opts.scheduleActions ?? <a href={`${base}/new`} class={primaryClass}>Book for someone</a> }, (
      <>
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <a href={self(span.before)} class={arrow} aria-label={`${unit} before`}>&lsaquo;</a>
            {!span.grid.includes(today) || (view === "month" && today.slice(0, 7) !== anchor.slice(0, 7)) ? <a href={self(today)} class={buttonClass}>Today</a> : null}
            <a href={self(span.after)} class={arrow} aria-label={`${unit} after`}>&rsaquo;</a>
            <h2 class="ml-2 font-semibold">{span.heading}</h2>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <nav aria-label="View" class="inline-flex gap-0.5 rounded-control bg-panel p-0.5">
              {(["day", "week", "month"] as const).map((v) => (
                <a href={self(anchor, v)} aria-current={v === view ? "page" : undefined}
                  class={"rounded-control px-3 py-1 font-medium no-underline " + (v === view ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:text-ink")}>
                  {v === "day" ? "Day" : v === "week" ? "Week" : "Month"}
                </a>
              ))}
            </nav>
            <form method="get" action={base} class="flex items-center gap-2">
              {view === "week" ? null : <input type="hidden" name="view" value={view} />}
              <input type="hidden" name="date" value={anchor} />
              <label>
                <span class="sr-only">Whose</span>
                <Select name="person" onchange="this.form.submit()">
                  <option value="">Everyone</option>
                  {people.map((p) => <option value={p.id} selected={p.id === person}>{p.name}</option>)}
                </Select>
              </label>
              <noscript><button class={buttonClass}>Show</button></noscript>
            </form>
          </div>
        </div>
        {board ? <>{board}<div class="sm:hidden">{listOf(days)}</div></>
          : month ? <>{month}<div class="sm:hidden">{listOf(days.filter((day) => onDay(day).mine.length || onDay(day).away.length))}</div></>
          : listOf(days)}
        <p class={`mt-3 ${smallText} text-ink-3`}>Times are in {zoneName(zone)}.</p>
      </>
    ));
  });

  // Who it is for travels with every link of the flow, so a team member who
  // starts from someone's page (the CRM's customer) never types them again.
  const forWhom = (c: Team, body?: Record<string, unknown>) => {
    const read = (k: string) => (body ? str(body[k]) : c.req.query(k) ?? "").slice(0, k === "address" || k === "notes" ? 2000 : 200);
    return { name: read("name"), email: read("email"), phone: read("phone"), address: read("address") };
  };
  const carry = (w: Record<string, string>, extra: Record<string, string | null | undefined> = {}) => ({ ...w, ...extra });

  app.get("/new", async (c) => {
    const w = forWhom(c);
    const types = await bookableTypes(getDb(c));
    return framed(c, base, { title: w.name ? `Book a time for ${w.name}` : "Book for someone", back: { href: base, label: "Schedule" } }, (
      <>
        {types.length ? (
          <>
            <h2 class="mb-3 font-semibold">Choose a service</h2>
            <ul class="grid gap-3 sm:grid-cols-2">
              {types.map((t) => (
                <li>
                  <a href={listUrl(`${base}/new/${t.id}`, carry(w))}
                    class="block h-full rounded-card border border-line bg-surface p-4 no-underline shadow-card hover:border-accent">
                    <span class="block font-semibold">{t.name}</span>
                    <span class={`block ${smallText} text-ink-2`}>{durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}</span>
                    {t.description ? <span class={`mt-1 block ${smallText} text-ink-3`}>{t.description}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : <p class="text-ink-2">Nothing can be booked yet. <a href={`${opts.sections.services}/new`} class={linkClass}>Add a service</a></p>}
      </>
    ));
  });

  async function pickTime(c: Team, t: BookingType) {
    const d = getDb(c);
    const w = forWhom(c);
    const hosts = await hostsOf(d, t.id);
    const host = hosts.find((h) => h.id === c.req.query("host")) ?? null;
    const zone = opts.timeZone ?? host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const days = await upcoming(d, t, zone, 60, host ? { hosts: [host.id] } : {});
    const keys = [...days.keys()];
    const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
    const here = (extra: Record<string, string | null | undefined>) => listUrl(`${base}/new/${t.id}`, carry(w, { host: host?.id, ...extra }));
    return framed(c, base, {
      title: `${t.name}${w.name ? ` for ${w.name}` : ""}`,
      back: { href: listUrl(`${base}/new`, w), label: "Choose another service" },
      sub: <p>{durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}</p>,
    }, (
      <div class="rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        <p class={`mb-5 flex flex-wrap gap-x-3 gap-y-1 ${smallText} text-ink-2`}>
          {hosts.length === 1 ? <span>Only {hosts[0].name} takes this service, so these are their open times.</span> : null}
          {hosts.length === 1 ? <a href={`${opts.sections.team}/${hosts[0].id}`} class={linkClass}>{hosts[0].name}'s hours</a> : null}
          <a href={`${opts.sections.services}/${t.id}`} class={linkClass}>Change who takes it</a>
        </p>
        {hosts.length > 1 ? (
          <nav aria-label="With" class="mb-5 flex flex-wrap items-center gap-2 text-label">
            <span class="mr-1 font-semibold text-ink-2">With</span>
            <a href={listUrl(`${base}/new/${t.id}`, w)} aria-current={host ? undefined : "true"} class={host ? chip : chipOn}>Anyone free</a>
            {hosts.map((h) => (
              <a href={listUrl(`${base}/new/${t.id}`, carry(w, { host: h.id }))} aria-current={host?.id === h.id ? "true" : undefined} class={host?.id === h.id ? chipOn : chip}>{h.name}</a>
            ))}
          </nav>
        ) : null}
        {keys.length ? (
          <DayAndTimes days={keys} chosen={chosen} href={(day) => here({ date: day })}>
            <ul class="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {(days.get(chosen) ?? []).map((slot) => (
                <li><a class={chip + " w-full"} href={listUrl(`${base}/new/${t.id}/confirm`, carry(w, { host: host?.id, start: slot.start.toISOString() }))}>{formatTime(slot.start, zone)}</a></li>
              ))}
            </ul>
          </DayAndTimes>
        ) : <p class="text-ink-2">No open times{host ? ` with ${host.name}` : ""} in the next weeks.</p>}
        <p class={`mt-5 ${smallText} text-ink-3`}>Times are in {zoneName(zone)}.</p>
      </div>
    ));
  }

  async function confirmTeam(c: Team, t: BookingType, values: Record<string, string>, errors: Errors = {}, notice?: string) {
    const hosts = await hostsOf(getDb(c), t.id);
    const host = hosts.find((h) => h.id === values.host) ?? null;
    const zone = opts.timeZone ?? host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const start = new Date(values.start);
    if (Number.isNaN(start.getTime())) return c.redirect(listUrl(`${base}/new/${t.id}`, forWhom(c)), 303);
    const end = new Date(start.getTime() + t.duration_min * 60_000);
    const local = localDate(start, zone);
    return framed(c, base, {
      title: "Confirm the booking",
      back: { href: listUrl(`${base}/new/${t.id}`, carry(forWhom(c), { host: host?.id, date: local })), label: "Pick another time" },
    }, (
      <div class="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        <dl class="mb-6 grid gap-x-6 gap-y-1 border-b border-line pb-5 sm:grid-cols-[auto_1fr]">
          <dt class="text-label text-ink-3">Service</dt><dd class="font-semibold">{t.name}</dd>
          <dt class="text-label text-ink-3">When</dt><dd>{formatSlot({ start, end }, zone)}</dd>
          <dt class="text-label text-ink-3">With</dt><dd>{host ? host.name : "Whoever is free"}</dd>
          <dt class="text-label text-ink-3">Where</dt><dd>{LOCATION_LABELS[t.location_kind]}</dd>
        </dl>
        {notice ? <p role="alert" class={"mb-4 " + alertClass}>{notice}</p> : null}
        <form method="post" action={`${base}/new/${t.id}`} class="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="start" value={start.toISOString()} />
          {host ? <input type="hidden" name="host" value={host.id} /> : null}
          <Input label="Name" name="name" value={values.name} errors={errors} required />
          <Input label="Email" name="email" type="email" value={values.email} errors={errors} required hint="The confirmation goes here." />
          <Input label={t.location_kind === "phone" ? "Phone, for the call" : "Phone"} name="phone" type="tel" value={values.phone} errors={errors} required={t.location_kind === "phone"} />
          {t.location_kind === "their_place" ? <Input label="Address" name="address" value={values.address} errors={errors} hint="Where the visit is. Leave it blank if you do not have it yet." class="sm:col-span-2" /> : null}
          <label class={fieldClass + " sm:col-span-2"}>Notes
            <textarea name="notes" rows={2} maxlength={2000} class={inputClass}>{values.notes ?? ""}</textarea>
          </label>
          <div class="sm:col-span-2"><button class={primaryClass}>Book it</button></div>
        </form>
      </div>
    ), Object.keys(errors).length || notice ? 422 : 200);
  }

  const loadType = async (c: Team) => {
    const id = idParam(c.req.param("type"));
    const t = id ? await typeById(getDb(c), id) : null;
    return t?.active ? t : null;
  };

  app.get("/new/:type", async (c) => {
    const t = await loadType(c);
    return t ? pickTime(c, t) : c.notFound();
  });

  app.get("/new/:type/confirm", async (c) => {
    const t = await loadType(c);
    if (!t) return c.notFound();
    return confirmTeam(c, t, { ...forWhom(c), host: c.req.query("host") ?? "", start: c.req.query("start") ?? "", notes: "" });
  });

  app.post("/new/:type", async (c) => {
    const t = await loadType(c);
    if (!t) return c.notFound();
    const body = await c.req.parseBody();
    const values = { ...forWhom(c, body), host: str(body.host), start: str(body.start), notes: str(body.notes).slice(0, 2000) };
    const notes = values.notes.trim();
    const r = await book(getDb(c), {
      typeId: t.id, hostId: values.host || null, start: new Date(values.start), name: values.name, email: values.email,
      phone: values.phone || null, address: values.address || null, addressOptional: true, answers: notes ? { notes } : {}, source: opts.source, byTeam: true,
    });
    if (!r.ok && r.reason === "invalid") return confirmTeam(c, t, values, r.errors);
    if (!r.ok) return confirmTeam(c, t, values, {}, "That time was just taken. Go back and pick another.");
    const host = await resourceById(getDb(c), r.booking.resource_id);
    const manageUrl = opts.manageBase ? `${opts.manageBase.replace(/\/+$/, "")}/manage/${r.token}` : null;
    await runOnBooked(opts.onBooked, c, host && { event: "booked" as const, booking: r.booking, type: t, host, manageUrl });
    // onBooked may have filed it somewhere (the Website: its submission); go there.
    const [raw] = await getDb(c).sql`select id::text as id, name, submission_id::text as submission_id from bookings where id = ${r.booking.id}::bigint`;
    return c.redirect(withFlash(homeOf(raw).href, "booked"), 303);
  });

  // Reschedule: another open time of the same service, with the same person or another who takes it.
  async function moveable(c: Team, picked?: unknown) {
    const id = idParam(c.req.param("id"));
    const [raw] = id ? await getDb(c).sql`select * from bookings where id = ${id}::bigint` : [];
    if (!raw) return null;
    const b = toBooking(raw);
    const [type, hosts] = await Promise.all([typeById(getDb(c), b.type_id), b.type_id ? hostsOf(getDb(c), b.type_id) : []]);
    const current = await resourceById(getDb(c), b.resource_id);
    const host = hosts.find((h) => h.id === (picked ?? c.req.query("host"))) ?? current;
    const home = homeOf(raw);
    return type && host && current ? { b, type, host, current, hosts, home, zone: opts.timeZone ?? host.time_zone } : null;
  }

  async function reschedulePage(c: Team, m: NonNullable<Awaited<ReturnType<typeof moveable>>>, notice?: string) {
    const { b, type, host, current, hosts, zone, home } = m;
    const self = `${base}/${b.id}`;
    if (b.status !== "confirmed" || b.starts_at <= new Date()) return c.redirect(withFlash(home.href, "unchanged"), 303);
    const days = await upcoming(getDb(c), type, zone, 60, { hosts: [host.id], exceptBooking: b.id });
    const keys = [...days.keys()];
    const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
    const others = hosts.some((h) => h.id !== current.id);
    const hostParam = host.id === current.id ? null : host.id;
    return framed(c, base, {
      title: `Reschedule ${b.name}`,
      back: home,
      sub: <p>{type.name} with {current.name} · now {formatSlot({ start: b.starts_at, end: b.ends_at }, zone)}</p>,
    }, (
      <div class="rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        {notice ? <p role="alert" class={"mb-4 " + alertClass}>{notice}</p> : null}
        {others ? (
          <nav aria-label="With" class="mb-5 flex flex-wrap items-center gap-2 text-label">
            <span class="mr-1 font-semibold text-ink-2">With</span>
            {[current, ...hosts.filter((h) => h.id !== current.id)].map((h) => (
              <a href={listUrl(`${self}/reschedule`, { host: h.id === current.id ? null : h.id })} aria-current={h.id === host.id ? "true" : undefined}
                class={h.id === host.id ? chipOn : chip}>{h.name}</a>
            ))}
          </nav>
        ) : null}
        {keys.length ? (
          <DayAndTimes days={keys} chosen={chosen} href={(day) => listUrl(`${self}/reschedule`, { date: day, host: hostParam })}>
            <ul class="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {(days.get(chosen) ?? []).filter((slot) => host.id !== current.id || slot.start.getTime() !== b.starts_at.getTime()).map((slot) => (
                <li>
                  <form method="post" action={`${self}/reschedule`}>
                    <input type="hidden" name="start" value={slot.start.toISOString()} />
                    {hostParam ? <input type="hidden" name="host" value={hostParam} /> : null}
                    <button class={chip + " w-full"}>{formatTime(slot.start, zone)}</button>
                  </form>
                </li>
              ))}
            </ul>
          </DayAndTimes>
        ) : <p class="text-ink-2">{host.name} has no other open times in the next weeks.</p>}
        <p class={`mt-5 ${smallText} text-ink-3`}>Times are in {zoneName(zone)}. {b.name} is told the new time.</p>
        <form method="post" action={`${self}/status`} class="mt-5 border-t border-line pt-5" onsubmit={`return confirm(${JSON.stringify("Cancel this booking? They are told, and it cannot be undone.")})`}>
          <input type="hidden" name="status" value="cancelled" />
          <button class={buttonClass}>Cancel booking</button>
        </form>
      </div>
    ), notice ? 409 : 200);
  }

  app.get("/:id/reschedule", async (c) => {
    const m = await moveable(c);
    return m ? reschedulePage(c, m) : c.notFound();
  });

  app.post("/:id/reschedule", async (c) => {
    const body = await c.req.parseBody();
    const m = await moveable(c, str(body.host) || null);
    if (!m) return c.notFound();
    const start = new Date(str(body.start));
    if (Number.isNaN(start.getTime())) return reschedulePage(c, m, "Pick one of the times.");
    const r = await rescheduleById(getDb(c), m.b.id, start, c.get("user"), m.host.id);
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (!r.ok && r.reason === "taken") return reschedulePage(c, m, "That time was just taken. Pick another.");
    if (!r.ok) return c.redirect(withFlash(m.home.href, "unchanged"), 303);
    // The booker hears of the move as they would of their own; their manage link still works, but only its hash is kept here.
    await runOnBooked(opts.onBooked, c, { event: "rescheduled" as const, booking: r.booking, type: m.type, host: m.host, manageUrl: null });
    return c.redirect(withFlash(m.home.href, "rescheduled"), 303);
  });

  app.post("/:id/status", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const [raw] = await getDb(c).sql`select id::text as id, name, submission_id::text as submission_id from bookings where id = ${id}::bigint`;
    if (!raw) return c.notFound();
    const home = homeOf(raw);
    const ret = home.href;
    const status = pickStatus(body.status, BOOKING_STATUSES);
    if (!status) return c.text("Choose one of the listed statuses.", 400);
    const changed = status === "confirmed" ? null : await setStatus(getDb(c), id, status as Exclude<Booking["status"], "confirmed">, c.get("user"));
    // A cancel the team makes is told to the booker, as one they make themselves is.
    if (changed && status === "cancelled" && opts.onBooked) await runOnBooked(opts.onBooked, c, noticeFor(getDb(c), id, "cancelled"));
    if (changed && opts.afterStatus) await opts.afterStatus(c, changed);
    return c.redirect(withFlash(ret, changed ? (status === "cancelled" ? "cancelled" : "status") : "unchanged"), 303);
  });

  return app;
}

// ---- the hours editor ---------------------------------------------------------------

/** What stopped a save, at the top of the form, so a long form never looks as if nothing happened. */
const Problems = ({ errors }: { errors: Errors }) => {
  const list = [...new Set(Object.values(errors))];
  return list.length ? (
    <div role="alert" class={alertClass + " sm:col-span-2"}>
      <p>{list.length === 1 ? "This was not saved:" : "This was not saved. Fix these and save again:"}</p>
      <ul class="mt-1 list-disc pl-5 font-normal">{list.map((e) => <li>{e}</li>)}</ul>
    </div>
  ) : null;
};
const Hint = ({ text }: { text?: string }) => (text ? <span class={`${smallText} text-ink-3`}>{text}</span> : null);

/**
 * A labelled input, its hint and its error under it. `before` and `after`
 * sit inside its edge, as Tailwind's inline add-ons do: "USD" before a
 * price, "minutes" after a gap.
 */
function Input(p: {
  label: string; name: string; value?: string | number | null; type?: string; errors?: Errors; hint?: string; required?: boolean;
  min?: number; max?: number; class?: string; placeholder?: string; before?: string; after?: string;
}) {
  const err = p.errors?.[p.name];
  const attrs = {
    name: p.name, type: p.type ?? "text", value: p.value === null || p.value === undefined ? "" : String(p.value), required: p.required, min: p.min, max: p.max,
    placeholder: p.placeholder, "aria-invalid": err ? "true" : undefined, "aria-describedby": err ? `${p.name}-error` : undefined,
  };
  const addOn = "shrink-0 select-none text-base text-ink-3 sm:text-sm/6";
  return (
    <label class={fieldClass + " " + (p.class ?? "")}>
      {p.label}
      {p.before || p.after ? (
        <span class="flex items-center rounded-control bg-surface px-3 outline-1 -outline-offset-1 outline-line-strong has-[input[aria-invalid=true]]:outline-2 has-[input[aria-invalid=true]]:-outline-offset-2 has-[input[aria-invalid=true]]:outline-ink has-[input:focus-within]:outline-2 has-[input:focus-within]:-outline-offset-2 has-[input:focus-within]:outline-accent">
          {p.before ? <span class={addOn}>{p.before}</span> : null}
          <input {...attrs} class={`block min-w-0 grow bg-transparent py-1.5 text-base font-normal text-ink placeholder:text-ink-3 focus:outline-none sm:text-sm/6 ${p.before ? "pl-1" : ""} ${p.after ? "pr-1" : ""}`} />
          {p.after ? <span class={addOn}>{p.after}</span> : null}
        </span>
      ) : <input {...attrs} class={inputClass} />}
      <Hint text={p.hint} />
      <FieldError id={`${p.name}-error`} text={err} />
    </label>
  );
}

const PROVIDERS = { google: "Google", microsoft: "Microsoft" } as const;

/** What Show available calendars turned up: each calendar once, with an Attach for every account that reaches it. */
function FoundCalendars(p: { self: string; found: CalendarSearch }) {
  return (
    <div class="flex flex-col gap-3">
      {p.found.calendars.length ? (
        <ul class="flex flex-col gap-3">
          {p.found.calendars.map((f) => (
            <li>
              <span class="block break-all font-semibold">{f.name}</span>
              {f.options.map((o) => (
                <form method="post" action={`${p.self}/calendars`} class="mt-1 flex items-center justify-between gap-2">
                  <input type="hidden" name="connection" value={o.connection} />
                  <input type="hidden" name="external_id" value={o.externalId} />
                  <input type="hidden" name="name" value={f.name} />
                  <input type="hidden" name="bookings" value={o.canEdit ? "1" : "0"} />
                  <span class={`min-w-0 break-all ${smallText} text-ink-2`}>Through {o.account ?? o.connection} · {o.canEdit ? "can add bookings" : "busy times only"}</span>
                  <button class={buttonClass}>Attach</button>
                </form>
              ))}
            </li>
          ))}
        </ul>
      ) : <p class={`${smallText} text-ink-3`}>No calendars to add. Connect Google or Microsoft to this app in Task &amp; Tool, on the app's Connections tab, or ask a teammate to share their calendar with a connected account.</p>}
      {p.found.errors.map((e) => <p class={`${smallText} text-ink-2`}>Could not list {e}</p>)}
    </div>
  );
}

/** A choice from a short list; a value set some other way (by the AI, an import) stays offered. */
function Choice(p: { label: string; name: string; value: string; options: [string, string][]; errors?: Errors; hint?: string; class?: string }) {
  const err = p.errors?.[p.name];
  const options = p.options.some(([v]) => v === p.value) || !p.value ? p.options : [...p.options, [p.value, p.value] as [string, string]];
  return (
    <label class={fieldClass + " " + (p.class ?? "")}>
      {p.label}
      <Select name={p.name} aria-invalid={err ? "true" : undefined} aria-describedby={err ? `${p.name}-error` : undefined} class="w-full">
        {options.map(([v, text]) => <option value={v} selected={v === p.value}>{text}</option>)}
      </Select>
      <Hint text={p.hint} />
      <FieldError id={`${p.name}-error`} text={err} />
    </label>
  );
}

/** 12:00 AM to 11:30 PM in half hours, and midnight at the end of the day for an end. */
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const clock = (hhmm: string) => {
  if (hhmm === "24:00") return "Midnight";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const minutes = (list: number[]): [string, string][] => list.map((m) => [String(m), durationText(m)]);
const LENGTHS = minutes([15, 20, 30, 45, 60, 90, 120, 180, 240]);
const NOTICE: [string, string][] = [["0", "None"], ["60", "1 hour"], ["120", "2 hours"], ["240", "4 hours"], ["1440", "1 day"], ["2880", "2 days"], ["10080", "1 week"]];
const AHEAD: [string, string][] = [["7", "1 week"], ["14", "2 weeks"], ["30", "30 days"], ["60", "60 days"], ["90", "90 days"], ["180", "6 months"], ["365", "1 year"]];

const one = (x: unknown) => (Array.isArray(x) ? x[x.length - 1] : x); // a re-rendered body may hold arrays
const valueOf = (r: Record<string, unknown>) => (k: string) => (one(r[k]) === null || one(r[k]) === undefined ? "" : String(one(r[k])));
const Active = ({ value, label, hint }: { value: unknown; label: string; hint?: string }) => (
  <label class="flex items-start gap-3 sm:col-span-2">
    <input type="hidden" name="active" value="0" />
    <input type="checkbox" name="active" value="1" checked={one(value) !== false && one(value) !== "0"} class="mt-1 size-4 shrink-0 accent-accent" />
    <span class="flex flex-col">
      <span class="text-sm/6 font-medium">{label}</span>
      <Hint text={hint} />
    </span>
  </label>
);

/** The fields of a booking rule; open when one of them is wrong, so its message shows. */
const RULES = ["interval_min", "buffer_before_min", "buffer_after_min", "min_notice_min", "horizon_days", "position", "currency", "slug"];

/** A service's fields; the same form adds one. The address or link shows only for a place of ours or a video call. */
function TypeForm({ action, t, errors = {}, submit, publicBase, currency, deals }: { action: string; t: Record<string, unknown>; errors?: Errors; submit: string; publicBase?: string; currency?: string; deals?: boolean }) {
  const v = valueOf(t);
  const kind = v("location_kind") || "their_place";
  const rulesOpen = RULES.some((k) => errors[k]);
  const at = (k: string, fallback: string) => v(k) || fallback;
  // The app's own currency is not asked again; a service priced in another keeps the field.
  const cur = at("currency", currency ?? "usd");
  const ownCurrency = !!currency && cur === currency && !errors.currency;
  return (
    <form method="post" action={action} class="grid gap-x-4 gap-y-5 sm:grid-cols-2">
      <Problems errors={errors} />
      <Input label="Name" name="name" value={v("name")} errors={errors} required placeholder="Installation estimate" class="sm:col-span-2" />
      <label class={fieldClass + " sm:col-span-2"}>
        Description
        <textarea name="description" rows={2} maxlength={2000} placeholder="What it is, shown on the booking page." class={inputClass}>{v("description")}</textarea>
      </label>
      <Choice label="Length" name="duration_min" value={at("duration_min", "60")} options={LENGTHS} errors={errors} />
      <Input label="Price" name="price" value={v("price") || (t.price_cents != null ? amountText(Number(t.price_cents), String(t.currency ?? "usd")) : "")} errors={errors}
        before={cur.toUpperCase()} placeholder="Free" hint="Charged only when it is booked through a form with a payment step." />
      <label class={fieldClass}>
        Where it happens
        <Select name="location_kind" class="w-full" aria-invalid={errors.location_kind ? "true" : undefined}>
          {LOCATION_KINDS.map((k) => <option value={k} selected={k === kind}>{LOCATION_LABELS[k]}</option>)}
        </Select>
        <FieldError id="location_kind-error" text={errors.location_kind} />
      </label>
      {/* Only a place of ours or a video call needs one: the customer gives their own address or number. */}
      <div class="[form:has(option[value=phone]:checked)_&]:hidden [form:has(option[value^=their]:checked)_&]:hidden">
        <Input label="Address or meeting link" name="location" value={v("location")} errors={errors} placeholder="123 Main St, or https://zoom.us/j/…"
          hint="For a video call, leave it blank if you send each person their own link." />
      </div>
      <details open={rulesOpen} class="group rounded-card border border-line sm:col-span-2">
        <summary class="cursor-pointer list-none px-4 py-3 text-sm/6 font-semibold">
          Scheduling rules <span class="font-normal text-ink-3">· start times, gaps, notice</span>
        </summary>
        <div class="grid gap-x-4 gap-y-5 border-t border-line p-4 sm:grid-cols-2">
          <p class={`${smallText} text-ink-2 sm:col-span-2`}>
            These cut the hours of whoever takes it into appointments: a time is open when they are working (Team), not off, and not already booked.
          </p>
          <Choice label="Start times every" name="interval_min" value={at("interval_min", "30")} options={minutes([10, 15, 20, 30, 45, 60, 90, 120])} errors={errors} />
          <Choice label="Booking notice" name="min_notice_min" value={at("min_notice_min", "120")} options={NOTICE} errors={errors} hint="How soon a customer can book." />
          <Input label="Gap before" name="buffer_before_min" type="number" min={0} max={1440} value={at("buffer_before_min", "0")} errors={errors} after="minutes" hint="Travel or set-up time." />
          <Input label="Gap after" name="buffer_after_min" type="number" min={0} max={1440} value={at("buffer_after_min", "0")} errors={errors} after="minutes" />
          <Choice label="Bookable up to" name="horizon_days" value={at("horizon_days", "60")} options={AHEAD} errors={errors} hint="How far ahead." />
          <Input label="Booking page address" name="slug" value={v("slug")} errors={errors} before={publicBase ? `${publicBase.replace(/^https?:\/\//, "")}/` : "/book/"}
            placeholder="made from the name" />
          <Input label="Order on the booking page" name="position" type="number" min={0} value={at("position", "0")} errors={errors} />
          {ownCurrency ? <input type="hidden" name="currency" value={cur} /> : <Input label="Currency" name="currency" value={cur} errors={errors} hint="Like usd." />}
        </div>
      </details>
      <Active value={t.active} label="Can be booked" hint="Off hides it from the booking page; bookings already made stay." />
      {/* As Jobber's job booking: each online booking is a job to win at once, its lead marked converted. */}
      {deals ? (
        <label class="flex items-start gap-3 sm:col-span-2">
          <input type="hidden" name="deals" value="0" />
          <input type="checkbox" name="deals" value="1" checked={one(t.deals) === true || one(t.deals) === "1"} class="mt-1 size-4 shrink-0 accent-accent" />
          <span class="flex flex-col">
            <span class="text-sm/6 font-medium">Each booking becomes a deal, straight away</span>
            <Hint text="In the pipeline's first stage, its value the price, its lead marked converted. Off: a lead to look at first." />
          </span>
        </label>
      ) : null}
      <div class="sm:col-span-2"><button class={primaryClass}>{submit}</button></div>
    </form>
  );
}

/** Every IANA zone, the likeliest first; the current one stays offered even if this runtime does not list it. */
const COMMON_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "Australia/Sydney"];

function ZoneSelect({ current, errors }: { current: string; errors: Errors }) {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const common = COMMON_ZONES.filter((z) => all.includes(z) || z === current);
  const rest = [...new Set([...all, "UTC", current])].filter((z) => z && !common.includes(z)).sort();
  const err = errors.time_zone;
  const option = (z: string) => <option value={z} selected={z === current}>{zoneName(z)}</option>;
  return (
    <label class={fieldClass + " min-w-0"}>
      Time zone
      <Select name="time_zone" required aria-invalid={err ? "true" : undefined} aria-describedby={err ? "time_zone-error" : undefined} class="w-full min-w-0">
        <optgroup label="Common">{common.map(option)}</optgroup>
        <optgroup label="Everywhere else">{rest.map(option)}</optgroup>
      </Select>
      <Hint text="Their weekly hours are in this zone." />
      <FieldError id="time_zone-error" text={err} />
    </label>
  );
}

/** A person's details; the same form adds one, starting in `zone` (the business's). */
function PersonForm({ action, r, errors = {}, submit, zone }: { action: string; r: Record<string, unknown>; errors?: Errors; submit: string; zone: string }) {
  const v = valueOf(r);
  return (
    <form method="post" action={action} class="grid gap-x-4 gap-y-5 sm:grid-cols-2">
      <Problems errors={errors} />
      <Input label="Name" name="name" value={v("name")} errors={errors} required />
      <Input label="Email" name="email" type="email" value={v("email")} errors={errors} hint="The organizer on calendar invites." />
      <ZoneSelect current={v("time_zone") || zone} errors={errors} />
      <Active value={r.active} label="Taking bookings" hint="Off keeps their bookings and stops new ones." />
      <div class="sm:col-span-2"><button class={primaryClass}>{submit}</button></div>
    </form>
  );
}

const typeFields = (body: Record<string, unknown>): TypeFields => ({
  name: str(body.name), slug: str(body.slug), description: str(body.description), location_kind: str(body.location_kind), location: str(body.location),
  duration_min: str(body.duration_min), interval_min: str(body.interval_min), buffer_before_min: str(body.buffer_before_min),
  buffer_after_min: str(body.buffer_after_min), min_notice_min: str(body.min_notice_min), horizon_days: str(body.horizon_days),
  position: str(body.position), active: str(one(body.active)), price: str(body.price), currency: str(body.currency),
  deals: str(one(body.deals)),
});
const personFields = (body: Record<string, unknown>): PersonFields => ({
  name: str(body.name), email: str(body.email), time_zone: str(body.time_zone), active: str(one(body.active)),
});


/** A list of records, each a row that opens it: the services, the team. */
const rowCard = "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 no-underline hover:bg-panel/60";

/** Services: each one's length, where it happens, its price and who takes it. */
export function typeRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "Services" }];
  const bookingBase = opts.sections.schedule;
  const peopleBase = opts.sections.team;
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const framed = sectionPages({ Frame: opts.Frame, css: opts.css, label: "Schedule", links, messages: MESSAGES });
  // The booking pages' address, for the page address field and the link to a service's page.
  const publicBase = opts.manageBase?.replace(/\/+$/, "");

  app.get("/", async (c) => {
    const d = getDb(c);
    const types = await allTypes(d);
    const hosts = await Promise.all(types.map((t) => hostsOf(d, t.id, { all: true })));
    return framed(c, base, { title: "Services", actions: <a href={`${base}/new`} class={primaryClass}>New service</a> }, (
      <>
        {types.length ? (
          <ul class="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {types.map((t, i) => (
              <li>
                <a href={`${base}/${t.id}`} class={rowCard}>
                  <span class="min-w-0">
                    <span class="block font-semibold">{t.name}</span>
                    <span class={`block ${smallText} text-ink-2`}>
                      {durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}
                      {t.price_cents ? ` · ${amountText(t.price_cents, t.currency ?? "usd")} ${(t.currency ?? "usd").toUpperCase()}` : ""}
                    </span>
                  </span>
                  <span class={`flex flex-wrap items-center gap-2 ${smallText} text-ink-2`}>
                    {hosts[i].length ? hosts[i].map((h) => h.name).join(", ") : <span class="text-ink">Nobody takes it yet</span>}
                    {t.active ? null : <StatusBadge value="off" options={[{ value: "off", label: "Not bookable", tone: "muted" }]} />}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : <p class="text-ink-2">Nothing can be booked yet. <a href={`${base}/new`} class={linkClass}>Add a service</a>: an estimate visit, a consultation, a video call.</p>}
      </>
    ));
  });

  const newPage = (c: Team, values: Record<string, unknown> = {}, errors: Errors = {}) =>
    framed(c, base, { title: "New service", back: { href: base, label: "Services" } }, (
      <div class="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        <TypeForm action={base} t={values} errors={errors} submit="Create service" publicBase={publicBase} currency={opts.currency} deals={opts.deals} />
      </div>
    ), Object.keys(errors).length ? 422 : 200);

  async function editPage(c: Team, t: BookingType, problems: { values?: Record<string, unknown>; errors?: Errors } = {}) {
    const d = getDb(c);
    const [hosts, people] = await Promise.all([hostsOf(d, t.id, { all: true }), allPeople(d)]);
    const self = `${base}/${t.id}`;
    return framed(c, base, {
      title: t.name,
      back: { href: base, label: "Services" },
      sub: <p>{durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}{t.active ? "" : " · Not bookable"}</p>,
      actions: (
        <>
          {publicBase && t.active ? <a href={`${publicBase}/${t.slug}`} target="_blank" rel="noopener" class={buttonClass}>View booking page</a> : null}
          {t.active ? <a href={`${bookingBase}/new/${t.id}`} class={buttonClass}>Book for someone</a> : null}
        </>
      ),
    }, (
      <>
        <div class="grid gap-4 md:grid-cols-3">
          <Section title="Details" class="md:col-span-2">
            <TypeForm action={self} t={problems.values ?? t} errors={problems.errors} submit="Save" publicBase={publicBase} currency={opts.currency} deals={opts.deals} />
          </Section>
          <Section title="Who takes it" class="self-start">
            {people.length ? (
              <form method="post" action={`${self}/hosts`} class="flex flex-col gap-3">
                <p class={`${smallText} text-ink-3`}>
                  Its open times are their weekly hours (under Team), less time off and what they already have booked. Customers pick one, or take whoever is free.
                </p>
                {people.map((p) => (
                  <label class="flex items-center gap-3">
                    <input type="checkbox" name="host" value={p.id} checked={hosts.some((h) => h.id === p.id)} class="size-4 accent-accent" />
                    <span class="text-sm/6">{p.name}{p.active ? null : <span class={`${smallText} text-ink-3`}> · not taking bookings</span>}</span>
                  </label>
                ))}
                <div><button class={buttonClass}>Save</button></div>
              </form>
            ) : (
              <p class="text-ink-2">Nobody is on the team yet. <a href={`${peopleBase}/new`} class={linkClass}>Add a person</a></p>
            )}
          </Section>
        </div>
      </>
    ), problems.errors ? 422 : 200);
  }

  const load = async (c: Team) => {
    const id = idParam(c.req.param("id"));
    return id ? typeById(getDb(c), id) : null;
  };

  app.get("/new", (c) => newPage(c));

  app.post("/", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const t = await createType(getDb(c), typeFields(body), c.get("user"), opts.source);
    if (!t.ok) return newPage(c, body as Record<string, unknown>, t.errors);
    return c.redirect(withFlash(`${base}/${t.value.id}`, "type-created"), 303);
  });

  app.get("/:id", async (c) => {
    const t = await load(c);
    return t ? editPage(c, t) : c.notFound();
  });

  app.post("/:id", async (c) => {
    const t = await load(c);
    if (!t) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const saved = await saveType(getDb(c), t.id, typeFields(body), c.get("user"));
    if (!saved.ok) return editPage(c, t, { values: body as Record<string, unknown>, errors: saved.errors });
    return c.redirect(withFlash(`${base}/${t.id}`, "saved"), 303);
  });

  app.post("/:id/hosts", async (c) => {
    const t = await load(c);
    if (!t) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const ids = ([] as unknown[]).concat(body.host ?? []).map(String);
    await setHosts(getDb(c), t.id, ids);
    return c.redirect(withFlash(`${base}/${t.id}`, "hosts"), 303);
  });

  return app;
}

/** "Mon–Fri 8:00 AM – 5:00 PM, Sat 9:00 AM – 1:00 PM": a week of hours in a line, days with the same hours run together. */
function hoursLine(hours: HoursWindow[]): string {
  const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const of = (day: number) => hours.filter((h) => h.weekday === day).map((h) => `${clock(h.start)} – ${clock(h.end)}`).join(", ");
  const parts: string[] = [];
  // Monday first, as a working week reads; Sunday last.
  const order = [1, 2, 3, 4, 5, 6, 0];
  for (let i = 0; i < order.length; ) {
    const text = of(order[i]);
    let j = i;
    while (j + 1 < order.length && of(order[j + 1]) === text) j++;
    if (text) parts.push(`${SHORT[order[i]]}${j > i ? `–${SHORT[order[j]]}` : ""} ${text}`);
    i = j + 1;
  }
  return parts.join(", ");
}


/** The team who take bookings: each one's details, weekly hours, time off, and the services they take. */
export function peopleRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "Team" }];
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const framed = sectionPages({ Frame: opts.Frame, css: opts.css, label: "Schedule", links, messages: MESSAGES });
  const calendarsOn = opts.calendars !== false;

  app.get("/", async (c) => {
    const d = getDb(c);
    const all = await allPeople(d);
    const hours = await Promise.all(all.map((r) => weeklyHours(d, r.id)));
    return framed(c, base, { title: "Team", actions: <a href={`${base}/new`} class={primaryClass}>New team member</a> }, (
      <>
        {all.length ? (
          <ul class="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {all.map((r, i) => (
              <li>
                <a href={`${base}/${r.id}`} class={rowCard}>
                  <span class="min-w-0">
                    <span class="block font-semibold">{r.name}</span>
                    <span class={`block ${smallText} text-ink-2`}>{hoursLine(hours[i]) || "No hours set"} · {zoneName(r.time_zone)}</span>
                  </span>
                  {r.active ? null : <StatusBadge value="off" options={[{ value: "off", label: "Not taking bookings", tone: "muted" }]} />}
                </a>
              </li>
            ))}
          </ul>
        ) : <p class="text-ink-2">Nobody takes bookings yet. <a href={`${base}/new`} class={linkClass}>Add the first person</a></p>}
      </>
    ));
  });

  const newPage = async (c: Team, values: Record<string, unknown> = {}, errors: Errors = {}) => {
    const all = await allPeople(getDb(c));
    return framed(c, base, { title: "New team member", back: { href: base, label: "Team" } }, (
      <div class="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        <PersonForm action={base} r={values} errors={errors} submit="Create team member" zone={opts.timeZone ?? all[0]?.time_zone ?? "UTC"} />
      </div>
    ), Object.keys(errors).length ? 422 : 200);
  };

  /** `found`: what Show available calendars turned up, on the page it was asked from. */
  async function editPage(c: Team, r: Resource, problems: { details?: { values: Record<string, unknown>; errors: Errors }; hours?: Errors; timeOff?: Errors; calendar?: Errors } = {}, found?: CalendarSearch) {
    const d = getDb(c);
    const [hours, off, takes, cals] = await Promise.all([weeklyHours(d, r.id), timeOffList(d, r.id), typesHostedBy(d, r.id), calendarsOn ? calendars(d, r.id) : []]);
    const attached = (o: { connection: string; externalId: string }) => cals.some((k) => k.connection === o.connection && k.external_id === o.externalId);
    // The lookup goes through the app's connections (dev or production).
    const reachable = gatewayReachable(envOf(c));
    const self = `${base}/${r.id}`;
    const failed = Object.values(problems).some(Boolean);
    const today = localDate(new Date(), r.time_zone);
    const remove = "rounded-control px-1 text-ink-3 no-underline hover:bg-panel hover:text-ink";
    return framed(c, base, {
      title: r.name,
      back: { href: base, label: "Team" },
      sub: <p>{zoneName(r.time_zone)}{r.email ? ` · ${r.email}` : ""}{r.active ? "" : " · Not taking bookings"}</p>,
    }, (
      <>
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Weekly hours">
            <p class={`mb-3 ${smallText} text-ink-2`}>When {r.name} can be booked, for every service they take. Each service's scheduling rules cut these hours into appointments.</p>
            <ul class="mb-5 divide-y divide-line">
              {WEEKDAYS.map((_, i) => (i + 1) % 7).map((i) => {
                const mine = hours.filter((h) => h.weekday === i);
                return (
                  <li class="flex flex-wrap items-center gap-2 py-2">
                    <span class="w-28 font-semibold">{WEEKDAYS[i]}</span>
                    {mine.length ? mine.map((h) => (
                      <form method="post" action={`${self}/hours/${h.id}/delete`} class="flex items-center gap-1 rounded-control bg-panel py-0.5 pl-2.5 pr-1">
                        <span>{clock(h.start)} – {clock(h.end)}</span>
                        <button class={remove} aria-label={`Remove ${WEEKDAYS[i]} ${clock(h.start)} to ${clock(h.end)}`} title="Remove">&times;</button>
                      </form>
                    )) : <span class="text-ink-3">Unavailable</span>}
                  </li>
                );
              })}
            </ul>
            <form method="post" action={`${self}/hours`} class="flex flex-wrap items-end gap-3">
              <Choice label="Day" name="weekday" value="weekdays" options={[["weekdays", "Every weekday"], ...[1, 2, 3, 4, 5, 6, 0].map((i) => [String(i), WEEKDAYS[i]] as [string, string])]} errors={problems.hours} />
              <Choice label="From" name="start" value="09:00" options={HALF_HOURS.map((t) => [t, clock(t)] as [string, string])} errors={problems.hours} />
              <Choice label="To" name="end" value="17:00" options={[...HALF_HOURS.slice(1), "24:00"].map((t) => [t, clock(t)] as [string, string])} errors={problems.hours} />
              <button class={buttonClass}>Add hours</button>
            </form>
          </Section>

          <Section title="Time off">
            {off.length ? (
              <ul class="mb-4 divide-y divide-line">
                {off.map((t) => (
                  <li class="flex items-start justify-between gap-3 py-2">
                    <span class="min-w-0">
                      <When at={t.starts_at} timeZone={r.time_zone} /> – <When at={t.ends_at} timeZone={r.time_zone} />
                      {t.note ? <span class="text-ink-2"> · {t.note}</span> : null}
                    </span>
                    <form method="post" action={`${self}/time-off/${t.id}/delete`}><button class={remove} aria-label="Remove this time off" title="Remove">&times;</button></form>
                  </li>
                ))}
              </ul>
            ) : <p class="mb-4 text-ink-3">None coming up.</p>}
            <form method="post" action={`${self}/time-off`} class="grid gap-3 sm:grid-cols-2">
              <Input label="From" name="starts" type="datetime-local" value={`${today}T00:00`} errors={problems.timeOff} />
              <Input label="Until" name="ends" type="datetime-local" value={`${today}T23:59`} errors={problems.timeOff} />
              <Input label="Note" name="note" errors={problems.timeOff} placeholder="Vacation" class="sm:col-span-2" />
              <div class="sm:col-span-2"><button class={buttonClass}>Add time off</button></div>
            </form>
          </Section>
            <Section title="Details">
              <PersonForm action={self} r={problems.details?.values ?? r} errors={problems.details?.errors} submit="Save" zone={r.time_zone} />
            </Section>
          </div>
          <div class="flex min-w-0 flex-col gap-4">
            <Section title="Services">
              {takes.length ? (
                <ul class="flex flex-col gap-1">
                  {takes.map((t) => <li><a href={`${opts.sections.services}/${t.id}`} class={linkClass}>{t.name}</a></li>)}
                </ul>
              ) : <p class="text-ink-2">None yet.</p>}
              <p class={`mt-3 ${smallText} text-ink-3`}>Choose who takes each one on its page under <a href={opts.sections.services} class={linkClass}>Services</a>.</p>
            </Section>
            {calendarsOn ? (
              <Section title="Calendars">
                {cals.length ? (
                  <ul class="mb-4 flex flex-col gap-2">
                    {cals.map((k) => (
                      <li class="flex items-start justify-between gap-2">
                        <span class="min-w-0">
                          <span class="block break-all">{PROVIDERS[k.provider]} · {k.name ?? k.account ?? k.connection}</span>
                          <span class={`block ${smallText} text-ink-3`}>
                            {k.name && k.account ? `Through ${k.account} · ` : ""}{k.receives_bookings ? "" : "Busy times only · "}
                            {k.last_error ? <span class="font-semibold text-ink">Sync failed: {k.last_error}</span> : k.last_synced_at ? <>Synced <When at={k.last_synced_at} timeZone={r.time_zone} /></> : "Not synced yet"}
                          </span>
                        </span>
                        <form method="post" action={`${self}/calendars/${k.id}/delete`}><button class={remove} aria-label="Remove this calendar" title="Remove">&times;</button></form>
                      </li>
                    ))}
                  </ul>
                ) : <p class={`mb-4 ${smallText} text-ink-3`}>Busy times in their calendar close those times here, and new bookings go into it.</p>}
                <FieldError id="calendar-error" text={problems.calendar?.calendar} />
                {found ? (
                  <FoundCalendars self={self} found={{ ...found, calendars: found.calendars.filter((f) => !f.options.some(attached)) }} />
                ) : reachable ? (
                  <form method="post" action={`${self}/calendars/find`}><button class={buttonClass}>Show available calendars</button></form>
                ) : <p class={`${smallText} text-ink-3`}>Their calendars can be found once this app is deployed again.</p>}
              </Section>
            ) : null}
          </div>
        </div>
      </>
    ), failed ? 422 : 200);
  }

  const load = async (c: Team) => {
    const id = idParam(c.req.param("id"));
    return id ? resourceById(getDb(c), id) : null;
  };
  const back = (r: Resource, code: string) => withFlash(`${base}/${r.id}`, code);

  app.get("/new", (c) => newPage(c));

  app.post("/", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const r = await createPerson(getDb(c), personFields(body), c.get("user"), opts.source);
    if (!r.ok) return newPage(c, body as Record<string, unknown>, r.errors);
    return c.redirect(withFlash(`${base}/${r.value.id}`, "created"), 303);
  });

  app.get("/:id", async (c) => {
    const r = await load(c);
    return r ? editPage(c, r) : c.notFound();
  });

  app.post("/:id", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const saved = await savePerson(getDb(c), r.id, personFields(body), c.get("user"));
    if (!saved.ok) return editPage(c, r, { details: { values: body as Record<string, unknown>, errors: saved.errors } });
    return c.redirect(back(r, "saved"), 303);
  });

  // One day's hours, or the same hours on every weekday.
  app.post("/:id/hours", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const body = await c.req.parseBody();
    const days = body.weekday === "weekdays" ? ["1", "2", "3", "4", "5"] : [body.weekday];
    for (const day of days) {
      const saved = await addWindow(getDb(c), r.id, day, body.start, body.end, c.get("user"));
      if (saved.ok) continue;
      // Every weekday stops at the first day that cannot take them; say which, and that the days before it have them.
      if (days.length === 1) return editPage(c, r, { hours: saved.errors });
      const at = WEEKDAYS[Number(day)];
      const done = days.slice(0, days.indexOf(day)).map((d) => WEEKDAYS[Number(d)]);
      const why = Object.values(saved.errors)[0].replace("that day", at);
      return editPage(c, r, { hours: { weekday: done.length ? `${why} Added for ${done.join(", ")}.` : why } });
    }
    return c.redirect(back(r, "hours"), 303);
  });

  app.post("/:id/hours/:wid/delete", async (c) => {
    const r = await load(c);
    const wid = idParam(c.req.param("wid"));
    if (!r || !wid) return c.notFound();
    await removeWindow(getDb(c), r.id, wid);
    return c.redirect(back(r, "hours"), 303);
  });

  app.post("/:id/time-off", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const body = await c.req.parseBody();
    const saved = await addTimeOff(getDb(c), r, body.starts, body.ends, body.note, c.get("user"));
    return saved.ok ? c.redirect(back(r, "time-off"), 303) : editPage(c, r, { timeOff: saved.errors });
  });

  app.post("/:id/time-off/:tid/delete", async (c) => {
    const r = await load(c);
    const tid = idParam(c.req.param("tid"));
    if (!r || !tid) return c.notFound();
    await removeTimeOff(getDb(c), r.id, tid);
    return c.redirect(back(r, "time-off"), 303);
  });

  if (!calendarsOn) return app;

  app.post("/:id/calendars/find", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const d = getDb(c);
    const env = envOf(c);
    try {
      // Fresh from Task & Tool first, so an account connected a minute ago is asked too.
      await linkAccounts(d, await listConnections(env));
      return editPage(c, r, {}, await findCalendars(d, (slug, path, init) => gatewayFetch(env, slug, path, init)));
    } catch (e) {
      return editPage(c, r, {}, { calendars: [], errors: [`the connected accounts: ${(e as Error).message}`] });
    }
  });

  app.post("/:id/calendars", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const saved = await addCalendar(getDb(c), r.id, await c.req.parseBody(), c.get("user"));
    return saved.ok ? c.redirect(back(r, "calendar"), 303) : editPage(c, r, { calendar: saved.errors });
  });

  app.post("/:id/calendars/:kid/delete", async (c) => {
    const r = await load(c);
    const kid = idParam(c.req.param("kid"));
    if (!r || !kid) return c.notFound();
    await removeCalendar(getDb(c), r.id, kid);
    return c.redirect(back(r, "calendar"), 303);
  });

  return app;
}
