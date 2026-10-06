// The public booking pages: what can be booked, then a day, a time and the
// booker's details, done; and the manage link that reschedules or cancels.
// Edge-safe: they read Postgres only (busy is what the sync job last copied
// from the calendar) and never call a calendar.
//
//   app.route("/book", bookingPages(getDb, {
//     base: "/book", domain: "acme.com", css: "/site.css", source: "website",
//     onBooked: (c, e) => afterResponse(c, sendInvite(envOf(c), { ... })),   // notify.ts
//   }));
//   // /book lists the types; a type with slug "install-estimate" is booked at /book/install-estimate
//
// Times are shown in the viewer's zone, with the zone named. A two-line
// script adds ?tz= from the browser once; with no JavaScript the page shows
// the business's zone and says so. Every form is a POST with a 303. The
// confirm form carries the spam fields (data/spam.tsx) and asks for what
// the type needs: an address when the visit is at theirs, a number for a
// phone call. A deposit, when the app takes one, is `afterBook` sending the
// booker to pay, and the manage page shows its status from payments.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Db, GetDb } from "../data/db";
import { envVar } from "../data/env";
import { HONEYPOT, makeStamp, SpamFields, STAMP, verdict } from "../data/spam";
import {
  book, bookableTypes, bookingByToken, releaseLapsedHolds, cancelByToken, hostsOf, openSlotsFor, reschedule, resourceById, typeById, typeBySlug, whereText,
  type Booking, type BookingType, type OpenSlot, type Resource,
} from "./book";
import { invite } from "./ics";
import type { BookingNotice } from "./notify";
import { byLocalDate, formatDate, formatSlot, formatTime, isValidZone, localDate, zoneLabel } from "./slots";

/** What the public pages report to onBooked and afterBook: always with the manage link, absolute. */
export type BookingEvent = BookingNotice & { manageUrl: string };

/** What a type's page says about where, before anyone books. */
const typeWhere = (t: BookingType) =>
  ({ their_place: "At your address", our_place: t.location ? `At ${t.location}` : "At our place", phone: "By phone: we call you", video: "Video call: the link comes with your confirmation" })[
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
  /** The site's own page frame; a plain one is used otherwise. */
  Page?: (p: { title: string; children: Child }) => Child;
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
};

const control =
  "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-copy text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const button =
  "rounded-control bg-accent px-4 py-2 font-semibold text-accent-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const chip =
  "inline-block rounded-control border border-line-strong bg-surface px-3 py-2 text-center no-underline text-ink hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function PlainPage({ title, css, children }: { title: string; css: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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

const q = (params: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
};

/** The open slots for the next days, grouped by the viewer's local date. */
export async function upcoming(db: Db, type: BookingType, viewerZone: string, maxDays: number, opts: { hosts?: string[]; exceptBooking?: string } = {}) {
  const now = new Date();
  await releaseLapsedHolds(db, now);
  const days = Math.min(type.horizon_days + 1, maxDays);
  const list = await openSlotsFor(db, type, now, new Date(now.getTime() + (days + 1) * 86_400_000), now, opts);
  return byLocalDate(list, viewerZone);
}

/** The days with open times, a week of them at a time (the chosen day's), with links to the weeks around it. */
export function DayPicker({ days, chosen, href }: { days: string[]; chosen: string; href: (d: string) => string }) {
  const PER = 7;
  const at = Math.max(0, days.indexOf(chosen));
  const from = Math.floor(at / PER) * PER;
  const shown = days.slice(from, from + PER);
  const earlier = from > 0 ? days[from - PER] : null;
  const later = days[from + PER] ?? null;
  return (
    <nav aria-label="Days with open times" class="mb-4">
      <ul class="flex flex-wrap gap-2">
        {shown.map((d) => (
          <li>
            <a href={href(d)} aria-current={d === chosen ? "date" : undefined} class={chip + (d === chosen ? " border-accent font-semibold" : "")}>
              {formatDate(d)}
            </a>
          </li>
        ))}
      </ul>
      {earlier || later ? (
        <p class="mt-2 flex gap-4 text-label">
          {earlier ? <a href={href(earlier)}>Earlier days</a> : null}
          {later ? <a href={href(later)}>Later days</a> : null}
        </p>
      ) : null}
    </nav>
  );
}

function ZoneNote({ zone, business, switchHref }: { zone: string; business: string; switchHref: string | null }) {
  return (
    <p class="mb-4 text-label text-ink-2">
      Times are in {zone.replace(/_/g, " ")} ({zoneLabel(new Date(), zone)}).{" "}
      {switchHref ? <a href={switchHref}>Show them in {business.replace(/_/g, " ")} instead.</a> : null}
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
  const page = (c: Context, title: string, body: Child, status = 200) =>
    c.html(opts.Page ? <>{opts.Page({ title, children: body })}</> : <PlainPage title={title} css={opts.css}>{body}</PlainPage>, status as 200);
  const viewerZone = (c: Context, fallback: string) => {
    const tz = c.req.query("tz");
    return isValidZone(tz) ? tz : fallback;
  };
  const after = async (c: Context, token: string, booking: Booking, event: BookingEvent["event"], type: BookingType): Promise<BookingEvent | null> => {
    const host = await resourceById(getDb(c), booking.resource_id);
    if (!host) return null;
    const e = { event, booking, type, host, manageUrl: new URL(`${base}/manage/${token}`, c.req.url).href };
    try {
      await opts.onBooked?.(c, e);
    } catch (err) {
      // A confirmation that fails to send never undoes the booking; the page has the invite.
      console.error("booking: onBooked failed:", err);
    }
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
    const days = open ? await upcoming(getDb(c), type, zone, maxDays, { hosts: [b.resource_id], exceptBooking: b.id }) : new Map<string, OpenSlot[]>();
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
            <ZoneNote zone={zone} business={host.time_zone} switchHref={zone !== host.time_zone ? self + q({ tz: host.time_zone }) : null} />
            {keys.length ? (
              <>
                <DayPicker days={keys} chosen={chosen} href={(d) => self + q({ date: d, tz: c.req.query("tz") })} />
                <ul class="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
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
    return c.redirect(`${base}/manage/${token}${q({ tz: isValidZone(tz) ? tz : null })}`, 303);
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
    return c.redirect(`${base}/manage/${token}${q({ tz })}`, 303);
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
                  <span class="block text-label text-ink-2">{t.duration_min} minutes. {typeWhere(t)}.</span>
                  {t.description ? <span class="mt-1 block text-ink-2">{t.description}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p class="text-ink-2">Nothing can be booked online right now. Please get in touch instead.</p>
        )}
      </>
    ));
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
        <p class="mb-1 text-ink-2">{t.duration_min} minutes. {typeWhere(t)}.</p>
        {t.description ? <p class="mb-4 text-ink-2">{t.description}</p> : <div class="mb-4" />}
        {c.req.query("taken") === "1" ? <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">That time was just taken. Pick another.</p> : null}
        {hosts.length > 1 ? (
          <nav aria-label="With" class="mb-4 flex flex-wrap items-center gap-2 text-label">
            <span class="text-ink-2">With</span>
            <a href={self + q({ tz: tzq })} aria-current={host ? undefined : "true"} class={chip + (host ? "" : " border-accent font-semibold")}>Anyone free</a>
            {hosts.map((h) => (
              <a href={self + q({ host: h.id, tz: tzq })} aria-current={host?.id === h.id ? "true" : undefined} class={chip + (host?.id === h.id ? " border-accent font-semibold" : "")}>
                {h.name}
              </a>
            ))}
          </nav>
        ) : null}
        <ZoneNote zone={zone} business={business} switchHref={zone !== business ? self + q({ tz: business, date: chosen, host: host?.id }) : null} />
        {keys.length ? (
          <>
            <DayPicker days={keys} chosen={chosen} href={(d) => self + q({ date: d, tz: tzq, host: host?.id })} />
            <h2 class="mb-2 text-label font-semibold">{formatDate(chosen)}</h2>
            <ul class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(days.get(chosen) ?? []).map((s) => (
                <li>
                  <a class={chip + " w-full"} href={`${self}/confirm` + q({ start: s.start.toISOString(), tz: zone, host: host?.id })}>
                    {formatTime(s.start, zone)}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p class="text-ink-2">There are no open times right now. Please check back soon.</p>
        )}
        {tzq ? null : <ZoneScript business={business} />}
      </>
    ));
  });

  const spamScope = (t: BookingType) => `booking:${t.slug}`;

  function confirmForm(
    c: Context, t: BookingType, host: Resource | null, start: Date, zone: string, stamp: string,
    values: Record<string, string> = {}, errors: Record<string, string> = {}, notice?: string,
  ) {
    const end = new Date(start.getTime() + t.duration_min * 60_000);
    return page(c, `Confirm: ${t.name}`, (
      <>
        <h1 class="mb-1 text-title font-semibold">Confirm your time</h1>
        <p class="mb-1">{t.name}{host ? `, with ${host.name}` : ""}.</p>
        <p class="mb-1">{formatSlot({ start, end }, zone)}.</p>
        <p class="mb-4 text-ink-2">{typeWhere(t)}.</p>
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
          <Field label="Anything we should know? (optional)" name="notes" value={values.notes} error={errors.notes} area />
          <SpamFields stamp={stamp} />
          <div class="flex items-center gap-4">
            <button class={button}>Book it</button>
            <a href={`${base}/${t.slug}` + q({ date: localDate(start, zone), tz: zone, host: host?.id })}>Pick another time</a>
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
    return confirmForm(c, t, host, start, zone, await makeStamp(spamScope(t), envVar(c, "SPAM_SECRET")));
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
    const values = { name: s("name"), email: s("email"), phone: s("phone"), address: s("address"), notes: s("notes") };
    const secret = envVar(c, "SPAM_SECRET");
    // A bot is sent back to the day's times, as if nothing happened. A person
    // whose browser filled the form in under the minimum time confirms again.
    const v = await verdict(spamScope(t), { honeypot: body[HONEYPOT] ?? "", stamp: body[STAMP] }, secret);
    if (v === "drop") return c.redirect(back, 303);
    if (v === "fast") return confirmForm(c, t, host, start, zone, await makeStamp(spamScope(t), secret), values, {}, "Please check your details and press Book it again.");
    const notes = values.notes.trim().slice(0, 2000);

    const result = await book(getDb(c), {
      typeId: t.id, hostId: host?.id ?? null, start, name: values.name, email: values.email, phone: values.phone || null,
      address: values.address || null, bookerTimeZone: zone, answers: notes ? { notes } : {}, source: opts.source,
    });
    if (!result.ok && result.reason === "invalid") return confirmForm(c, t, host, start, zone, s(STAMP), values, result.errors);
    if (!result.ok) return c.redirect(back + q({ date: localDate(start, zone), tz: zone, host: host?.id, taken: "1" }), 303);
    const e = await after(c, result.token, result.booking, "booked", t);
    let next: string | null | undefined | void = null;
    try {
      next = e ? await opts.afterBook?.(c, e) : null;
    } catch (err) {
      console.error(`booking: afterBook failed for booking ${result.booking.id}:`, err);
    }
    return c.redirect(next || `${base}/manage/${result.token}` + q({ new: "1", tz: zone }), 303);
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
