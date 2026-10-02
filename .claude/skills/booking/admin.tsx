// The team's side of booking, private (teamOnly): the bookings list and a
// booking's page with its status, the availability editor (weekly hours,
// time off, slot settings, crew members, calendars), and the calendars'
// last sync. Built on admin/; every form works without JavaScript.
//
//   app.route("/admin/bookings", bookingAdmin(getDb, { base: "/admin/bookings", css: "/site.css", source: "website" }));
//
// Another app that only edits hours (the CRM, "let me change my booking
// slots") mounts the editor alone; it writes the same tables the
// booking page reads, so the change shows on the next page load:
//
//   app.route("/hours", availabilityRoutes(getDb, { base: "/hours", css: "/site.css", source: "crm" }));
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
import { resourceById, setStatus, toBooking, type Booking, type Resource } from "./book";
import {
  addCalendar, addMember, addTimeOff, addWindow, allResources, calendars, createResource, crewMembers, removeCalendar, removeMember,
  removeTimeOff, removeWindow, saveResource, timeOffList, weeklyHours, WEEKDAYS, type Errors, type ResourceFields,
} from "./hours";
import { formatSlot, localDate } from "./slots";

export type BookingAdminOptions = {
  base: string;
  css: string;
  /** This app's slug, stored on the people and crews it creates. */
  source: string;
  nav?: NavItem[];
  pageSize?: number;
};

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
  member: "Crew saved.",
  calendar: "Calendar saved. The next sync, within 15 minutes, reads it.",
  created: "Created. Now set the weekly hours.",
};

type Row = Keyed & {
  id: string; name: string; email: string; status: string; starts_at: Date; ends_at: Date; resource_name: string; time_zone: string;
};
type Filter = { q: string | null; when: "upcoming" | "past"; resource: string | null; status: string | null };

function readFilter(c: Context): Filter {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  return {
    q: q || null,
    when: c.req.query("when") === "past" ? "past" : "upcoming",
    resource: idParam(c.req.query("resource")),
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
               b.starts_at::text as k
        from bookings b join resources r on r.id = b.resource_id
        where b.ends_at > ${t}::timestamptz
          and (${pat}::text is null or b.name ilike ${pat} or b.email::text ilike ${pat})
          and (${f.resource}::bigint is null or b.resource_id = ${f.resource}::bigint or b.crew_id = ${f.resource}::bigint)
          and (${f.status}::text is null or b.status = ${f.status})
          and (${k}::timestamptz is null or (b.starts_at, b.id) > (${k}::timestamptz, ${id}::bigint))
        order by b.starts_at, b.id limit ${size + 1}`
    : db.sql<Row>`
        select b.id::text as id, b.name, b.email::text as email, b.status, b.starts_at, b.ends_at, r.name as resource_name, r.time_zone,
               b.starts_at::text as k
        from bookings b join resources r on r.id = b.resource_id
        where b.ends_at <= ${t}::timestamptz
          and (${pat}::text is null or b.name ilike ${pat} or b.email::text ilike ${pat})
          and (${f.resource}::bigint is null or b.resource_id = ${f.resource}::bigint or b.crew_id = ${f.resource}::bigint)
          and (${f.status}::text is null or b.status = ${f.status})
          and (${k}::timestamptz is null or (b.starts_at, b.id) < (${k}::timestamptz, ${id}::bigint))
        order by b.starts_at desc, b.id desc limit ${size + 1}`;
}

function nav(base: string, extra?: NavItem[]): NavItem[] {
  return extra ?? [
    { href: base, label: "Bookings" },
    { href: `${base}/resources`, label: "Hours and people" },
    { href: `${base}/calendars`, label: "Calendars" },
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
  const links = nav(base, opts.nav);
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  app.route("/resources", availabilityRoutes(getDb, { ...opts, base: `${base}/resources`, nav: links }));

  const spec = (returnTo: string): TableSpec<Row> => ({
    id: "bookings",
    href: (r) => `${base}/${r.id}`,
    columns: [
      { label: "When", cell: (r) => <When at={r.starts_at} timeZone={r.time_zone} /> },
      { label: "Name", cell: (r) => r.name },
      { label: "Email", cell: (r) => r.email, class: "hidden md:table-cell" },
      { label: "With", cell: (r) => r.resource_name, class: "hidden sm:table-cell" },
      { label: "Status", cell: (r) => <StatusCell row={r} action={`${base}/${r.id}/status`} returnTo={returnTo} swap="closest tr" /> },
    ],
  });

  app.get("/", async (c) => {
    const f = readFilter(c);
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await bookingsPage(getDb(c), f, after, size), size);
    const params = { q: f.q, when: f.when === "past" ? "past" : null, resource: f.resource, status: f.status };
    const self = listUrl(base, params);
    const more = (cur: string) => listUrl(base, { ...params, after: cur });
    const s = spec(self);
    if (isPartial(c) && after) return c.html(<TableRows spec={s} rows={page} next={next} more={more} />);
    const results = (
      <div id="results">
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the start</a></p> : null}
        <DataTable spec={s} caption={f.when === "past" ? "Past bookings, latest first" : "Upcoming bookings, soonest first"} rows={page} next={next} more={more}
          empty={f.q || f.resource || f.status ? <>Nothing matches these filters. <a href={listUrl(base, { when: params.when })}>Clear filters</a></> : f.when === "past" ? "No past bookings yet." : "No upcoming bookings."} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const resources = await allResources(getDb(c));
    return c.html(
      <AdminLayout title="Bookings" css={opts.css} nav={links} current={base} user={c.get("user")}>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <SearchBar action={base} target="#results" q={f.q} placeholder="Name or email" filters={[
          { name: "when", label: "When", options: [{ value: "past", label: "Past" }], value: params.when, any: "Upcoming" },
          { name: "resource", label: "With", options: resources.map((r) => ({ value: r.id, label: r.name })), value: f.resource, any: "Anyone" },
          { name: "status", label: "Status", options: BOOKING_STATUSES, value: f.status, any: "Any status" },
        ]} />
        {results}
      </AdminLayout>,
    );
  });

  app.get("/calendars", async (c) => {
    const list = await calendars(getDb(c));
    return c.html(
      <AdminLayout title="Calendars" css={opts.css} nav={links} current={`${base}/calendars`} user={c.get("user")}>
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
                <p class="mt-2 text-label"><a href={`${base}/resources/${k.resource_id}#calendars`}>Change</a></p>
              </li>
            ))}
          </ul>
        ) : (
          <p class="text-ink-2">No calendars yet. Add one on a person's page under Hours and people.</p>
        )}
      </AdminLayout>,
    );
  });

  app.get("/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const d = getDb(c);
    const [raw] = await d.sql`select * from bookings where id = ${id}::bigint`;
    if (!raw) return c.notFound();
    const b = toBooking(raw);
    const who = await resourceById(d, b.resource_id);
    const crew = b.crew_id ? await resourceById(d, b.crew_id) : null;
    const zone = who?.time_zone ?? "UTC";
    const self = `${base}/${b.id}`;
    return c.html(
      <AdminLayout title={`${b.name}, ${formatSlot({ start: b.starts_at, end: b.ends_at }, zone)}`} css={opts.css} nav={links} current={base} user={c.get("user")}>
        <p class="mb-4 text-label"><a href={base}>All bookings</a></p>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex flex-col gap-4 md:col-span-2">
            <Section title="Booking">
              <FieldList fields={[
                { label: "When", value: formatSlot({ start: b.starts_at, end: b.ends_at }, zone) },
                { label: "Booker's time", value: b.booker_time_zone && b.booker_time_zone !== zone ? formatSlot({ start: b.starts_at, end: b.ends_at }, b.booker_time_zone) : null },
                { label: "With", value: who ? `${who.name}${crew ? ` (${crew.name})` : ""}` : b.resource_id },
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
            <Section title="Answers"><JsonData data={b.answers} /></Section>
          </div>
          <Section title="Status">
            <StatusCell row={b} action={`${self}/status`} returnTo={self} />
          </Section>
        </div>
      </AdminLayout>,
    );
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
               b.starts_at::text as k
        from bookings b join resources r on r.id = b.resource_id where b.id = ${id}::bigint`;
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

/** Details and slot settings; the same fields create a resource. */
function ResourceForm({ action, r, errors = {}, submit, kindChoice }: { action: string; r: Partial<Record<keyof ResourceFields, unknown>>; errors?: Errors; submit: string; kindChoice?: boolean }) {
  const one = (x: unknown) => (Array.isArray(x) ? x[x.length - 1] : x); // a re-rendered body may hold arrays
  const v = (k: keyof ResourceFields) => (one(r[k]) === null || one(r[k]) === undefined ? "" : String(one(r[k])));
  const active = one(r.active);
  return (
    <form method="post" action={action} class="grid gap-3 sm:grid-cols-2">
      {kindChoice ? (
        <fieldset class="sm:col-span-2">
          <legend class="text-label text-ink-2">This is</legend>
          <label class="mr-4"><input type="radio" name="kind" value="person" checked={v("kind") !== "crew"} /> one person</label>
          <label><input type="radio" name="kind" value="crew" checked={v("kind") === "crew"} /> a crew (each booking goes to one free member)</label>
        </fieldset>
      ) : null}
      <Input label="Name" name="name" value={v("name")} errors={errors} required />
      <Input label="Email" name="email" type="email" value={v("email")} errors={errors} hint="Shown as the organizer on invites." />
      <Input label="Booking page address" name="slug" value={v("slug")} errors={errors} hint="Lowercase, like intro-call. Empty means no public page." />
      <Input label="Time zone" name="time_zone" value={v("time_zone")} errors={errors} required hint="An IANA zone, like America/New_York. Weekly hours are in this zone." />
      <Input label="Length (minutes)" name="duration_min" type="number" min={5} max={1440} value={v("duration_min") || "30"} errors={errors} />
      <Input label="A slot every (minutes)" name="interval_min" type="number" min={5} max={1440} value={v("interval_min") || "30"} errors={errors} />
      <Input label="Free before (minutes)" name="buffer_before_min" type="number" min={0} max={1440} value={v("buffer_before_min") || "0"} errors={errors} />
      <Input label="Free after (minutes)" name="buffer_after_min" type="number" min={0} max={1440} value={v("buffer_after_min") || "0"} errors={errors} />
      <Input label="Minimum notice (minutes)" name="min_notice_min" type="number" min={0} value={v("min_notice_min") || "120"} errors={errors} />
      <Input label="Bookable this many days ahead" name="horizon_days" type="number" min={0} max={730} value={v("horizon_days") || "60"} errors={errors} />
      <label class="flex items-center gap-2 sm:col-span-2">
        <input type="hidden" name="active" value="0" />
        <input type="checkbox" name="active" value="1" checked={active !== false && active !== "0"} /> Taking bookings
      </label>
      <div class="sm:col-span-2"><button class={buttonClass}>{submit}</button></div>
    </form>
  );
}

const fields = (body: Record<string, unknown>): ResourceFields => {
  const last = (v: unknown) => (Array.isArray(v) ? v[v.length - 1] : v);
  return {
    kind: str(body.kind), name: str(body.name), slug: str(body.slug), email: str(body.email), time_zone: str(body.time_zone),
    duration_min: str(body.duration_min), interval_min: str(body.interval_min), buffer_before_min: str(body.buffer_before_min),
    buffer_after_min: str(body.buffer_after_min), min_notice_min: str(body.min_notice_min), horizon_days: str(body.horizon_days),
    active: str(last(body.active)),
  };
};

/** The weekly hours, time off, settings, crew and calendars of each resource. Mount it alone in another app if that is all it needs. */
export function availabilityRoutes(getDb: GetDb, opts: BookingAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const links = opts.nav ?? [{ href: base, label: "Hours and people" }];
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const layout = (c: Context<{ Variables: TeamVars }>, title: string, body: Child, status = 200) =>
    c.html(<AdminLayout title={title} css={opts.css} nav={links} current={base} user={c.get("user")}>{body}</AdminLayout>, status as 200);

  async function listPage(c: Context<{ Variables: TeamVars }>, values: Record<string, unknown> = {}, errors: Errors = {}) {
    const all = await allResources(getDb(c));
    return layout(c, "Hours and people", (
      <>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        {all.length ? (
          <ul class="mb-6 flex flex-col gap-2">
            {all.map((r) => (
              <li class="rounded-card border border-line bg-surface p-3">
                <a href={`${base}/${r.id}`} class="font-semibold">{r.name}</a>{" "}
                <span class="text-label text-ink-3">{r.kind === "crew" ? "crew" : "person"}, {r.time_zone}{r.active ? "" : ", not taking bookings"}</span>
              </li>
            ))}
          </ul>
        ) : <p class="mb-6 text-ink-2">Nobody can be booked yet. Add the first person below.</p>}
        <Section title="Add a person or crew">
          <ResourceForm action={base} r={values} errors={errors} submit="Add" kindChoice />
        </Section>
      </>
    ), Object.keys(errors).length ? 422 : 200);
  }

  async function editPage(c: Context<{ Variables: TeamVars }>, r: Resource, problems: { settings?: { values: Record<string, unknown>; errors: Errors }; hours?: Errors; timeOff?: Errors; member?: Errors; calendar?: Errors } = {}) {
    const d = getDb(c);
    const [hours, off, members, cals, everyone] = await Promise.all([
      weeklyHours(d, r.id), timeOffList(d, r.id), r.kind === "crew" ? crewMembers(d, r.id) : Promise.resolve([]), calendars(d, r.id), allResources(d),
    ]);
    const self = `${base}/${r.id}`;
    const failed = Object.values(problems).some(Boolean);
    const today = localDate(new Date(), r.time_zone);
    return layout(c, r.name, (
      <>
        <p class="mb-4 text-label"><a href={base}>Everyone</a></p>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="flex flex-col gap-4">
          {r.kind === "person" ? (
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
          ) : (
            <Section title="Crew members">
              <p class="mb-3 text-label text-ink-2">A time is open when any member is free in their own hours. Each booking goes to the free member booked least recently.</p>
              <ul class="mb-3 flex flex-col gap-2">
                {members.map((m) => (
                  <li class="flex items-center gap-2">
                    <a href={`${base}/${m.id}`}>{m.name}</a>
                    <form method="post" action={`${self}/members/${m.id}/delete`}><button class="text-label text-ink-2 underline" aria-label={`Remove ${m.name} from the crew`}>Remove</button></form>
                  </li>
                ))}
              </ul>
              <form method="post" action={`${self}/members`} class="flex flex-wrap items-end gap-3">
                <label class={fieldClass}>Add a person
                  <select name="member" class={controlClass}>
                    {everyone.filter((p) => p.kind === "person" && !members.some((m) => m.id === p.id)).map((p) => <option value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <button class={buttonClass}>Add</button>
                <Err id="member-error" text={problems.member?.member} />
              </form>
            </Section>
          )}

          {r.kind === "person" ? (
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
          ) : null}

          <Section title="Details and slot settings">
            <ResourceForm action={self} r={problems.settings?.values ?? r} errors={problems.settings?.errors} submit="Save" />
          </Section>

          {r.kind === "person" ? (
            <section id="calendars">
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
            </section>
          ) : null}
        </div>
      </>
    ), failed ? 422 : 200);
  }

  const load = async (c: Context<{ Variables: TeamVars }>) => {
    const id = idParam(c.req.param("id"));
    return id ? resourceById(getDb(c), id) : null;
  };
  const back = (r: Resource, code: string) => withFlash(`${base}/${r.id}`, code);

  app.get("/", (c) => listPage(c));

  app.post("/", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const r = await createResource(getDb(c), fields(body), c.get("user"), opts.source);
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
    const saved = await saveResource(getDb(c), r.id, fields(body), c.get("user"));
    if (!saved.ok) return editPage(c, r, { settings: { values: body as Record<string, unknown>, errors: saved.errors } });
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

  app.post("/:id/members", async (c) => {
    const r = await load(c);
    if (!r) return c.notFound();
    const member = idParam(str((await c.req.parseBody()).member));
    const saved = member ? await addMember(getDb(c), r.id, member) : { ok: false as const, errors: { member: "Choose a person." } };
    return saved.ok ? c.redirect(back(r, "member"), 303) : editPage(c, r, { member: saved.errors });
  });

  app.post("/:id/members/:mid/delete", async (c) => {
    const r = await load(c);
    const mid = idParam(c.req.param("mid"));
    if (!r || !mid) return c.notFound();
    await removeMember(getDb(c), r.id, mid);
    return c.redirect(back(r, "member"), 303);
  });

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
