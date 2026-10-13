// The team's side of booking, private (teamOnly): the bookings list and a
// booking's page with its status, what can be booked (booking types and
// their hosts), each person's weekly hours, time off and calendars, and the
// calendars' last sync. Built on admin/; every form works without JavaScript.
//
//   app.route("/admin/bookings", bookingAdmin(getDb, { base: "/admin/bookings", css: "/site.css", source: "website" }));
//
// It mounts typeRoutes at /types and peopleRoutes at /people; an app that
// wants only one of them mounts it alone. They write the tables the booking
// page reads, so a change shows on its next load.
//
// `getDb` makes the request's handle (data/db.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Db, GetDb } from "../data/db";
import { FieldList, JsonData, Section } from "../admin/detail";
import { alertClass, Flash, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { cut, readCursor, type Cursor, type Keyed } from "../admin/keyset";
import { SectionPage, type Frame, type Head, type NavItem } from "../admin/layout";
import { DataTable, EmptyCard, EmptyState, NoMatches, SearchBar, TableRows, When, type TableSpec } from "../admin/list";
import { idParam, isPartial, likePattern, listUrl, localPath, str } from "../admin/query";
import { buttonClass, controlClass, fieldClass, pickStatus, primaryClass, StatusBadge, type StatusOption } from "../admin/status";
import { book, bookableTypes, hostsOf, LOCATION_KINDS, rescheduleById, resourceById, setStatus, toBooking, typeById, whereText, type Booking, type BookingType, type Resource } from "./book";
import {
  addCalendar, addTimeOff, addWindow, allPeople, allTypes, calendars, createPerson, createType, LOCATION_LABELS, removeCalendar,
  removeTimeOff, removeWindow, savePerson, saveType, setHosts, timeOffList, typesHostedBy, weeklyHours, WEEKDAYS,
  type Errors, type HoursWindow, type PersonFields, type TypeFields,
} from "./hours";
import { addDays, dayBounds, durationText, formatShortDate, formatSlot, formatTime, localDate, weekdayOf, zoneName } from "./slots";
import { chip, chipOn, DayAndTimes, upcoming } from "./public";
import { decimals } from "../payments/money";
import type { BookingNotice } from "./notify";

/** Minor units as the editor shows them: 12000 usd is "120.00". */
const amountText = (cents: number, currency: string) => (cents / 10 ** decimals(currency)).toFixed(decimals(currency));

export type BookingAdminOptions = {
  base: string;
  css: string;
  /** This app's slug, stored on the types and people it creates. */
  source: string;
  nav?: NavItem[];
  /** What the row of section links is called to a screen reader: the CRM's "Schedule". */
  navLabel?: string;
  pageSize?: number;
  /**
   * The app's own page frame (the CRM's layout and nav), instead of
   * AdminLayout. The booking sections then show as links at the top of the page.
   */
  Frame?: Frame;
  /**
   * false in an app that does not run the calendar sync (sync.ts runs in the
   * CRM): the Calendars page and each person's calendars are left out, so no
   * one adds a calendar that never syncs. Default true.
   */
  calendars?: boolean;
  /** The business's zone: the Calendar and the bookings list show times in it. Absent, the Calendar shows the first person's and the list each host's. */
  timeZone?: string;
  /**
   * The public booking pages' address, absolute ("https://acme.com/book"), so
   * a booking the team makes gets a manage link the booker can use. Without
   * it the confirmation says to reply instead.
   */
  manageBase?: string;
  /** After the team books for someone: send the confirmation here (notify.ts). Never throws into the response. */
  onBooked?: (c: Context<{ Variables: TeamVars }>, e: BookingNotice) => void | Promise<void>;
  /** More on a booking's page, beside its status: the CRM's customer and "Create job". */
  extra?: (c: Context<{ Variables: TeamVars }>, b: Booking) => Child | Promise<Child>;
  /**
   * The app's own things on the team's days, shown on the Calendar among the
   * bookings (the CRM's jobs), as Jobber's Schedule shows visits beside
   * assessments. `person` is the one picked, or null for everyone.
   */
  more?: (c: Context<{ Variables: TeamVars }>, range: { from: string; to: string }, person: { name: string; email: string | null } | null) => Promise<CalendarItem[]>;
  /** The Calendar's buttons, in place of New booking (the CRM adds New job). */
  calendarActions?: Child;
};

/** One of the app's own things on the Calendar: when, who and what, and where it opens. */
export type CalendarItem = { starts_at: Date; ends_at: Date | null; href: string; name: string; what: string; badge?: Child; note?: Child };

export type { Frame, Head } from "../admin/layout";

/** The page, in the app's frame or AdminLayout: SectionPage. */
function framed(c: Context<{ Variables: TeamVars }>, opts: BookingAdminOptions, links: NavItem[], current: string, head: Head, body: Child, status = 200) {
  return c.html(<SectionPage Frame={opts.Frame} css={opts.css} user={c.get("user")} label={opts.navLabel ?? "Booking"} links={links} current={current} head={head}>{body}</SectionPage>, status as 200);
}

export const BOOKING_STATUSES: StatusOption[] = [
  { value: "confirmed", label: "Confirmed", tone: "accent" },
  { value: "completed", label: "Completed", tone: "neutral" },
  { value: "no_show", label: "No-show", tone: "muted" },
  { value: "cancelled", label: "Cancelled", tone: "muted" },
];

const MESSAGES: FlashMessages = {
  status: "Status saved.",
  unchanged: "Nothing changed. A cancelled booking stays cancelled, and a booking is marked completed or no-show only once it has started.",
  saved: "Saved.",
  hours: "Hours saved.",
  "time-off": "Time off saved.",
  hosts: "Who takes it saved.",
  calendar: "Calendar saved. The next sync, within 15 minutes, reads it.",
  created: "Added. Now set their weekly hours.",
  "type-created": "Added. Now choose who takes it.",
  booked: "Booked.",
  cancelled: "Booking cancelled.",
  rescheduled: "Rescheduled.",
};

type Row = Keyed & {
  id: string; name: string; email: string; status: string; starts_at: Date; ends_at: Date; resource_name: string; time_zone: string; type_name: string;
};
type Filter = { q: string | null; when: "upcoming" | "past"; resource: string | null; type: string | null; status: string | null };

function readFilter(c: Context): Filter {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  return {
    q: q || null,
    when: c.req.query("when") === "past" ? "past" : "upcoming",
    resource: idParam(c.req.query("resource")),
    type: idParam(c.req.query("type")),
    status: pickStatus(c.req.query("status"), BOOKING_STATUSES),
  };
}

/**
 * Upcoming: soonest first, from bookings not yet over. Past: latest first.
 * Two statements rather than a direction parameter, so each uses the
 * (starts_at, id) index.
 */
export function bookingsPage(db: Db, f: Filter, after: Cursor | null, size: number, now = new Date()): Promise<Row[]> {
  const pat = likePattern(f.q);
  const k = after?.k ?? null, id = after?.id ?? null, t = now.toISOString();
  return f.when === "upcoming"
    ? db.sql<Row>`
        select b.id::text as id, b.name, b.email::text as email, b.status, b.starts_at, b.ends_at, r.name as resource_name, r.time_zone,
               t.name as type_name, b.starts_at::text as k
        from bookings b join resources r on r.id = b.resource_id join booking_types t on t.id = b.type_id
        where b.ends_at > ${t}::timestamptz
          and (${pat}::text is null or b.name ilike ${pat} or b.email::text ilike ${pat})
          and (${f.resource}::bigint is null or b.resource_id = ${f.resource}::bigint)
          and (${f.type}::bigint is null or b.type_id = ${f.type}::bigint)
          and (${f.status}::text is null or b.status = ${f.status})
          and (${k}::timestamptz is null or (b.starts_at, b.id) > (${k}::timestamptz, ${id}::bigint))
        order by b.starts_at, b.id limit ${size + 1}`
    : db.sql<Row>`
        select b.id::text as id, b.name, b.email::text as email, b.status, b.starts_at, b.ends_at, r.name as resource_name, r.time_zone,
               t.name as type_name, b.starts_at::text as k
        from bookings b join resources r on r.id = b.resource_id join booking_types t on t.id = b.type_id
        where b.ends_at <= ${t}::timestamptz
          and (${pat}::text is null or b.name ilike ${pat} or b.email::text ilike ${pat})
          and (${f.resource}::bigint is null or b.resource_id = ${f.resource}::bigint)
          and (${f.type}::bigint is null or b.type_id = ${f.type}::bigint)
          and (${f.status}::text is null or b.status = ${f.status})
          and (${k}::timestamptz is null or (b.starts_at, b.id) < (${k}::timestamptz, ${id}::bigint))
        order by b.starts_at desc, b.id desc limit ${size + 1}`;
}

/** The sections, named as booking tools name them. A person's calendars are on their page under Team. */
function nav(base: string, opts: BookingAdminOptions): NavItem[] {
  return opts.nav ?? [
    { href: base, label: "Bookings" },
    { href: `${base}/calendar`, label: "Calendar" },
    { href: `${base}/types`, label: "Services" },
    { href: `${base}/people`, label: "Team" },
  ];
}

/** A status change, as one button; Cancel asks first. */
function StatusButton({ action, status, label, primary, ask }: { action: string; status: string; label: string; primary?: boolean; ask?: string }) {
  return (
    <form method="post" action={action} onsubmit={ask ? `return confirm(${JSON.stringify(ask)})` : undefined}>
      <input type="hidden" name="status" value={status} />
      <button class={primary ? primaryClass : buttonClass}>{label}</button>
    </form>
  );
}

export function bookingAdmin(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const size = opts.pageSize ?? 50;
  const links = nav(base, opts);
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  app.route("/types", typeRoutes(getDb, { ...opts, base: `${base}/types`, nav: links }));
  app.route("/people", peopleRoutes(getDb, { ...opts, base: `${base}/people`, nav: links }));

  // The status is read here and changed on the booking's page, where only the changes that make sense are offered.
  const spec: TableSpec<Row> = {
    id: "bookings",
    href: (r) => `${base}/${r.id}`,
    columns: [
      { label: "When", cell: (r) => <When at={r.starts_at} timeZone={opts.timeZone ?? r.time_zone} /> },
      { label: "Customer", cell: (r) => <>{r.name}<span class="block break-all text-label text-ink-2">{r.email}</span></> },
      { label: "Service", cell: (r) => r.type_name, class: "hidden sm:table-cell" },
      { label: "With", cell: (r) => r.resource_name, class: "hidden md:table-cell" },
      { label: "Status", cell: (r) => <StatusBadge value={r.status} options={BOOKING_STATUSES} /> },
    ],
  };

  app.get("/", async (c) => {
    const f = readFilter(c);
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await bookingsPage(getDb(c), f, after, size), size);
    const params = { q: f.q, when: f.when === "past" ? "past" : null, resource: f.resource, type: f.type, status: f.status };
    const self = listUrl(base, params);
    const more = (cur: string) => listUrl(base, { ...params, after: cur });
    if (isPartial(c) && after) return c.html(<TableRows spec={spec} rows={page} next={next} more={more} />);
    const results = (
      <div id="results">
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the start</a></p> : null}
        <DataTable spec={spec} caption={f.when === "past" ? "Past bookings, latest first" : "Upcoming bookings, soonest first"} rows={page} next={next} more={more}
          empty={f.q || f.resource || f.type || f.status ? <NoMatches clear={listUrl(base, { when: params.when })} /> : f.when === "past" ? "No past bookings yet." : (
            <EmptyState title="No upcoming bookings." action={<a href={`${base}/new`} class={primaryClass}>New booking</a>}>
              Times people book on your booking page, and the ones the team books for them, show here.
            </EmptyState>
          )} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const [people, types] = await Promise.all([allPeople(getDb(c)), allTypes(getDb(c))]);
    return framed(c, opts, links, base, { title: "Bookings", actions: <a href={`${base}/new`} class={primaryClass}>New booking</a> }, (
      <>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <SearchBar action={base} target="#results" q={f.q} placeholder="Name or email" filters={[
          { name: "when", label: "When", options: [{ value: "past", label: "Past" }], value: params.when, any: "Upcoming" },
          { name: "type", label: "Service", options: types.map((t) => ({ value: t.id, label: t.name })), value: f.type, any: "Any service" },
          { name: "resource", label: "With", options: people.map((r) => ({ value: r.id, label: r.name })), value: f.resource, any: "Anyone" },
          { name: "status", label: "Status", options: BOOKING_STATUSES, value: f.status, any: "Any status" },
        ]} />
        {results}
      </>
    ));
  });

  // ---- the week, and booking for someone ------------------------------------------

  const zoneOf = async (c: Context<{ Variables: TeamVars }>) => opts.timeZone ?? (await allPeople(getDb(c)))[0]?.time_zone ?? "UTC";

  app.get("/calendar", async (c) => {
    const d = getDb(c);
    const zone = await zoneOf(c);
    const people = await allPeople(d);
    const person = idParam(c.req.query("person"));
    const asked = c.req.query("week") ?? "";
    const today = localDate(new Date(), zone);
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today;
    const monday = addDays(anchor, -((weekdayOf(anchor) + 6) % 7));
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
    const from = dayBounds(days[0], zone).start.toISOString();
    const to = dayBounds(days[6], zone).end.toISOString();
    const rows = await d.sql<{ id: string; starts_at: Date; ends_at: Date; name: string; status: string; type_name: string; host: string; location_kind: Booking["location_kind"]; location: string | null }>`
      select b.id::text as id, b.starts_at, b.ends_at, b.name, b.status, t.name as type_name, r.name as host, b.location_kind, b.location
      from bookings b join booking_types t on t.id = b.type_id join resources r on r.id = b.resource_id
      where b.status <> 'cancelled' and b.starts_at < ${to}::timestamptz and b.ends_at > ${from}::timestamptz
        and (${person}::bigint is null or b.resource_id = ${person}::bigint)
      order by b.starts_at, b.id`;
    const off = await d.sql<{ name: string; starts_at: Date; ends_at: Date; note: string | null }>`
      select r.name, t.starts_at, t.ends_at, t.note from time_off t join resources r on r.id = t.resource_id
      where t.starts_at < ${to}::timestamptz and t.ends_at > ${from}::timestamptz
        and (${person}::bigint is null or t.resource_id = ${person}::bigint)
      order by t.starts_at`;
    const picked = person ? people.find((p) => p.id === person) : null;
    const more = opts.more ? await opts.more(c, { from, to }, picked ? { name: picked.name, email: picked.email ?? null } : null) : [];
    const self = (week: string) => listUrl(`${base}/calendar`, { week, person });
    const time = (t: Date) => formatTime(new Date(t), zone);
    const thisWeek = addDays(today, -((weekdayOf(today) + 6) % 7));
    const arrow = buttonClass + " px-2";
    return framed(c, opts, links, `${base}/calendar`, { title: "Calendar", actions: opts.calendarActions ?? <a href={`${base}/new`} class={primaryClass}>New booking</a> }, (
      <>
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <a href={self(addDays(monday, -7))} class={arrow} aria-label="Week before">&lsaquo;</a>
            {monday !== thisWeek ? <a href={self(today)} class={buttonClass}>This week</a> : null}
            <a href={self(addDays(monday, 7))} class={arrow} aria-label="Week after">&rsaquo;</a>
            <h2 class="ml-2 font-semibold">Week of {formatShortDate(monday, { long: true })}</h2>
          </div>
          <form method="get" action={`${base}/calendar`} class="flex items-center gap-2">
            <input type="hidden" name="week" value={monday} />
            <label>
              <span class="sr-only">Whose</span>
              <select name="person" onchange="this.form.submit()" class={controlClass}>
                <option value="">Everyone</option>
                {people.map((p) => <option value={p.id} selected={p.id === person}>{p.name}</option>)}
              </select>
            </label>
            <noscript><button class={buttonClass}>Show</button></noscript>
          </form>
        </div>
        <ol class="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {days.map((day) => {
            const b = dayBounds(day, zone);
            const on = (s: Date, e: Date | null) => new Date(s) < b.end && (e ? new Date(e) > b.start : new Date(s) >= b.start);
            const away = off.filter((t) => on(t.starts_at, t.ends_at));
            // Bookings and the app's own things, in one line by when they start.
            const items = [...rows.map((r): CalendarItem => ({
              starts_at: r.starts_at, ends_at: r.ends_at, href: `${base}/${r.id}`, name: r.name, what: `${r.type_name} with ${r.host}`,
              badge: r.status !== "confirmed" ? <StatusBadge value={r.status} options={BOOKING_STATUSES} /> : null, note: whereText(r, { link: true }),
            })), ...more].filter((m) => on(m.starts_at, m.ends_at)).sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime()).map((m) => (
              <li class="flex flex-wrap gap-x-4">
                <span class="w-36 shrink-0 whitespace-nowrap text-ink-2">{time(m.starts_at)}{m.ends_at ? ` – ${time(m.ends_at)}` : ""}</span>
                <span class="min-w-0">
                  <a href={m.href} class="font-semibold no-underline hover:underline">{m.name}</a>
                  <span class="text-ink-2"> · {m.what}</span>
                  {m.badge ? <> {m.badge}</> : null}
                  {m.note ? <span class="block break-words text-label text-ink-3">{m.note}</span> : null}
                </span>
              </li>
            ));
            return (
              <li class={"flex flex-col gap-2 px-4 py-3 sm:flex-row sm:gap-6 " + (day === today ? "bg-accent/5" : "")}>
                <h3 class={"w-36 shrink-0 text-label " + (day === today ? "font-semibold text-accent" : "font-semibold text-ink-2")}>
                  {formatShortDate(day)}{day === today ? " · Today" : ""}
                </h3>
                {items.length || away.length ? (
                  <ul class="flex min-w-0 flex-1 flex-col gap-2">
                    {away.map((t) => {
                      // Off all day, or from and to the times that fall on this day.
                      const s0 = new Date(t.starts_at), e0 = new Date(t.ends_at);
                      const allDay = s0 <= b.start && e0 >= b.end;
                      const span = allDay ? "all day" : `${s0 > b.start ? time(s0) : "until"}${s0 > b.start ? " to " : " "}${e0 < b.end ? time(e0) : "the end of the day"}`;
                      return <li class="text-label text-ink-2">{t.name} is off, {span}{t.note ? ` (${t.note})` : ""}</li>;
                    })}
                    {items}
                  </ul>
                ) : <p class="text-label text-ink-3">{opts.more ? "Nothing scheduled" : "Nothing booked"}</p>}
              </li>
            );
          })}
        </ol>
        <p class="mt-3 text-label text-ink-3">Times are in {zoneName(zone)}.</p>
      </>
    ));
  });

  // Who it is for travels with every link of the flow, so a team member who
  // starts from someone's page (the CRM's customer) never types them again.
  const forWhom = (c: Context<{ Variables: TeamVars }>, body?: Record<string, unknown>) => {
    const read = (k: string) => (body ? str(body[k]) : c.req.query(k) ?? "").slice(0, k === "address" || k === "notes" ? 2000 : 200);
    return { name: read("name"), email: read("email"), phone: read("phone"), address: read("address") };
  };
  const carry = (w: Record<string, string>, extra: Record<string, string | null | undefined> = {}) => ({ ...w, ...extra });

  app.get("/new", async (c) => {
    const w = forWhom(c);
    const types = await bookableTypes(getDb(c));
    return framed(c, opts, links, base, { title: w.name ? `Book a time for ${w.name}` : "New booking", back: { href: base, label: "Bookings" } }, (
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
                    <span class="block text-label text-ink-2">{durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}</span>
                    {t.description ? <span class="mt-1 block text-label text-ink-3">{t.description}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : <EmptyCard title="Nothing can be booked yet." action={<a href={`${base}/types/new`} class={primaryClass}>New service</a>}>A booking is for a service: an estimate visit, a consultation, a video call.</EmptyCard>}
      </>
    ));
  });

  async function pickTime(c: Context<{ Variables: TeamVars }>, t: BookingType) {
    const d = getDb(c);
    const w = forWhom(c);
    const hosts = await hostsOf(d, t.id);
    const host = hosts.find((h) => h.id === c.req.query("host")) ?? null;
    const zone = opts.timeZone ?? host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const days = await upcoming(d, t, zone, 60, host ? { hosts: [host.id] } : {});
    const keys = [...days.keys()];
    const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
    const here = (extra: Record<string, string | null | undefined>) => listUrl(`${base}/new/${t.id}`, carry(w, { host: host?.id, ...extra }));
    return framed(c, opts, links, base, {
      title: `${t.name}${w.name ? ` for ${w.name}` : ""}`,
      back: { href: listUrl(`${base}/new`, w), label: "Choose another service" },
      sub: <p>{durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}</p>,
    }, (
      <div class="rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
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
        <p class="mt-5 text-label text-ink-3">Times are in {zoneName(zone)}.</p>
      </div>
    ));
  }

  async function confirmTeam(c: Context<{ Variables: TeamVars }>, t: BookingType, values: Record<string, string>, errors: Errors = {}, notice?: string) {
    const hosts = await hostsOf(getDb(c), t.id);
    const host = hosts.find((h) => h.id === values.host) ?? null;
    const zone = opts.timeZone ?? host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const start = new Date(values.start);
    if (Number.isNaN(start.getTime())) return c.redirect(listUrl(`${base}/new/${t.id}`, forWhom(c)), 303);
    const end = new Date(start.getTime() + t.duration_min * 60_000);
    const local = localDate(start, zone);
    return framed(c, opts, links, base, {
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
          {t.location_kind === "their_place" ? <Input label="Address" name="address" value={values.address} errors={errors} required class="sm:col-span-2" /> : null}
          <label class={fieldClass + " sm:col-span-2"}>Notes
            <textarea name="notes" rows={2} maxlength={2000} class={controlClass}>{values.notes ?? ""}</textarea>
          </label>
          <div class="sm:col-span-2"><button class={primaryClass}>Book it</button></div>
        </form>
      </div>
    ), Object.keys(errors).length || notice ? 422 : 200);
  }

  const loadType = async (c: Context<{ Variables: TeamVars }>) => {
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
      phone: values.phone || null, address: values.address || null, answers: notes ? { notes } : {}, source: opts.source,
    });
    if (!r.ok && r.reason === "invalid") return confirmTeam(c, t, values, r.errors);
    if (!r.ok) return confirmTeam(c, t, values, {}, "That time was just taken. Go back and pick another.");
    const host = await resourceById(getDb(c), r.booking.resource_id);
    if (host && opts.onBooked) {
      const manageUrl = opts.manageBase ? `${opts.manageBase.replace(/\/+$/, "")}/manage/${r.token}` : null;
      try {
        await opts.onBooked(c, { event: "booked", booking: r.booking, type: t, host, manageUrl });
      } catch (err) {
        console.error("booking: onBooked failed:", err);
      }
    }
    return c.redirect(withFlash(`${base}/${r.booking.id}`, "booked"), 303);
  });

  app.get("/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const d = getDb(c);
    const [raw] = await d.sql`select * from bookings where id = ${id}::bigint`;
    if (!raw) return c.notFound();
    const b = toBooking(raw);
    const [who, type] = await Promise.all([resourceById(d, b.resource_id), typeById(d, b.type_id)]);
    const zone = opts.timeZone ?? who?.time_zone ?? "UTC";
    const self = `${base}/${b.id}`;
    const extra = opts.extra ? await opts.extra(c, b) : null;
    const started = b.starts_at <= new Date();
    const action = `${self}/status`;
    // Only the changes that can happen: completed and no-show once it has started; a cancelled one stays cancelled.
    const actions = b.status === "cancelled" ? null : (
      <>
        {b.status === "confirmed" && started ? <StatusButton action={action} status="completed" label="Mark completed" primary /> : null}
        {started && b.status !== "no_show" ? <StatusButton action={action} status="no_show" label="Mark no-show" /> : null}
        {started && b.status === "no_show" ? <StatusButton action={action} status="completed" label="Mark completed" /> : null}
        {b.status === "confirmed" && !started ? <a href={`${self}/reschedule`} class={buttonClass}>Reschedule</a> : null}
        {b.status === "confirmed" ? <StatusButton action={action} status="cancelled" label="Cancel booking" ask="Cancel this booking? They are told, and it cannot be undone." /> : null}
      </>
    );
    const { notes, ...rest } = b.answers as Record<string, unknown>;
    return framed(c, opts, links, base, {
      title: b.name,
      back: { href: base, label: "Bookings" },
      sub: (
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge value={b.status} options={BOOKING_STATUSES} />
          <span>{type?.name ?? "Booking"}{who ? ` with ${who.name}` : ""}</span>
        </p>
      ),
      actions,
    }, (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex flex-col gap-4 md:col-span-2">
            <Section title="Details">
              <FieldList fields={[
                { label: "When", value: formatSlot({ start: b.starts_at, end: b.ends_at }, zone) },
                ...(b.booker_time_zone && b.booker_time_zone !== zone ? [{ label: "Their time", value: formatSlot({ start: b.starts_at, end: b.ends_at }, b.booker_time_zone) }] : []),
                { label: "Where", value: whereText(b, { link: true }) },
                { label: "Email", value: <a href={`mailto:${b.email}`} class="break-all">{b.email}</a> },
                ...(b.phone ? [{ label: "Phone", value: <a href={`tel:${b.phone.replace(/[^0-9+]/g, "")}`}>{b.phone}</a> }] : []),
                ...(typeof notes === "string" && notes ? [{ label: "Notes", value: <span class="whitespace-pre-wrap">{notes}</span> }] : []),
              ]} />
            </Section>
            {Object.keys(rest).length ? <Section title="Their answers"><JsonData data={rest} /></Section> : null}
          </div>
          <div class="flex flex-col gap-4">{extra}</div>
        </div>
        <p class="mt-6 border-t border-line pt-3 text-label text-ink-3">
          Booked <When at={b.created_at} timeZone={zone} />
          {b.updated_by ? <>. Changed <When at={b.updated_at} timeZone={zone} /> by {b.updated_by}</> : null}
          {b.external_event_id ? ". In the calendar" : null}.
        </p>
      </>
    ));
  });

  // Reschedule: another open time of the same service, with the same person or another who takes it.
  async function moveable(c: Team, picked?: unknown) {
    const id = idParam(c.req.param("id"));
    const [raw] = id ? await getDb(c).sql`select * from bookings where id = ${id}::bigint` : [];
    if (!raw) return null;
    const b = toBooking(raw);
    const [type, hosts] = await Promise.all([typeById(getDb(c), b.type_id), hostsOf(getDb(c), b.type_id)]);
    const current = await resourceById(getDb(c), b.resource_id);
    const host = hosts.find((h) => h.id === (picked ?? c.req.query("host"))) ?? current;
    return type && host && current ? { b, type, host, current, hosts, zone: opts.timeZone ?? host.time_zone } : null;
  }

  async function reschedulePage(c: Team, m: NonNullable<Awaited<ReturnType<typeof moveable>>>, notice?: string) {
    const { b, type, host, current, hosts, zone } = m;
    const self = `${base}/${b.id}`;
    if (b.status !== "confirmed" || b.starts_at <= new Date()) return c.redirect(withFlash(self, "unchanged"), 303);
    const days = await upcoming(getDb(c), type, zone, 60, { hosts: [host.id], exceptBooking: b.id });
    const keys = [...days.keys()];
    const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
    const others = hosts.some((h) => h.id !== current.id);
    const hostParam = host.id === current.id ? null : host.id;
    return framed(c, opts, links, base, {
      title: `Reschedule ${b.name}`,
      back: { href: self, label: b.name },
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
        <p class="mt-5 text-label text-ink-3">Times are in {zoneName(zone)}. {b.name} is told the new time.</p>
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
    if (!r.ok) return c.redirect(withFlash(`${base}/${m.b.id}`, "unchanged"), 303);
    if (opts.onBooked) {
      // The booker hears of the move as they would of their own; their manage link still works, but only its hash is kept here.
      try {
        await opts.onBooked(c, { event: "rescheduled", booking: r.booking, type: m.type, host: m.host, manageUrl: null });
      } catch (err) {
        console.error("booking: onBooked failed:", err);
      }
    }
    return c.redirect(withFlash(`${base}/${m.b.id}`, "rescheduled"), 303);
  });

  app.post("/:id/status", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const ret = localPath(str(body.return), base, `${base}/${id}`);
    const status = pickStatus(body.status, BOOKING_STATUSES);
    if (!status) return c.text("Choose one of the listed statuses.", 400);
    const changed = status === "confirmed" ? null : await setStatus(getDb(c), id, status as Exclude<Booking["status"], "confirmed">, c.get("user"));
    // A cancel the team makes is told to the booker, as one they make themselves is.
    if (changed && status === "cancelled" && opts.onBooked) {
      const [type, host] = await Promise.all([typeById(getDb(c), changed.type_id), resourceById(getDb(c), changed.resource_id)]);
      try {
        if (type && host) await opts.onBooked(c, { event: "cancelled", booking: changed, type, host, manageUrl: null });
      } catch (err) {
        console.error("booking: onBooked failed:", err);
      }
    }
    return c.redirect(withFlash(ret, changed ? (status === "cancelled" ? "cancelled" : "status") : "unchanged"), 303);
  });

  return app;
}

// ---- the availability editor ---------------------------------------------------------

const Err = ({ id, text }: { id: string; text?: string }) => (text ? <span id={id} class="text-label font-semibold text-ink">{text}</span> : null);
const Hint = ({ text }: { text?: string }) => (text ? <span class="text-label font-normal text-ink-3">{text}</span> : null);

/** A labelled input; `before` and `after` sit inside its edge, as "/book/" before an address and "minutes" after a length. */
function Input(p: {
  label: string; name: string; value?: string | number | null; type?: string; errors?: Errors; hint?: string; required?: boolean;
  min?: number; max?: number; class?: string; placeholder?: string; before?: string; after?: string;
}) {
  const err = p.errors?.[p.name];
  const input = (
    <input name={p.name} type={p.type ?? "text"} value={p.value === null || p.value === undefined ? "" : String(p.value)} required={p.required} min={p.min} max={p.max}
      placeholder={p.placeholder} aria-invalid={err ? "true" : undefined} aria-describedby={err ? `${p.name}-error` : undefined}
      class={controlClass + (p.before || p.after ? " min-w-0 flex-1 border-0 shadow-none focus-visible:outline-0" : " w-full")} />
  );
  return (
    <label class={fieldClass + " " + (p.class ?? "")}>
      {p.label}
      {p.before || p.after ? (
        // One edge around the text and the input; the focus ring is the whole field's.
        <span class="flex items-center rounded-control border border-line-strong bg-surface font-normal shadow-card focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
          {p.before ? <span class="whitespace-nowrap pl-2.5 text-ink-3">{p.before}</span> : null}
          {input}
          {p.after ? <span class="whitespace-nowrap pr-2.5 text-ink-3">{p.after}</span> : null}
        </span>
      ) : input}
      <Hint text={p.hint} />
      <Err id={`${p.name}-error`} text={err} />
    </label>
  );
}

/** A choice from a short list; a value set some other way (by the AI, an import) stays offered. */
function Choice(p: { label: string; name: string; value: string; options: [string, string][]; errors?: Errors; hint?: string; class?: string }) {
  const err = p.errors?.[p.name];
  const options = p.options.some(([v]) => v === p.value) || !p.value ? p.options : [...p.options, [p.value, p.value] as [string, string]];
  return (
    <label class={fieldClass + " " + (p.class ?? "")}>
      {p.label}
      <select name={p.name} aria-invalid={err ? "true" : undefined} aria-describedby={err ? `${p.name}-error` : undefined} class={controlClass + " w-full"}>
        {options.map(([v, text]) => <option value={v} selected={v === p.value}>{text}</option>)}
      </select>
      <Hint text={p.hint} />
      <Err id={`${p.name}-error`} text={err} />
    </label>
  );
}

const minutes = (list: number[]): [string, string][] => list.map((m) => [String(m), durationText(m)]);
const LENGTHS = minutes([15, 20, 30, 45, 60, 90, 120, 180, 240]);
const NOTICE: [string, string][] = [["0", "None"], ["60", "1 hour"], ["120", "2 hours"], ["240", "4 hours"], ["1440", "1 day"], ["2880", "2 days"], ["10080", "1 week"]];
const AHEAD: [string, string][] = [["7", "1 week"], ["14", "2 weeks"], ["30", "30 days"], ["60", "60 days"], ["90", "90 days"], ["180", "6 months"], ["365", "1 year"]];

/** 12:00 AM to 11:30 PM in half hours, and midnight at the end of the day for an end. */
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const clock = (hhmm: string) => {
  if (hhmm === "24:00") return "Midnight";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const one = (x: unknown) => (Array.isArray(x) ? x[x.length - 1] : x); // a re-rendered body may hold arrays
const valueOf = (r: Record<string, unknown>) => (k: string) => (one(r[k]) === null || one(r[k]) === undefined ? "" : String(one(r[k])));
const Active = ({ value, label, hint }: { value: unknown; label: string; hint?: string }) => (
  <label class="flex items-start gap-3 sm:col-span-2">
    <input type="hidden" name="active" value="0" />
    <input type="checkbox" name="active" value="1" checked={one(value) !== false && one(value) !== "0"} class="mt-1 size-4" />
    <span class="flex flex-col">
      <span class="font-semibold">{label}</span>
      <Hint text={hint} />
    </span>
  </label>
);

/** The fields of a booking rule; open when one of them is wrong, so its message shows. */
const RULES = ["interval_min", "buffer_before_min", "buffer_after_min", "min_notice_min", "horizon_days", "position", "currency", "slug"];

/** A service's fields; the same form adds one. The address or link shows only for a place of ours or a video call. */
function TypeForm({ action, t, errors = {}, submit, publicBase }: { action: string; t: Record<string, unknown>; errors?: Errors; submit: string; publicBase?: string }) {
  const v = valueOf(t);
  const kind = v("location_kind") || "their_place";
  const rulesOpen = RULES.some((k) => errors[k]);
  const at = (k: string, fallback: string) => v(k) || fallback;
  return (
    <form method="post" action={action} class="grid gap-x-4 gap-y-5 sm:grid-cols-2">
      <Input label="Name" name="name" value={v("name")} errors={errors} required placeholder="Installation estimate" class="sm:col-span-2" />
      <label class={fieldClass + " sm:col-span-2"}>
        Description
        <textarea name="description" rows={2} maxlength={2000} placeholder="What it is, shown on the booking page." class={controlClass + " font-normal"}>{v("description")}</textarea>
      </label>
      <Choice label="Length" name="duration_min" value={at("duration_min", "60")} options={LENGTHS} errors={errors} />
      <Input label="Price" name="price" value={v("price") || (t.price_cents != null ? amountText(Number(t.price_cents), String(t.currency ?? "usd")) : "")} errors={errors}
        before={(v("currency") || "usd").toUpperCase()} placeholder="Free" hint="Charged only when it is booked through a form with a payment step." />
      <label class={fieldClass}>
        Where it happens
        <select name="location_kind" class={controlClass + " w-full"} aria-invalid={errors.location_kind ? "true" : undefined}>
          {LOCATION_KINDS.map((k) => <option value={k} selected={k === kind}>{LOCATION_LABELS[k]}</option>)}
        </select>
        <Err id="location_kind-error" text={errors.location_kind} />
      </label>
      {/* Only a place of ours or a video call needs one: the customer gives their own address or number. */}
      <div class="[form:has(option[value=phone]:checked)_&]:hidden [form:has(option[value^=their]:checked)_&]:hidden">
        <Input label="Address or meeting link" name="location" value={v("location")} errors={errors} placeholder="123 Main St, or https://meet…" />
      </div>
      <details open={rulesOpen} class="group rounded-card border border-line sm:col-span-2">
        <summary class="cursor-pointer list-none px-4 py-3 font-semibold">
          Scheduling rules <span class="font-normal text-ink-3">· start times, gaps, notice</span>
        </summary>
        <div class="grid gap-x-4 gap-y-5 border-t border-line p-4 sm:grid-cols-2">
          <Choice label="Start times every" name="interval_min" value={at("interval_min", "30")} options={minutes([10, 15, 20, 30, 45, 60, 90, 120])} errors={errors} />
          <Choice label="Booking notice" name="min_notice_min" value={at("min_notice_min", "120")} options={NOTICE} errors={errors} hint="How soon a customer can book." />
          <Input label="Gap before" name="buffer_before_min" type="number" min={0} max={1440} value={at("buffer_before_min", "0")} errors={errors} after="minutes" hint="Travel or set-up time." />
          <Input label="Gap after" name="buffer_after_min" type="number" min={0} max={1440} value={at("buffer_after_min", "0")} errors={errors} after="minutes" />
          <Choice label="Bookable up to" name="horizon_days" value={at("horizon_days", "60")} options={AHEAD} errors={errors} hint="How far ahead." />
          <Input label="Booking page address" name="slug" value={v("slug")} errors={errors} before={publicBase ? `${publicBase.replace(/^https?:\/\//, "")}/` : "/book/"}
            placeholder="made from the name" />
          <Input label="Order on the booking page" name="position" type="number" min={0} value={at("position", "0")} errors={errors} />
          <Input label="Currency" name="currency" value={at("currency", "usd")} errors={errors} hint="Like usd." />
        </div>
      </details>
      <Active value={t.active} label="Can be booked" hint="Off hides it from the booking page; bookings already made stay." />
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
      <select name="time_zone" required aria-invalid={err ? "true" : undefined} aria-describedby={err ? "time_zone-error" : undefined} class={controlClass + " w-full min-w-0"}>
        <optgroup label="Common">{common.map(option)}</optgroup>
        <optgroup label="Everywhere else">{rest.map(option)}</optgroup>
      </select>
      <Hint text="Their weekly hours are in this zone." />
      <Err id="time_zone-error" text={err} />
    </label>
  );
}

/** A person's details; the same form adds one, starting in `zone` (the business's). */
function PersonForm({ action, r, errors = {}, submit, zone }: { action: string; r: Record<string, unknown>; errors?: Errors; submit: string; zone: string }) {
  const v = valueOf(r);
  return (
    <form method="post" action={action} class="grid gap-x-4 gap-y-5 sm:grid-cols-2">
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
});
const personFields = (body: Record<string, unknown>): PersonFields => ({
  name: str(body.name), email: str(body.email), time_zone: str(body.time_zone), active: str(one(body.active)),
});

type Team = Context<{ Variables: TeamVars }>;

/** A list of records, each a row that opens it: the services, the team. */
const rowCard = "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 no-underline hover:bg-canvas";

/** Services: each one's length, where it happens, its price and who takes it. */
export function typeRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "Services" }];
  const bookingBase = base.replace(/\/types$/, "");
  const peopleBase = `${bookingBase}/people`;
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const layout = (c: Team, head: Head, body: Child, status = 200) => framed(c, opts, links, base, head, body, status);
  // The booking pages' address, for the page address field and the link to a service's page.
  const publicBase = opts.manageBase?.replace(/\/+$/, "");

  app.get("/", async (c) => {
    const d = getDb(c);
    const types = await allTypes(d);
    const hosts = await Promise.all(types.map((t) => hostsOf(d, t.id, { all: true })));
    return layout(c, { title: "Services", actions: <a href={`${base}/new`} class={primaryClass}>New service</a> }, (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        {types.length ? (
          <ul class="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {types.map((t, i) => (
              <li>
                <a href={`${base}/${t.id}`} class={rowCard}>
                  <span class="min-w-0">
                    <span class="block font-semibold">{t.name}</span>
                    <span class="block text-label text-ink-2">
                      {durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}
                      {t.price_cents ? ` · ${amountText(t.price_cents, t.currency ?? "usd")} ${(t.currency ?? "usd").toUpperCase()}` : ""}
                    </span>
                  </span>
                  <span class="flex flex-wrap items-center gap-2 text-label text-ink-2">
                    {hosts[i].length ? hosts[i].map((h) => h.name).join(", ") : <span class="text-ink">Nobody takes it yet</span>}
                    {t.active ? null : <StatusBadge value="off" options={[{ value: "off", label: "Not bookable", tone: "muted" }]} />}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : <EmptyCard title="No services yet.">A service is what people book: an estimate visit, a consultation, a video call. Make one with New service.</EmptyCard>}
      </>
    ));
  });

  const newPage = (c: Team, values: Record<string, unknown> = {}, errors: Errors = {}) =>
    layout(c, { title: "New service", back: { href: base, label: "Services" } }, (
      <div class="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        <TypeForm action={base} t={values} errors={errors} submit="Create service" publicBase={publicBase} />
      </div>
    ), Object.keys(errors).length ? 422 : 200);

  async function editPage(c: Team, t: BookingType, problems: { values?: Record<string, unknown>; errors?: Errors } = {}) {
    const d = getDb(c);
    const [hosts, people] = await Promise.all([hostsOf(d, t.id, { all: true }), allPeople(d)]);
    const self = `${base}/${t.id}`;
    return layout(c, {
      title: t.name,
      back: { href: base, label: "Services" },
      sub: <p>{durationText(t.duration_min)} · {LOCATION_LABELS[t.location_kind]}{t.active ? "" : " · Not bookable"}</p>,
      actions: (
        <>
          {publicBase && t.active ? <a href={`${publicBase}/${t.slug}`} target="_blank" rel="noopener" class={buttonClass}>View booking page</a> : null}
          {t.active ? <a href={`${bookingBase}/new/${t.id}`} class={buttonClass}>New booking</a> : null}
        </>
      ),
    }, (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <Section title="Details" class="md:col-span-2">
            <TypeForm action={self} t={problems.values ?? t} errors={problems.errors} submit="Save" publicBase={publicBase} />
          </Section>
          <Section title="Who takes it" class="self-start">
            {people.length ? (
              <form method="post" action={`${self}/hosts`} class="flex flex-col gap-3">
                <p class="text-label text-ink-3">Customers pick one, or take whoever is free.</p>
                {people.map((p) => (
                  <label class="flex items-center gap-3">
                    <input type="checkbox" name="host" value={p.id} checked={hosts.some((h) => h.id === p.id)} class="size-4" />
                    <span>{p.name}{p.active ? null : <span class="text-label text-ink-3"> · not taking bookings</span>}</span>
                  </label>
                ))}
                <div><button class={buttonClass}>Save</button></div>
              </form>
            ) : (
              <p class="text-ink-2">Nobody is on the team yet. <a href={`${peopleBase}/new`}>Add a person</a></p>
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

/** The team who take bookings: each one's weekly hours, time off, calendars and services. */
export function peopleRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "Team" }];
  const typesBase = base.replace(/\/people$/, "/types");
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const layout = (c: Team, head: Head, body: Child, status = 200) => framed(c, opts, links, base, head, body, status);
  const calendarsOn = opts.calendars !== false;

  app.get("/", async (c) => {
    const d = getDb(c);
    const all = await allPeople(d);
    const [hours, cals] = await Promise.all([Promise.all(all.map((r) => weeklyHours(d, r.id))), calendarsOn ? calendars(d) : []]);
    return layout(c, { title: "Team", actions: <a href={`${base}/new`} class={primaryClass}>Add team member</a> }, (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        {all.length ? (
          <ul class="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {all.map((r, i) => {
              const mine = cals.filter((k) => k.resource_id === r.id);
              const failed = mine.find((k) => k.last_error);
              return (
                <li>
                  <a href={`${base}/${r.id}`} class={rowCard}>
                    <span class="min-w-0">
                      <span class="block font-semibold">{r.name}</span>
                      <span class="block text-label text-ink-2">{hoursLine(hours[i]) || "No hours set"} · {zoneName(r.time_zone)}</span>
                    </span>
                    <span class="flex flex-wrap items-center gap-2 text-label text-ink-2">
                      {calendarsOn ? (failed ? <span class="font-semibold text-ink">Calendar sync failed</span> : mine.length ? `${mine[0].provider === "google" ? "Google" : "Microsoft"} calendar` : "No calendar") : null}
                      {r.active ? null : <StatusBadge value="off" options={[{ value: "off", label: "Not taking bookings", tone: "muted" }]} />}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : <EmptyCard title="Nobody takes bookings yet.">Each person on the team has their own hours and calendar. Start with Add team member.</EmptyCard>}
      </>
    ));
  });

  const newPage = async (c: Team, values: Record<string, unknown> = {}, errors: Errors = {}) => {
    const all = await allPeople(getDb(c));
    return layout(c, { title: "Add team member", back: { href: base, label: "Team" } }, (
      <div class="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
        <PersonForm action={base} r={values} errors={errors} submit="Add team member" zone={opts.timeZone ?? all[0]?.time_zone ?? "UTC"} />
      </div>
    ), Object.keys(errors).length ? 422 : 200);
  };

  async function editPage(c: Team, r: Resource, problems: { details?: { values: Record<string, unknown>; errors: Errors }; hours?: Errors; timeOff?: Errors; calendar?: Errors } = {}) {
    const d = getDb(c);
    const [hours, off, cals, takes] = await Promise.all([weeklyHours(d, r.id), timeOffList(d, r.id), calendarsOn ? calendars(d, r.id) : [], typesHostedBy(d, r.id)]);
    const self = `${base}/${r.id}`;
    const failed = Object.values(problems).some(Boolean);
    const today = localDate(new Date(), r.time_zone);
    const remove = "rounded-control px-1 text-ink-3 no-underline hover:bg-panel hover:text-ink";
    return layout(c, {
      title: r.name,
      back: { href: base, label: "Team" },
      sub: <p>{zoneName(r.time_zone)}{r.email ? ` · ${r.email}` : ""}{r.active ? "" : " · Not taking bookings"}</p>,
    }, (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Weekly hours">
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
                    <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <When at={t.starts_at} timeZone={r.time_zone} /> – <When at={t.ends_at} timeZone={r.time_zone} />
                        {t.note ? <span class="text-ink-2"> · {t.note}</span> : null}
                      </span>
                      <form method="post" action={`${self}/time-off/${t.id}/delete`}><button class={remove} aria-label="Remove this time off" title="Remove">&times;</button></form>
                    </li>
                  ))}
                </ul>
              ) : <p class="mb-4 text-ink-3">None coming up.</p>}
              <form method="post" action={`${self}/time-off`} class="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <Input label="From" name="starts" type="datetime-local" value={`${today}T00:00`} errors={problems.timeOff} />
                <Input label="Until" name="ends" type="datetime-local" value={`${today}T23:59`} errors={problems.timeOff} />
                <Input label="Note" name="note" errors={problems.timeOff} placeholder="Vacation" />
                <button class={buttonClass}>Add time off</button>
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
                  {takes.map((t) => <li><a href={`${typesBase}/${t.id}`}>{t.name}</a></li>)}
                </ul>
              ) : <p class="text-ink-2">None yet. Choose who takes each one under <a href={typesBase}>Services</a>.</p>}
            </Section>

            {calendarsOn ? (
              <section id="calendars">
                <Section title="Calendars">
                  {cals.length ? (
                    <ul class="mb-4 flex flex-col gap-2">
                      {cals.map((k) => (
                        <li class="flex items-start justify-between gap-2">
                          <span class="min-w-0">
                            <span class="block break-all">{k.provider === "google" ? "Google" : "Microsoft"} · {k.external_id}</span>
                            <span class="block text-label text-ink-3">
                              {k.last_error ? <span class="font-semibold text-ink">Sync failed: {k.last_error}</span> : k.last_synced_at ? <>Synced <When at={k.last_synced_at} timeZone={r.time_zone} /></> : "Not synced yet"}
                            </span>
                          </span>
                          <form method="post" action={`${self}/calendars/${k.id}/delete`}><button class={remove} aria-label="Remove this calendar" title="Remove">&times;</button></form>
                        </li>
                      ))}
                    </ul>
                  ) : <p class="mb-4 text-label text-ink-3">Busy times in their calendar close those times here, and new bookings go into it.</p>}
                  <form method="post" action={`${self}/calendars`} class="flex flex-col gap-3">
                    <Choice label="Calendar" name="provider" value="google" options={[["google", "Google"], ["microsoft", "Microsoft"]]} errors={problems.calendar} />
                    <Input label="Which one" name="external_id" value="primary" errors={problems.calendar} hint="primary is their main calendar." />
                    <div><button class={buttonClass}>Add calendar</button></div>
                  </form>
                </Section>
              </section>
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

  app.post("/:id/calendars", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const body = await c.req.parseBody();
    const saved = await addCalendar(getDb(c), r.id, body.provider, body.external_id, c.get("user"));
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
