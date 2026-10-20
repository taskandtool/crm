// The public booking pages: what can be booked, then a day, a time and the
// booker's details, done; and the manage link that reschedules or cancels.
// Edge-safe: they read Postgres only (busy is what the sync job last copied
// from the calendar) and never call a calendar.
//
//   app.route("/book", bookingPages(getDb, {
//     base: "/book", domain: "acme.com", css: "/site.css", source: "website",
//     onBooked: (c, e) => afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain: "acme.com" })),   // notify.ts
//   }));
//   // /book lists the types; a type with slug "install-estimate" is booked at /book/install-estimate
//
// Times are shown in the viewer's zone, with the zone named. A two-line
// script adds ?tz= from the browser once; with no JavaScript the page shows
// the business's zone and says so. Every form is a POST with a 303. The
// confirm form carries the spam fields (data/spam.tsx) and asks for what
// the type needs: an address when the visit is at theirs, a number for a
// phone call. A deposit, when the app takes one, is `afterBook` sending the
// booker to pay, and the manage page shows its status from payments. The
// manage link is the booker's key: only its hash is stored, and its pages
// send Referrer-Policy: no-referrer.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Db, GetDb } from "../data/db";
import { HONEYPOT, makeStamp, SpamFields, STAMP, verdict } from "../data/spam";
import { listUrl } from "../admin/query";
import {
  book, bookableTypes, bookingByToken, releaseLapsedHolds, cancelByToken, hostsOf, openSlotsFor, reschedule, resourceById, typeById, typeBySlug, whereText,
  type Booking, type BookingType, type OpenSlot, type Resource,
} from "./book";
import { invite } from "./ics";
import { LinkedText } from "../forms/render";
import { runOnBooked, type BookingNotice } from "./notify";
import { addDays, byLocalDate, durationText, formatDate, formatSlot, formatTime, isValidZone, localDate, weekdayOf, zoneName } from "./slots";

/** What the public pages report to onBooked and afterBook: always with the manage link, absolute. */
export type BookingEvent = BookingNotice & { manageUrl: string };

/** What a type's page says about where, before anyone books. */
const typeWhere = (t: BookingType) =>
  ({ their_place: "At your address", our_place: t.location ? `At ${t.location}` : "At our place", phone: "By phone: we call you", video: t.location ? "Video call: the link comes with your confirmation" : "Video call: we send you the link" })[
    t.location_kind
  ];

export type PublicOptions = {
  /** Where the routes are mounted, e.g. "/book". */
  base: string;
  /** The business's domain, for the invite's UID. Keep it fixed. */
  domain: string;
  css: string;
  /** This app's slug, stored on each booking. */
  source: string;
  /** The site's own page frame; a plain one is used otherwise. `path` is a public page's own, for its canonical; null on a private or one-off page. */
  Page?: (p: { title: string; path: string | null; children: Child }) => Child;
  /** After a booking or a change: send the owner's confirmation here (notify.ts). Never throws into the response. */
  onBooked?: (c: Context, e: BookingEvent) => void | Promise<void>;
  /**
   * After a new booking, once onBooked has run: a URL to send the booker to
   * instead of the manage page (a deposit's Checkout). Nothing, or a failure,
   * goes to the manage page as usual; the booking stands either way.
   */
  afterBook?: (c: Context, e: BookingEvent) => string | null | undefined | void | Promise<string | null | undefined | void>;
  /** How many days ahead to list, at most. */
  days?: number;
  /**
   * The texting box's words (the forms skill's `textingBox`), shown under
   * the phone field once the business has a number: null leaves it off.
   */
  textConsent?: (c: Context) => string | null | Promise<string | null>;
};

const control =
  "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-copy text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const button =
  "rounded-control bg-accent px-4 py-2 font-semibold text-accent-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const chipBase =
  "inline-block whitespace-nowrap rounded-control border px-3 py-2 text-center no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
/** A choice: a time, a day, a host. */
export const chip = chipBase + " border-line-strong bg-surface text-ink hover:bg-panel";

/** A customer's page with no site around it (the app's own fallback, e.g. the CRM's /q): never indexed. Also for a form's pages there. */
export function PlainPage({ title, css, children }: { title: string; css: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <link rel="stylesheet" href={css} />
      </head>
      <body class="min-h-screen bg-canvas font-body text-copy text-ink">
        <main class="mx-auto max-w-xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}

/** Adds ?tz=<browser zone> once, when the page has none and the browser's differs. */
function ZoneScript({ business }: { business: string }) {
  const js = `(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone,u=new URL(location.href);if(z&&z!==${JSON.stringify(business).replace(/</g, "\\u003c")}&&!u.searchParams.has("tz")){u.searchParams.set("tz",z);location.replace(u.href)}}catch(e){}})()`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}

/** The open slots for the next days, grouped by the viewer's local date. */
export async function upcoming(db: Db, type: BookingType, viewerZone: string, maxDays: number, opts: { hosts?: string[]; exceptBooking?: string } = {}) {
  const now = new Date();
  await releaseLapsedHolds(db, now);
  const days = Math.min(type.horizon_days + 1, maxDays);
  const list = await openSlotsFor(db, type, now, new Date(now.getTime() + (days + 1) * 86_400_000), now, opts);
  return byLocalDate(list, viewerZone);
}

/** A choice that is on (the host picked): the accent's tint, never a filled button. */
export const chipOn = chipBase + " border-accent bg-accent/10 font-semibold text-accent";

const monthName = (date: string, locale = "en-US") =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(date.slice(0, 7) + "-15T12:00:00Z"));

/**
 * A month as a calendar, as every booking page shows one: the days with open
 * times are links, the chosen one filled, the rest quiet. The arrows go to the
 * first open day of the month before or after, so a month with nothing open
 * is never shown. Weeks start on Sunday.
 */
export function MonthPicker({ days, chosen, href }: { days: string[]; chosen: string; href: (d: string) => string }) {
  const open = new Set(days);
  const month = chosen.slice(0, 7);
  const first = `${month}-01`;
  const cells: (string | null)[] = Array(weekdayOf(first)).fill(null);
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) cells.push(d);
  const before = days.filter((d) => d.slice(0, 7) < month).pop() ?? null;
  const after = days.find((d) => d.slice(0, 7) > month) ?? null;
  const before1 = before ? days.find((d) => d.slice(0, 7) === before.slice(0, 7))! : null;
  const arrow = "flex size-8 items-center justify-center rounded-control text-ink-2 no-underline hover:bg-panel";
  return (
    <nav aria-label="Days with open times">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="font-semibold">{monthName(first)}</h2>
        <span class="flex gap-1">
          {before1 ? <a href={href(before1)} class={arrow} aria-label="Earlier month">&lsaquo;</a> : <span class={arrow + " opacity-40"} aria-hidden="true">&lsaquo;</span>}
          {after ? <a href={href(after)} class={arrow} aria-label="Later month">&rsaquo;</a> : <span class={arrow + " opacity-40"} aria-hidden="true">&rsaquo;</span>}
        </span>
      </div>
      <ol class="grid grid-cols-7 gap-1 text-center text-label">
        {["S", "M", "T", "W", "T", "F", "S"].map((w) => <li aria-hidden="true" class="py-1 text-ink-3">{w}</li>)}
        {cells.map((d) =>
          !d ? <li aria-hidden="true" /> : open.has(d) ? (
            <li>
              <a href={href(d)} aria-label={formatDate(d)} aria-current={d === chosen ? "date" : undefined}
                class={"mx-auto flex size-9 items-center justify-center rounded-control font-semibold no-underline " +
                  (d === chosen ? "bg-accent text-accent-ink" : "bg-accent/10 text-accent hover:bg-accent/20")}>
                {Number(d.slice(8))}
              </a>
            </li>
          ) : (
            <li class="flex size-9 items-center justify-center justify-self-center text-ink-3">{Number(d.slice(8))}</li>
          ),
        )}
      </ol>
    </nav>
  );
}

/** The calendar beside the chosen day's times: side by side on a wide screen, stacked on a phone. */
export function DayAndTimes({ days, chosen, href, children }: { days: string[]; chosen: string; href: (d: string) => string; children: Child }) {
  return (
    <div class="grid gap-6 sm:grid-cols-[17rem_1fr]">
      <MonthPicker days={days} chosen={chosen} href={href} />
      <section aria-label={`Times on ${formatDate(chosen)}`}>
        <h2 class="mb-2 font-semibold">{formatDate(chosen)}</h2>
        {children}
      </section>
    </div>
  );
}

function ZoneNote({ zone, business, switchHref }: { zone: string; business: string; switchHref: string | null }) {
  return (
    <p class="mb-4 text-label text-ink-2">
      Times are in {zoneName(zone)}.{" "}
      {switchHref ? <a href={switchHref}>Show them in {zoneName(business)} instead.</a> : null}
    </p>
  );
}

const Field = (p: { label: string; name: string; type?: string; value?: string; error?: string; required?: boolean; autocomplete?: string; max?: number; area?: boolean }) => (
  <label class="flex flex-col gap-1">
    <span class="text-label font-semibold">{p.label}</span>
    {p.area ? (
      <textarea name={p.name} rows={3} maxlength={p.max ?? 2000} required={p.required} autocomplete={p.autocomplete}
        aria-invalid={p.error ? "true" : undefined} aria-describedby={p.error ? `${p.name}-error` : undefined} class={control}>
        {p.value ?? ""}
      </textarea>
    ) : (
      <input
        name={p.name}
        type={p.type ?? "text"}
        value={p.value ?? ""}
        required={p.required}
        autocomplete={p.autocomplete}
        maxlength={p.max ?? 200}
        aria-invalid={p.error ? "true" : undefined}
        aria-describedby={p.error ? `${p.name}-error` : undefined}
        class={control}
      />
    )}
    {p.error ? <span id={`${p.name}-error`} class="text-label text-ink">{p.error}</span> : null}
  </label>
);

export function bookingPages(getDb: GetDb, opts: PublicOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const maxDays = opts.days ?? 60;
  const app = new Hono();
  const page = (c: Context, title: string, body: Child, status = 200, path: string | null = null) =>
    c.html(opts.Page ? <>{opts.Page({ title, path, children: body })}</> : <PlainPage title={title} css={opts.css}>{body}</PlainPage>, status as 200);
  const viewerZone = (c: Context, fallback: string) => {
    const tz = c.req.query("tz");
    return isValidZone(tz) ? tz : fallback;
  };
  const after = async (c: Context, token: string, booking: Booking, event: BookingEvent["event"], type: BookingType): Promise<BookingEvent | null> => {
    const host = await resourceById(getDb(c), booking.resource_id);
    if (!host) return null;
    const e = { event, booking, type, host, manageUrl: new URL(`${base}/manage/${token}`, c.req.url).href };
    await runOnBooked(opts.onBooked, c, e);
    return e;
  };
  const privatePage = (c: Context) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer"); // the token is in the URL
    c.header("X-Robots-Tag", "noindex");
  };

  // ---- the manage link (before /:slug, so "manage" is never a slug) ----------

  async function managePage(c: Context, token: string, notice?: string, status = 200) {
    privatePage(c);
    const b = await bookingByToken(getDb(c), token);
    if (!b) return c.notFound();
    const [type, host] = await Promise.all([typeById(getDb(c), b.type_id), resourceById(getDb(c), b.resource_id)]);
    if (!type || !host) return c.notFound();
    const zone = viewerZone(c, b.booker_time_zone && isValidZone(b.booker_time_zone) ? b.booker_time_zone : host.time_zone);
    const self = `${base}/manage/${token}`;
    const open = b.status === "confirmed" && b.starts_at > new Date();
    const days = open ? await upcoming(getDb(c), type, zone, maxDays, { hosts: [host.id], exceptBooking: b.id }) : new Map<string, OpenSlot[]>();
    const keys = [...days.keys()];
    const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
    const heading = c.req.query("new") === "1" ? "You are booked" : b.status === "cancelled" ? "This booking is cancelled" : `${type.name} with ${host.name}`;
    const deposit = await depositStatus(getDb(c), b.id);
    return page(c, heading, (
      <>
        <h1 class="mb-2 text-title font-semibold">{heading}</h1>
        {notice ? <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">{notice}</p> : null}
        <p class="mb-1">{formatSlot({ start: b.starts_at, end: b.ends_at }, zone)}</p>
        <p class="mb-1">{type.name}, with {host.name}.</p>
        <p class="mb-4 break-words">{whereText(b, { link: b.status === "confirmed" })}</p>
        <p class="mb-4 text-label text-ink-2">Booked for {b.name} ({b.email}).</p>
        {deposit ? <p class="mb-4">{DEPOSIT[deposit] ?? `Deposit: ${deposit}.`}</p> : null}
        {b.status !== "cancelled" ? (
          <p class="mb-4"><a href={`${self}/invite.ics`}>Add it to your calendar (.ics)</a></p>
        ) : null}
        {c.req.query("new") === "1" ? (
          <p class="mb-6 text-label text-ink-2">Keep this page's address: it is how you change or cancel this booking. Anyone with it can.</p>
        ) : null}
        {open ? (
          <>
            <h2 class="mb-2 mt-6 text-label font-semibold">Move to another time</h2>
            <ZoneNote zone={zone} business={host.time_zone} switchHref={zone !== host.time_zone ? listUrl(self, { tz: host.time_zone }) : null} />
            {keys.length ? (
              <>
                <div class="mb-6">
                  <DayAndTimes days={keys} chosen={chosen} href={(d) => listUrl(self, { date: d, tz: c.req.query("tz") })}>
                    <ul class="grid grid-cols-2 gap-2">
                      {(days.get(chosen) ?? []).map((s) => (
                        <li>
                          <form method="post" action={`${self}/reschedule`}>
                            <input type="hidden" name="start" value={s.start.toISOString()} />
                            <input type="hidden" name="tz" value={zone} />
                            <button class={chip + " w-full"}>{formatTime(s.start, zone)}</button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </DayAndTimes>
                </div>
              </>
            ) : (
              <p class="mb-6 text-ink-2">There are no other open times right now.</p>
            )}
            <form method="post" action={`${self}/cancel`} class="mt-6 border-t border-line pt-4">
              <input type="hidden" name="tz" value={zone} />
              <button class={chip}>Cancel this booking</button>
            </form>
          </>
        ) : null}
        {c.req.query("tz") ? null : <ZoneScript business={host.time_zone} />}
      </>
    ), status);
  }

  app.get("/manage/:token", (c) => managePage(c, c.req.param("token")));

  app.get("/manage/:token/invite.ics", async (c) => {
    privatePage(c);
    const b = await bookingByToken(getDb(c), c.req.param("token"));
    if (!b) return c.notFound();
    const [type, host] = await Promise.all([typeById(getDb(c), b.type_id), resourceById(getDb(c), b.resource_id)]);
    // A CANCEL needs an organizer; with none there is nothing useful to download (the page hides the link).
    if (b.status === "cancelled" && !host?.email) return c.notFound();
    const text = invite({
      method: b.status === "cancelled" ? "CANCEL" : "PUBLISH",
      booking: b,
      domain: opts.domain,
      organizer: host?.email ? { email: host.email, name: host.name } : null,
      summary: inviteSummary(type, host),
      location: b.location,
      url: new URL(`${base}/manage/${c.req.param("token")}`, c.req.url).href,
    });
    return c.body(text, 200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="booking-${b.id}.ics"` });
  });

  app.post("/manage/:token/cancel", async (c) => {
    const token = c.req.param("token");
    const tz = String((await c.req.parseBody()).tz ?? "");
    const r = await cancelByToken(getDb(c), token);
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (r.ok) {
      const type = await typeById(getDb(c), r.booking.type_id);
      if (type) await after(c, token, r.booking, "cancelled", type);
    }
    return c.redirect(listUrl(`${base}/manage/${token}`, { tz: isValidZone(tz) ? tz : null }), 303);
  });

  app.post("/manage/:token/reschedule", async (c) => {
    const token = c.req.param("token");
    const body = await c.req.parseBody();
    const tz = isValidZone(body.tz) ? String(body.tz) : null;
    const start = new Date(String(body.start ?? ""));
    const r = await reschedule(getDb(c), token, start);
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (!r.ok) return managePage(c, token, r.reason === "taken" ? "That time was just taken. Pick another." : "This booking can no longer be changed.", 409);
    const type = await typeById(getDb(c), r.booking.type_id);
    if (type) await after(c, token, r.booking, "rescheduled", type);
    return c.redirect(listUrl(`${base}/manage/${token}`, { tz }), 303);
  });

  // ---- booking ----------------------------------------------------------------------

  app.get("/", async (c) => {
    const types = await bookableTypes(getDb(c));
    return page(c, "Book a time", (
      <>
        <h1 class="mb-4 text-title font-semibold">Book a time</h1>
        {types.length ? (
          <ul class="flex flex-col gap-3">
            {types.map((t) => (
              <li>
                <a href={`${base}/${t.slug}`} class="block rounded-card border border-line-strong bg-surface p-4 no-underline text-ink hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  <span class="block font-semibold">{t.name}</span>
                  <span class="block text-label text-ink-2">{durationText(t.duration_min)} · {typeWhere(t)}</span>
                  {t.description ? <span class="mt-1 block text-ink-2">{t.description}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p class="text-ink-2">Nothing can be booked online right now. Please get in touch instead.</p>
        )}
      </>
    ), 200, base || "/");
  });

  /** The host a booker picked, when they picked one of this type's. */
  const pickedHost = (hosts: Resource[], v: unknown) => (typeof v === "string" ? hosts.find((h) => h.id === v) ?? null : null);

  app.get("/:slug", async (c) => {
    const t = await typeBySlug(getDb(c), c.req.param("slug"));
    if (!t) return c.notFound();
    const hosts = await hostsOf(getDb(c), t.id);
    const host = pickedHost(hosts, c.req.query("host"));
    const business = host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const zone = viewerZone(c, business);
    const days = await upcoming(getDb(c), t, zone, maxDays, host ? { hosts: [host.id] } : {});
    const keys = [...days.keys()];
    const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
    const self = `${base}/${t.slug}`;
    const tzq = c.req.query("tz");
    return page(c, t.name, (
      <>
        <p class="mb-2 text-label"><a href={base}>Everything we offer</a></p>
        <h1 class="mb-1 text-title font-semibold">{t.name}</h1>
        <p class="mb-1 text-ink-2">{durationText(t.duration_min)} · {typeWhere(t)}</p>
        {t.description ? <p class="mb-4 text-ink-2">{t.description}</p> : <div class="mb-4" />}
        {c.req.query("taken") === "1" ? <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">That time was just taken. Pick another.</p> : null}
        {hosts.length > 1 ? (
          <nav aria-label="With" class="mb-4 flex flex-wrap items-center gap-2 text-label">
            <span class="text-ink-2">With</span>
            <a href={listUrl(self, { tz: tzq })} aria-current={host ? undefined : "true"} class={host ? chip : chipOn}>Anyone free</a>
            {hosts.map((h) => (
              <a href={listUrl(self, { host: h.id, tz: tzq })} aria-current={host?.id === h.id ? "true" : undefined} class={host?.id === h.id ? chipOn : chip}>
                {h.name}
              </a>
            ))}
          </nav>
        ) : null}
        <ZoneNote zone={zone} business={business} switchHref={zone !== business ? listUrl(self, { tz: business, date: chosen, host: host?.id }) : null} />
        {keys.length ? (
          <>
            <DayAndTimes days={keys} chosen={chosen} href={(d) => listUrl(self, { date: d, tz: tzq, host: host?.id })}>
              <ul class="grid grid-cols-2 gap-2">
                {(days.get(chosen) ?? []).map((s) => (
                  <li>
                    <a class={chip + " w-full"} href={listUrl(`${self}/confirm`, { start: s.start.toISOString(), tz: zone, host: host?.id })}>
                      {formatTime(s.start, zone)}
                    </a>
                  </li>
                ))}
              </ul>
            </DayAndTimes>
          </>
        ) : (
          <p class="text-ink-2">There are no open times right now. Please check back soon.</p>
        )}
        {tzq ? null : <ZoneScript business={business} />}
      </>
    ), 200, self);
  });

  const spamScope = (t: BookingType) => `booking:${t.slug}`;

  async function confirmForm(
    c: Context, t: BookingType, host: Resource | null, start: Date, zone: string, stamp: string,
    values: Record<string, string> = {}, errors: Record<string, string> = {}, notice?: string,
  ) {
    const end = new Date(start.getTime() + t.duration_min * 60_000);
    const consent = opts.textConsent ? await opts.textConsent(c) : null;
    return page(c, `Confirm: ${t.name}`, (
      <>
        <h1 class="mb-4 text-title font-semibold">Confirm your time</h1>
        <dl class="mb-6 grid gap-x-6 gap-y-1 rounded-card border border-line bg-surface p-4 sm:grid-cols-[auto_1fr]">
          <dt class="text-label text-ink-3">What</dt><dd class="font-semibold">{t.name}{host ? `, with ${host.name}` : ""}</dd>
          <dt class="text-label text-ink-3">When</dt><dd>{formatSlot({ start, end }, zone)}</dd>
          <dt class="text-label text-ink-3">Where</dt><dd>{typeWhere(t)}</dd>
        </dl>
        {notice ? <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">{notice}</p> : null}
        <form method="post" action={`${base}/${t.slug}`} class="flex flex-col gap-4">
          <input type="hidden" name="start" value={start.toISOString()} />
          <input type="hidden" name="tz" value={zone} />
          {host ? <input type="hidden" name="host" value={host.id} /> : null}
          <Field label="Your name" name="name" value={values.name} error={errors.name} required autocomplete="name" />
          <Field label="Email" name="email" type="email" value={values.email} error={errors.email} required autocomplete="email" />
          {t.location_kind === "their_place" ? (
            <Field label="Address" name="address" value={values.address} error={errors.address} required autocomplete="street-address" max={500} area />
          ) : null}
          <Field label={t.location_kind === "phone" ? "Phone, for us to call" : "Phone (optional)"} name="phone" type="tel" value={values.phone} error={errors.phone}
            required={t.location_kind === "phone"} autocomplete="tel" max={40} />
          {consent ? (
            <label class="-mt-2 flex items-start gap-2">
              <input type="checkbox" name="text_consent" value="yes" class="mt-1" checked={values.text_consent === "yes"} />
              <span class="text-label"><LinkedText text={consent} /></span>
            </label>
          ) : null}
          <Field label="Anything we should know? (optional)" name="notes" value={values.notes} error={errors.notes} area />
          <SpamFields stamp={stamp} />
          <div class="flex items-center gap-4">
            <button class={button}>Book it</button>
            <a href={listUrl(`${base}/${t.slug}`, { date: localDate(start, zone), tz: zone, host: host?.id })}>Pick another time</a>
          </div>
        </form>
      </>
    ), Object.keys(errors).length || notice ? 422 : 200);
  }

  app.get("/:slug/confirm", async (c) => {
    const t = await typeBySlug(getDb(c), c.req.param("slug"));
    if (!t) return c.notFound();
    const hosts = await hostsOf(getDb(c), t.id);
    const host = pickedHost(hosts, c.req.query("host"));
    const start = new Date(c.req.query("start") ?? "");
    if (Number.isNaN(start.getTime())) return c.redirect(`${base}/${t.slug}`, 303);
    const zone = viewerZone(c, host?.time_zone ?? hosts[0]?.time_zone ?? "UTC");
    return confirmForm(c, t, host, start, zone, await makeStamp(spamScope(t)));
  });

  app.post("/:slug", async (c) => {
    const t = await typeBySlug(getDb(c), c.req.param("slug"));
    if (!t) return c.notFound();
    const body = await c.req.parseBody();
    const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const hosts = await hostsOf(getDb(c), t.id);
    const host = pickedHost(hosts, s("host"));
    const zone = isValidZone(s("tz")) ? s("tz") : host?.time_zone ?? hosts[0]?.time_zone ?? "UTC";
    const start = new Date(s("start"));
    const back = `${base}/${t.slug}`;
    if (Number.isNaN(start.getTime())) return c.redirect(back, 303);
    const values = { name: s("name"), email: s("email"), phone: s("phone"), address: s("address"), notes: s("notes"), text_consent: s("text_consent") };
    // A bot is sent back to the day's times, as if nothing happened. A person
    // whose browser filled the form in under the minimum time confirms again.
    const v = await verdict(spamScope(t), { honeypot: body[HONEYPOT] ?? "", stamp: body[STAMP] });
    if (v === "drop") return c.redirect(back, 303);
    if (v === "fast") return confirmForm(c, t, host, start, zone, await makeStamp(spamScope(t)), values, {}, "Please check your details and press Book it again.");
    const notes = values.notes.trim().slice(0, 2000);

    const agreed = values.text_consent === "yes" && values.phone && opts.textConsent ? await opts.textConsent(c) : null;
    const result = await book(getDb(c), {
      typeId: t.id, hostId: host?.id ?? null, start, name: values.name, email: values.email, phone: values.phone || null,
      address: values.address || null, bookerTimeZone: zone, answers: notes ? { notes } : {}, source: opts.source,
      textConsent: agreed,
    });
    if (!result.ok && result.reason === "invalid") return confirmForm(c, t, host, start, zone, s(STAMP), values, result.errors);
    if (!result.ok) return c.redirect(listUrl(back, { date: localDate(start, zone), tz: zone, host: host?.id, taken: "1" }), 303);
    const e = await after(c, result.token, result.booking, "booked", t);
    let next: string | null | undefined | void = null;
    try {
      next = e ? await opts.afterBook?.(c, e) : null;
    } catch (err) {
      console.error(`booking: afterBook failed for booking ${result.booking.id}:`, err);
    }
    return c.redirect(next || listUrl(`${base}/manage/${result.token}`, { new: "1", tz: zone }), 303);
  });

  return app;
}

/** The invite's title: what it is and with whom. */
export const inviteSummary = (type: BookingType | null, host: Resource | null) =>
  type && host ? `${type.name} with ${host.name}` : type ? type.name : host ? `Booking with ${host.name}` : "Booking";

const DEPOSIT: Record<string, string> = {
  paid: "Deposit paid.",
  pending: "Deposit not confirmed yet. If you have just paid, it shows here within a minute.",
  failed: "The deposit payment failed.",
  cancelled: "The deposit was not paid.",
  refunded: "Deposit refunded.",
  partially_refunded: "Deposit partly refunded.",
};

/**
 * The latest deposit's status for a booking, from the payments skill's table,
 * or null when there is none or the project has no payments.
 */
export async function depositStatus(db: Db, bookingId: string): Promise<string | null> {
  try {
    const [p] = await db.sql<{ status: string }>`
      select status from payments
      where ref_type = 'booking' and ref_id = ${bookingId} and kind = 'deposit'
      order by created_at desc, id desc limit 1`;
    return p?.status ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return null; // no payments: this project takes no payments
    throw e;
  }
}
