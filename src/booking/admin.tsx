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
import { Flash, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { cut, readCursor, type Cursor, type Keyed } from "../admin/keyset";
import { AdminLayout, type NavItem } from "../admin/layout";
import { DataTable, SearchBar, TableRow, TableRows, When, type TableSpec } from "../admin/list";
import { idParam, isPartial, likePattern, listUrl, localPath, str } from "../admin/query";
import { buttonClass, controlClass, pickStatus, StatusBadge, StatusForm, type StatusOption } from "../admin/status";
import { book, bookableTypes, hostsOf, LOCATION_KINDS, resourceById, setStatus, toBooking, typeById, whereText, type Booking, type BookingType, type Resource } from "./book";
import {
  addCalendar, addTimeOff, addWindow, allPeople, allTypes, calendars, createPerson, createType, LOCATION_LABELS, removeCalendar,
  removeTimeOff, removeWindow, savePerson, saveType, setHosts, timeOffList, typesHostedBy, weeklyHours, WEEKDAYS,
  type Errors, type PersonFields, type TypeFields,
} from "./hours";
import { addDays, dayBounds, formatDate, formatSlot, formatTime, localDate, weekdayOf } from "./slots";
import { chip, DayPicker, upcoming } from "./public";
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
  /** The zone the Schedule shows; the first person's when absent. */
  timeZone?: string;
  /**
   * The public booking pages' address, absolute ("https://acme.com/book"), so
   * a booking the team makes gets a manage link the booker can use. Without
   * it the confirmation says to reply instead.
   */
  manageBase?: string;
  /** After the team books for someone: send the confirmation here (notify.ts). Never throws into the response. */
  onBooked?: (c: Context<{ Variables: TeamVars }>, e: BookingNotice) => void | Promise<void>;
  /** More on a booking's page, beside its status: the CRM's customer and "Make it a job". */
  extra?: (c: Context<{ Variables: TeamVars }>, b: Booking) => Child | Promise<Child>;
};

export type Frame = (p: { title: string; user: string; children: Child }) => Child;

/** The page: in the app's own frame with the booking sections on top, or AdminLayout with them as its nav. */
function framed(c: Context<{ Variables: TeamVars }>, opts: BookingAdminOptions, links: NavItem[], current: string, title: string, body: Child, status = 200) {
  const user = c.get("user");
  if (!opts.Frame) {
    return c.html(<AdminLayout title={title} css={opts.css} nav={links} current={current} user={user}>{body}</AdminLayout>, status as 200);
  }
  const sections = (
    <nav aria-label="Booking" class="mb-4 flex flex-wrap gap-1 text-label">
      {links.map((n) => (
        <a href={n.href} aria-current={current === n.href ? "page" : undefined}
          class={"rounded-control px-2 py-1 no-underline " + (current === n.href ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>
          {n.label}
        </a>
      ))}
    </nav>
  );
  return c.html(<>{opts.Frame({ title, user, children: <>{sections}{body}</> })}</>, status as 200);
}

export const BOOKING_STATUSES: StatusOption[] = [
  { value: "confirmed", label: "Confirmed", tone: "accent" },
  { value: "completed", label: "Completed", tone: "neutral" },
  { value: "no_show", label: "No-show", tone: "strong" },
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
  created: "Added. Now set the weekly hours.",
  "type-created": "Added. Now choose who takes it.",
  booked: "Booked.",
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

function nav(base: string, opts: BookingAdminOptions): NavItem[] {
  return opts.nav ?? [
    { href: base, label: "Bookings" },
    { href: `${base}/schedule`, label: "Schedule" },
    { href: `${base}/types`, label: "What can be booked" },
    { href: `${base}/people`, label: "People and hours" },
    ...(opts.calendars === false ? [] : [{ href: `${base}/calendars`, label: "Calendars" }]),
  ];
}

/** The status control: a form while it can still change, a badge once cancelled. */
function StatusCell({ row, action, returnTo, swap }: { row: { status: string; name: string }; action: string; returnTo: string; swap?: string }) {
  if (row.status === "cancelled") return <StatusBadge value="cancelled" options={BOOKING_STATUSES} />;
  return <StatusForm action={action} current={row.status} options={BOOKING_STATUSES} returnTo={returnTo} label={`Status of ${row.name}'s booking`} swap={swap} />;
}

export function bookingAdmin(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const size = opts.pageSize ?? 50;
  const links = nav(base, opts);
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  app.route("/types", typeRoutes(getDb, { ...opts, base: `${base}/types`, nav: links }));
  app.route("/people", peopleRoutes(getDb, { ...opts, base: `${base}/people`, nav: links }));

  const spec = (returnTo: string): TableSpec<Row> => ({
    id: "bookings",
    href: (r) => `${base}/${r.id}`,
    columns: [
      { label: "When", cell: (r) => <When at={r.starts_at} timeZone={r.time_zone} /> },
      { label: "Name", cell: (r) => r.name },
      { label: "What", cell: (r) => r.type_name, class: "hidden sm:table-cell" },
      { label: "Email", cell: (r) => r.email, class: "hidden md:table-cell" },
      { label: "With", cell: (r) => r.resource_name, class: "hidden sm:table-cell" },
      { label: "Status", cell: (r) => <StatusCell row={r} action={`${base}/${r.id}/status`} returnTo={returnTo} swap="closest tr" /> },
    ],
  });

  app.get("/", async (c) => {
    const f = readFilter(c);
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await bookingsPage(getDb(c), f, after, size), size);
    const params = { q: f.q, when: f.when === "past" ? "past" : null, resource: f.resource, type: f.type, status: f.status };
    const self = listUrl(base, params);
    const more = (cur: string) => listUrl(base, { ...params, after: cur });
    const s = spec(self);
    if (isPartial(c) && after) return c.html(<TableRows spec={s} rows={page} next={next} more={more} />);
    const results = (
      <div id="results">
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the start</a></p> : null}
        <DataTable spec={s} caption={f.when === "past" ? "Past bookings, latest first" : "Upcoming bookings, soonest first"} rows={page} next={next} more={more}
          empty={f.q || f.resource || f.type || f.status ? <>Nothing matches these filters. <a href={listUrl(base, { when: params.when })}>Clear filters</a></> : f.when === "past" ? "No past bookings yet." : "No upcoming bookings."} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const [people, types] = await Promise.all([allPeople(getDb(c)), allTypes(getDb(c))]);
    return framed(c, opts, links, base, "Bookings", (
      <>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <p class="mb-3"><a href={`${base}/new`} class={buttonClass + " no-underline"}>Book for someone</a></p>
        <SearchBar action={base} target="#results" q={f.q} placeholder="Name or email" filters={[
          { name: "when", label: "When", options: [{ value: "past", label: "Past" }], value: params.when, any: "Upcoming" },
          { name: "type", label: "What", options: types.map((t) => ({ value: t.id, label: t.name })), value: f.type, any: "Anything" },
          { name: "resource", label: "With", options: people.map((r) => ({ value: r.id, label: r.name })), value: f.resource, any: "Anyone" },
          { name: "status", label: "Status", options: BOOKING_STATUSES, value: f.status, any: "Any status" },
        ]} />
        {results}
      </>
    ));
  });

  // ---- the week, and booking for someone ------------------------------------------

  const zoneOf = async (c: Context<{ Variables: TeamVars }>) => opts.timeZone ?? (await allPeople(getDb(c)))[0]?.time_zone ?? "UTC";

  app.get("/schedule", async (c) => {
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
    const self = (week: string) => listUrl(`${base}/schedule`, { week, person });
    const time = (t: Date) => formatTime(new Date(t), zone);
    return framed(c, opts, links, `${base}/schedule`, "Schedule", (
      <>
        <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
          <form method="get" action={`${base}/schedule`} class="flex flex-wrap items-end gap-2">
            <input type="hidden" name="week" value={monday} />
            <label class={fieldClass}>Whose
              <select name="person" class={controlClass}>
                <option value="">Everyone</option>
                {people.map((p) => <option value={p.id} selected={p.id === person}>{p.name}</option>)}
              </select>
            </label>
            <button class={buttonClass}>Show</button>
          </form>
          <p class="flex flex-wrap items-center gap-3 text-label">
            <a href={self(addDays(monday, -7))}>Week before</a>
            {monday !== addDays(today, -((weekdayOf(today) + 6) % 7)) ? <a href={self(today)}>This week</a> : null}
            <a href={self(addDays(monday, 7))}>Week after</a>
            <a href={`${base}/new`} class={buttonClass + " no-underline"}>Book for someone</a>
          </p>
        </div>
        <p class="mb-3 text-label text-ink-3">Times are in {zone.replace(/_/g, " ")}.</p>
        <ol class="flex flex-col gap-3">
          {days.map((day) => {
            const b = dayBounds(day, zone);
            const mine = rows.filter((r) => new Date(r.starts_at) < b.end && new Date(r.ends_at) > b.start);
            const away = off.filter((t) => new Date(t.starts_at) < b.end && new Date(t.ends_at) > b.start);
            return (
              <li class="rounded-card border border-line bg-surface p-3">
                <h2 class={"mb-2 text-label font-semibold " + (day === today ? "text-ink" : "text-ink-2")}>{formatDate(day)}{day === today ? ", today" : ""}</h2>
                {mine.length || away.length ? (
                  <ul class="flex flex-col gap-2">
                    {away.map((t) => {
                      // Off all day, or from and to the times that fall on this day.
                      const s0 = new Date(t.starts_at), e0 = new Date(t.ends_at);
                      const allDay = s0 <= b.start && e0 >= b.end;
                      const span = allDay ? "all day" : `${s0 > b.start ? time(s0) : "until"}${s0 > b.start ? " to " : " "}${e0 < b.end ? time(e0) : "the end of the day"}`;
                      return <li class="text-label text-ink-2">{t.name} is off, {span}{t.note ? ` (${t.note})` : ""}</li>;
                    })}
                    {mine.map((r) => (
                      <li class="flex flex-wrap gap-x-3">
                        <span class="w-40 shrink-0 whitespace-nowrap text-ink-2">{time(r.starts_at)} to {time(r.ends_at)}</span>
                        <span class="min-w-0">
                          <a href={`${base}/${r.id}`}>{r.type_name}, {r.name}</a>
                          <span class="text-ink-2">, with {r.host}</span>
                          <span class="block break-words text-label text-ink-3">{whereText(r, { link: true })}{r.status !== "confirmed" ? `. ${BOOKING_STATUSES.find((x) => x.value === r.status)?.label ?? r.status}` : ""}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <p class="text-label text-ink-3">Nothing booked.</p>}
              </li>
            );
          })}
        </ol>
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
    return framed(c, opts, links, base, w.name ? `Book a time for ${w.name}` : "Book for someone", (
      <>
        <p class="mb-4 text-label"><a href={base}>All bookings</a></p>
        {types.length ? (
          <ul class="flex flex-col gap-2">
            {types.map((t) => (
              <li class="rounded-card border border-line bg-surface p-3">
                <a href={listUrl(`${base}/new/${t.id}`, carry(w))} class="font-semibold">{t.name}</a>{" "}
                <span class="text-label text-ink-3">{t.duration_min} minutes, {LOCATION_LABELS[t.location_kind].toLowerCase()}</span>
              </li>
            ))}
          </ul>
        ) : <p class="text-ink-2">Nothing can be booked yet: add what people book and who takes it under What can be booked.</p>}
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
    return framed(c, opts, links, base, `${t.name}${w.name ? ` for ${w.name}` : ""}`, (
      <>
        <p class="mb-4 text-label"><a href={listUrl(`${base}/new`, w)}>Something else</a></p>
        {hosts.length > 1 ? (
          <nav aria-label="With" class="mb-4 flex flex-wrap items-center gap-2 text-label">
            <span class="text-ink-2">With</span>
            <a href={listUrl(`${base}/new/${t.id}`, w)} aria-current={host ? undefined : "true"} class={chip + (host ? "" : " border-accent font-semibold")}>Anyone free</a>
            {hosts.map((h) => (
              <a href={listUrl(`${base}/new/${t.id}`, carry(w, { host: h.id }))} aria-current={host?.id === h.id ? "true" : undefined} class={chip + (host?.id === h.id ? " border-accent font-semibold" : "")}>{h.name}</a>
            ))}
          </nav>
        ) : null}
        <p class="mb-3 text-label text-ink-3">Times are in {zone.replace(/_/g, " ")}.</p>
        {keys.length ? (
          <>
            <DayPicker days={keys} chosen={chosen} href={(day) => here({ date: day })} />
            <ul class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(days.get(chosen) ?? []).map((slot) => (
                <li><a class={chip + " w-full"} href={listUrl(`${base}/new/${t.id}/confirm`, carry(w, { host: host?.id, start: slot.start.toISOString() }))}>{formatTime(slot.start, zone)}</a></li>
              ))}
            </ul>
          </>
        ) : <p class="text-ink-2">No open times{host ? ` with ${host.name}` : ""} in the next weeks.</p>}
      </>
    ));
  }

  async function confirmTeam(c: Context<{ Variables: TeamVars }>, t: BookingType, values: Record<string, string>, errors: Errors = {}, notice?: string) {
    const hosts = await hostsOf(getDb(c), t.id);
    const host = hosts.find((h) => h.id === values.host) ?? null;
    const zone = opts.timeZone ?? host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const start = new Date(values.start);
    if (Number.isNaN(start.getTime())) return c.redirect(listUrl(`${base}/new/${t.id}`, forWhom(c)), 303);
    const end = new Date(start.getTime() + t.duration_min * 60_000);
    return framed(c, opts, links, base, `Confirm: ${t.name}`, (
      <>
        <p class="mb-1">{t.name}{host ? `, with ${host.name}` : ", with whoever is free"}.</p>
        <p class="mb-4">{formatSlot({ start, end }, zone)}.</p>
        {notice ? <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">{notice}</p> : null}
        <form method="post" action={`${base}/new/${t.id}`} class="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="start" value={start.toISOString()} />
          {host ? <input type="hidden" name="host" value={host.id} /> : null}
          <Input label="Name" name="name" value={values.name} errors={errors} required />
          <Input label="Email" name="email" type="email" value={values.email} errors={errors} required hint="The confirmation goes here." />
          <Input label={t.location_kind === "phone" ? "Phone, for the call" : "Phone"} name="phone" type="tel" value={values.phone} errors={errors} required={t.location_kind === "phone"} />
          {t.location_kind === "their_place" ? <Input label="Address" name="address" value={values.address} errors={errors} required class="sm:col-span-2" /> : null}
          <label class={fieldClass + " sm:col-span-2"}>Notes
            <textarea name="notes" rows={2} maxlength={2000} class={controlClass}>{values.notes ?? ""}</textarea>
          </label>
          <div class="sm:col-span-2"><button class={buttonClass}>Book it</button></div>
        </form>
      </>
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

  if (opts.calendars !== false) app.get("/calendars", async (c) => {
    const list = await calendars(getDb(c));
    return framed(c, opts, links, `${base}/calendars`, "Calendars", (
      <>
        <p class="mb-4 max-w-prose text-ink-2">
          Busy times are copied from these calendars every 15 minutes, and new bookings are added to them. A time someone puts in the calendar
          between two syncs can still be booked.
        </p>
        {list.length ? (
          <ul class="flex flex-col gap-3">
            {list.map((k) => (
              <li class="rounded-card border border-line bg-surface p-4">
                <p class="font-semibold">{k.resource_name}: {k.provider === "google" ? "Google" : "Microsoft"} calendar {k.external_id}</p>
                <p class="text-label text-ink-2">
                  {k.last_synced_at ? <>Last synced <When at={k.last_synced_at} timeZone="UTC" /> UTC.</> : "Not synced yet."}
                </p>
                {k.last_error ? <p class="mt-1 text-label text-ink"><strong>Last sync failed:</strong> {k.last_error}</p> : null}
                <p class="mt-2 text-label"><a href={`${base}/people/${k.resource_id}#calendars`}>Change</a></p>
              </li>
            ))}
          </ul>
        ) : (
          <p class="text-ink-2">No calendars yet. Add one on a person's page under People and hours.</p>
        )}
      </>
    ));
  });

  app.get("/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const d = getDb(c);
    const [raw] = await d.sql`select * from bookings where id = ${id}::bigint`;
    if (!raw) return c.notFound();
    const b = toBooking(raw);
    const [who, type] = await Promise.all([resourceById(d, b.resource_id), typeById(d, b.type_id)]);
    const zone = who?.time_zone ?? "UTC";
    const self = `${base}/${b.id}`;
    const extra = opts.extra ? await opts.extra(c, b) : null;
    return framed(c, opts, links, base, `${b.name}, ${formatSlot({ start: b.starts_at, end: b.ends_at }, zone)}`, (
      <>
        <p class="mb-4 text-label"><a href={base}>All bookings</a></p>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex flex-col gap-4 md:col-span-2">
            <Section title="Booking">
              <FieldList fields={[
                { label: "When", value: formatSlot({ start: b.starts_at, end: b.ends_at }, zone) },
                { label: "Booker's time", value: b.booker_time_zone && b.booker_time_zone !== zone ? formatSlot({ start: b.starts_at, end: b.ends_at }, b.booker_time_zone) : null },
                { label: "What", value: type?.name ?? b.type_id },
                { label: "With", value: who?.name ?? b.resource_id },
                { label: "Where", value: whereText(b, { link: true }) },
                { label: "Name", value: b.name },
                { label: "Email", value: b.email },
                { label: "Phone", value: b.phone },
                { label: "Status", value: <StatusBadge value={b.status} options={BOOKING_STATUSES} /> },
                { label: "Booked", value: <When at={b.created_at} timeZone={zone} /> },
                { label: "From", value: b.source },
                { label: "In the calendar", value: b.external_event_id ? "Yes" : "Not yet" },
                { label: "Last changed", value: b.updated_by ? <>{b.updated_by}, <When at={b.updated_at} timeZone={zone} /></> : null },
              ]} />
            </Section>
            <Section title="What they told us"><JsonData data={b.answers} empty="Nothing else." /></Section>
          </div>
          <div class="flex flex-col gap-4">
            <Section title="Status">
              <StatusCell row={b} action={`${self}/status`} returnTo={self} />
            </Section>
            {extra}
          </div>
        </div>
      </>
    ));
  });

  app.post("/:id/status", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const ret = localPath(str(body.return), base, `${base}/${id}`);
    const status = pickStatus(body.status, BOOKING_STATUSES);
    if (!status) return c.text("Choose one of the listed statuses.", 400);
    const changed = status === "confirmed" ? null : await setStatus(getDb(c), id, status as Exclude<Booking["status"], "confirmed">, c.get("user"));
    if (isPartial(c)) {
      const [r] = await getDb(c).sql<Row>`
        select b.id::text as id, b.name, b.email::text as email, b.status, b.starts_at, b.ends_at, r.name as resource_name, r.time_zone,
               t.name as type_name, b.starts_at::text as k
        from bookings b join resources r on r.id = b.resource_id join booking_types t on t.id = b.type_id where b.id = ${id}::bigint`;
      return r ? c.html(<TableRow spec={spec(ret)} row={r} />) : c.notFound();
    }
    return c.redirect(withFlash(ret, changed ? "status" : "unchanged"), 303);
  });

  return app;
}

// ---- the availability editor ---------------------------------------------------------

const fieldClass = "flex flex-col gap-1 text-label text-ink-2";
const Err = ({ id, text }: { id: string; text?: string }) => (text ? <span id={id} class="text-label text-ink">{text}</span> : null);

function Input(p: { label: string; name: string; value?: string | number | null; type?: string; errors?: Errors; hint?: string; required?: boolean; min?: number; max?: number; class?: string }) {
  const err = p.errors?.[p.name];
  return (
    <label class={fieldClass + " " + (p.class ?? "")}>
      {p.label}
      <input name={p.name} type={p.type ?? "text"} value={p.value === null || p.value === undefined ? "" : String(p.value)} required={p.required} min={p.min} max={p.max}
        aria-invalid={err ? "true" : undefined} aria-describedby={err ? `${p.name}-error` : undefined} class={controlClass} />
      {p.hint ? <span class="text-ink-3">{p.hint}</span> : null}
      <Err id={`${p.name}-error`} text={err} />
    </label>
  );
}

const one = (x: unknown) => (Array.isArray(x) ? x[x.length - 1] : x); // a re-rendered body may hold arrays
const valueOf = (r: Record<string, unknown>) => (k: string) => (one(r[k]) === null || one(r[k]) === undefined ? "" : String(one(r[k])));
const Active = ({ value, label }: { value: unknown; label: string }) => (
  <label class="flex items-center gap-2 sm:col-span-2">
    <input type="hidden" name="active" value="0" />
    <input type="checkbox" name="active" value="1" checked={one(value) !== false && one(value) !== "0"} /> {label}
  </label>
);

/** A booking type's fields; the same form adds one. */
function TypeForm({ action, t, errors = {}, submit }: { action: string; t: Record<string, unknown>; errors?: Errors; submit: string }) {
  const v = valueOf(t);
  const kind = v("location_kind") || "our_place";
  return (
    <form method="post" action={action} class="grid gap-3 sm:grid-cols-2">
      <Input label="Name" name="name" value={v("name")} errors={errors} required hint="What the customer books, like Installation estimate." />
      <Input label="Booking page address" name="slug" value={v("slug")} errors={errors} required hint="Lowercase, like install-estimate: the page is /book/install-estimate." />
      <label class={fieldClass + " sm:col-span-2"}>
        Description (optional)
        <textarea name="description" rows={2} maxlength={2000} class={controlClass}>{v("description")}</textarea>
      </label>
      <label class={fieldClass}>
        Where it happens
        <select name="location_kind" class={controlClass} aria-invalid={errors.location_kind ? "true" : undefined}>
          {LOCATION_KINDS.map((k) => <option value={k} selected={k === kind}>{LOCATION_LABELS[k]}</option>)}
        </select>
        <Err id="location_kind-error" text={errors.location_kind} />
      </label>
      <Input label="Our address, or the meeting link" name="location" value={v("location")} errors={errors}
        hint="The address for a visit at ours; an https:// link for a video call. The customer gives theirs, or their number." />
      <Input label="Length (minutes)" name="duration_min" type="number" min={5} max={1440} value={v("duration_min") || "30"} errors={errors} />
      <Input label="A slot every (minutes)" name="interval_min" type="number" min={5} max={1440} value={v("interval_min") || "30"} errors={errors} />
      <Input label="Free before (minutes)" name="buffer_before_min" type="number" min={0} max={1440} value={v("buffer_before_min") || "0"} errors={errors} hint="Travel or set-up time." />
      <Input label="Free after (minutes)" name="buffer_after_min" type="number" min={0} max={1440} value={v("buffer_after_min") || "0"} errors={errors} />
      <Input label="Minimum notice (minutes)" name="min_notice_min" type="number" min={0} value={v("min_notice_min") || "120"} errors={errors} />
      <Input label="Bookable this many days ahead" name="horizon_days" type="number" min={0} max={730} value={v("horizon_days") || "60"} errors={errors} />
      <Input label="Order on the booking page" name="position" type="number" min={0} value={v("position") || "0"} errors={errors} />
      <Input label="Price (optional)" name="price" value={v("price") || (t.price_cents != null ? amountText(Number(t.price_cents), String(t.currency ?? "usd")) : "")} errors={errors}
        hint="Charged when it is booked through a form with a payment step. Empty is free." />
      <Input label="Currency" name="currency" value={v("currency") || "usd"} errors={errors} />
      <Active value={t.active} label="Can be booked" />
      <div class="sm:col-span-2"><button class={buttonClass}>{submit}</button></div>
    </form>
  );
}

/** A person's details; the same form adds one. */
function PersonForm({ action, r, errors = {}, submit }: { action: string; r: Record<string, unknown>; errors?: Errors; submit: string }) {
  const v = valueOf(r);
  return (
    <form method="post" action={action} class="grid gap-3 sm:grid-cols-2">
      <Input label="Name" name="name" value={v("name")} errors={errors} required />
      <Input label="Email" name="email" type="email" value={v("email")} errors={errors} hint="Shown as the organizer on invites." />
      <Input label="Time zone" name="time_zone" value={v("time_zone")} errors={errors} required hint="An IANA zone, like America/New_York. Their weekly hours are in this zone." />
      <Active value={r.active} label="Taking bookings" />
      <div class="sm:col-span-2"><button class={buttonClass}>{submit}</button></div>
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

/** What can be booked: each type, its rules and where it happens, and who takes it. */
export function typeRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "What can be booked" }];
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const layout = (c: Team, title: string, body: Child, status = 200) => framed(c, opts, links, base, title, body, status);

  async function listPage(c: Team, values: Record<string, unknown> = {}, errors: Errors = {}) {
    const d = getDb(c);
    const types = await allTypes(d);
    const hosts = await Promise.all(types.map((t) => hostsOf(d, t.id, { all: true })));
    return layout(c, "What can be booked", (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        {types.length ? (
          <ul class="mb-6 flex flex-col gap-2">
            {types.map((t, i) => (
              <li class="rounded-card border border-line bg-surface p-3">
                <a href={`${base}/${t.id}`} class="font-semibold">{t.name}</a>{" "}
                <span class="text-label text-ink-3">
                  {t.duration_min} minutes, {LOCATION_LABELS[t.location_kind].toLowerCase()}
                  {hosts[i].length ? `, with ${hosts[i].map((h) => h.name).join(", ")}` : ", nobody takes it yet"}
                  {t.active ? "" : ", not bookable"}
                </span>
              </li>
            ))}
          </ul>
        ) : <p class="mb-6 text-ink-2">Nothing can be booked yet. Add the first kind of booking below: an estimate visit, a consultation, a video call.</p>}
        <Section title="Add something people can book">
          <TypeForm action={base} t={values} errors={errors} submit="Add" />
        </Section>
      </>
    ), Object.keys(errors).length ? 422 : 200);
  }

  async function editPage(c: Team, t: BookingType, problems: { values?: Record<string, unknown>; errors?: Errors } = {}) {
    const d = getDb(c);
    const [hosts, people] = await Promise.all([hostsOf(d, t.id, { all: true }), allPeople(d)]);
    const self = `${base}/${t.id}`;
    return layout(c, t.name, (
      <>
        <p class="mb-4 text-label"><a href={base}>Everything bookable</a></p>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="flex flex-col gap-4">
          <Section title="Who takes it">
            <p class="mb-3 text-label text-ink-2">
              A time is open when any of them is free in their own hours. The customer can pick one, or take whoever is free; each booking
              goes to one person, the one booked least recently.
            </p>
            {people.length ? (
              <form method="post" action={`${self}/hosts`} class="flex flex-col gap-2">
                {people.map((p) => (
                  <label class="flex items-center gap-2">
                    <input type="checkbox" name="host" value={p.id} checked={hosts.some((h) => h.id === p.id)} />
                    {p.name}
                    {p.active ? null : <span class="text-label text-ink-3">(not taking bookings)</span>}
                  </label>
                ))}
                <div><button class={buttonClass}>Save who takes it</button></div>
              </form>
            ) : (
              <p class="text-ink-2">Add the people who take bookings under People and hours first.</p>
            )}
          </Section>
          <Section title="Details and rules">
            <TypeForm action={self} t={problems.values ?? t} errors={problems.errors} submit="Save" />
          </Section>
        </div>
      </>
    ), problems.errors ? 422 : 200);
  }

  const load = async (c: Team) => {
    const id = idParam(c.req.param("id"));
    return id ? typeById(getDb(c), id) : null;
  };

  app.get("/", (c) => listPage(c));

  app.post("/", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const t = await createType(getDb(c), typeFields(body), c.get("user"), opts.source);
    if (!t.ok) return listPage(c, body as Record<string, unknown>, t.errors);
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

/** The people who take bookings: each one's weekly hours, time off, calendars and what they take. */
export function peopleRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "People and hours" }];
  const typesBase = base.replace(/\/people$/, "/types");
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const layout = (c: Team, title: string, body: Child, status = 200) => framed(c, opts, links, base, title, body, status);

  async function listPage(c: Team, values: Record<string, unknown> = {}, errors: Errors = {}) {
    const all = await allPeople(getDb(c));
    return layout(c, "People and hours", (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        {all.length ? (
          <ul class="mb-6 flex flex-col gap-2">
            {all.map((r) => (
              <li class="rounded-card border border-line bg-surface p-3">
                <a href={`${base}/${r.id}`} class="font-semibold">{r.name}</a>{" "}
                <span class="text-label text-ink-3">{r.time_zone}{r.active ? "" : ", not taking bookings"}</span>
              </li>
            ))}
          </ul>
        ) : <p class="mb-6 text-ink-2">Nobody takes bookings yet. Add the first person below.</p>}
        <Section title="Add a person">
          <PersonForm action={base} r={values} errors={errors} submit="Add" />
        </Section>
      </>
    ), Object.keys(errors).length ? 422 : 200);
  }

  async function editPage(c: Team, r: Resource, problems: { details?: { values: Record<string, unknown>; errors: Errors }; hours?: Errors; timeOff?: Errors; calendar?: Errors } = {}) {
    const d = getDb(c);
    const [hours, off, cals, takes] = await Promise.all([weeklyHours(d, r.id), timeOffList(d, r.id), opts.calendars === false ? [] : calendars(d, r.id), typesHostedBy(d, r.id)]);
    const self = `${base}/${r.id}`;
    const failed = Object.values(problems).some(Boolean);
    const today = localDate(new Date(), r.time_zone);
    return layout(c, r.name, (
      <>
        <p class="mb-4 text-label"><a href={base}>Everyone</a></p>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="flex flex-col gap-4">
          <Section title={`Weekly hours, in ${r.time_zone}`}>
            <p class="mb-3 text-label text-ink-2">Booking pages show these in each visitor's own time zone. Hours past midnight go on the next day.</p>
            <ul class="mb-4 flex flex-col gap-2">
              {WEEKDAYS.map((day, i) => {
                const mine = hours.filter((h) => h.weekday === i);
                return (
                  <li class="flex flex-wrap items-center gap-2">
                    <span class="w-28 font-semibold">{day}</span>
                    {mine.length ? mine.map((h) => (
                      <form method="post" action={`${self}/hours/${h.id}/delete`} class="flex items-center gap-1 rounded-control border border-line px-2 py-1">
                        <span>{h.start} to {h.end}</span>
                        <button class="text-label text-ink-2 underline" aria-label={`Remove ${day} ${h.start} to ${h.end}`}>Remove</button>
                      </form>
                    )) : <span class="text-ink-3">Closed</span>}
                  </li>
                );
              })}
            </ul>
            <form method="post" action={`${self}/hours`} class="flex flex-wrap items-end gap-3">
              <label class={fieldClass}>Day
                <select name="weekday" class={controlClass}>{WEEKDAYS.map((d, i) => <option value={String(i)}>{d}</option>)}</select>
              </label>
              <Input label="From" name="start" type="time" value="09:00" errors={problems.hours} />
              <Input label="To" name="end" type="text" value="17:00" errors={problems.hours} hint="24:00 for midnight." />
              <button class={buttonClass}>Add hours</button>
              <Err id="weekday-error" text={problems.hours?.weekday} />
            </form>
          </Section>

          <Section title="Time off">
            <ul class="mb-3 flex flex-col gap-2">
              {off.map((t) => (
                <li class="flex flex-wrap items-center gap-2">
                  <When at={t.starts_at} timeZone={r.time_zone} /> to <When at={t.ends_at} timeZone={r.time_zone} />
                  {t.note ? <span class="text-ink-2">({t.note})</span> : null}
                  <form method="post" action={`${self}/time-off/${t.id}/delete`}><button class="text-label text-ink-2 underline">Remove</button></form>
                </li>
              ))}
              {off.length ? null : <li class="text-ink-3">None coming up.</li>}
            </ul>
            <form method="post" action={`${self}/time-off`} class="flex flex-wrap items-end gap-3">
              <Input label={`Starts (${r.time_zone})`} name="starts" type="datetime-local" value={`${today}T00:00`} errors={problems.timeOff} />
              <Input label="Ends" name="ends" type="datetime-local" value={`${today}T23:59`} errors={problems.timeOff} />
              <Input label="Note" name="note" errors={problems.timeOff} />
              <button class={buttonClass}>Add time off</button>
            </form>
          </Section>

          <Section title="What they take">
            {takes.length ? (
              <ul class="flex flex-col gap-1">
                {takes.map((t) => <li><a href={`${typesBase}/${t.id}`}>{t.name}</a></li>)}
              </ul>
            ) : <p class="text-ink-2">Nothing yet. Choose who takes each kind of booking under What can be booked.</p>}
          </Section>

          {opts.calendars === false ? null : <section id="calendars">
            <Section title="Calendars">
              <p class="mb-3 text-label text-ink-2">
                Grant this app the Google Calendar or Microsoft Calendar connection in Task &amp; Tool first. Busy times are read every 15 minutes;
                bookings are added to the first calendar listed.
              </p>
              <ul class="mb-3 flex flex-col gap-2">
                {cals.map((k) => (
                  <li class="flex flex-wrap items-center gap-2">
                    <span>{k.provider === "google" ? "Google" : "Microsoft"}: {k.external_id}</span>
                    <span class="text-label text-ink-3">{k.last_error ? `Last sync failed: ${k.last_error}` : k.last_synced_at ? "Synced" : "Not synced yet"}</span>
                    <form method="post" action={`${self}/calendars/${k.id}/delete`}><button class="text-label text-ink-2 underline">Remove</button></form>
                  </li>
                ))}
              </ul>
              <form method="post" action={`${self}/calendars`} class="flex flex-wrap items-end gap-3">
                <label class={fieldClass}>Calendar
                  <select name="provider" class={controlClass}><option value="google">Google</option><option value="microsoft">Microsoft</option></select>
                </label>
                <Input label="Calendar id" name="external_id" value="primary" errors={problems.calendar} hint="primary is the account's main calendar." />
                <button class={buttonClass}>Add calendar</button>
                <Err id="provider-error" text={problems.calendar?.provider} />
              </form>
            </Section>
          </section>}

          <Section title="Details">
            <PersonForm action={self} r={problems.details?.values ?? r} errors={problems.details?.errors} submit="Save" />
          </Section>
        </div>
      </>
    ), failed ? 422 : 200);
  }

  const load = async (c: Team) => {
    const id = idParam(c.req.param("id"));
    return id ? resourceById(getDb(c), id) : null;
  };
  const back = (r: Resource, code: string) => withFlash(`${base}/${r.id}`, code);

  app.get("/", (c) => listPage(c));

  app.post("/", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const r = await createPerson(getDb(c), personFields(body), c.get("user"), opts.source);
    if (!r.ok) return listPage(c, body as Record<string, unknown>, r.errors);
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

  app.post("/:id/hours", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const body = await c.req.parseBody();
    const saved = await addWindow(getDb(c), r.id, body.weekday, body.start, body.end, c.get("user"));
    return saved.ok ? c.redirect(back(r, "hours"), 303) : editPage(c, r, { hours: saved.errors });
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

  if (opts.calendars === false) return app;

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
