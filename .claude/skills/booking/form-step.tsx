// The `booking` step of a form (the forms skill's steps.ts): the booking
// type's days and times inside the form, taken with book() for the person the
// questions named. The booking names the submission (submission_id). The
// time is held until the form is complete, paid where a payment follows
// (hold_until); one whose form is not finished in time is released
// (releaseLapsedHolds), and stillValid then sends them back here.
//
//   formRoutes(getDb, { source, page, steps: { booking: bookingStep(getDb, { source: "website" }) }, onComplete })
//
// It sends nothing: the booker's confirmation goes when the whole form is
// complete (confirm.ts), so a time picked and never paid for confirms nothing.
//
// A form's booking field names the type by slug: { "type": "booking", "name": "when",
// "label": "Pick a time", "booking_type": "intake" }.
import type { Context } from "hono";
import type { GetDb } from "../data/db";
import type { FormStep } from "../forms/steps";
import { formatMoney } from "../payments/money";
import { book, bookingForSubmission, hostsOf, resourceById, typeById, typeBySlug, whereText, type Booking, type BookingType } from "./book";
import { invite } from "./ics";
import { chip, inviteSummary, MonthPicker, upcoming, ZoneNote, ZoneScript } from "./public";
import { formatDate, formatSlot, formatTime, isValidZone, localDate } from "./slots";

export type BookingStepOptions = {
  /** This app's slug, stored on the booking. */
  source: string;
  /** How many days ahead to offer, at most; default 60. */
  days?: number;
  /** How long a time is held for the rest of the form and any payment; default 45 minutes (a checkout lasts 31). */
  holdMinutes?: number;
  /** The site's domain, for the calendar file's id: the same id as the emailed invite, so adding both makes one event. */
  domain?: string;
};

const field = "flex flex-col gap-1 text-label font-semibold text-ink";
const control = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-copy text-ink";
const button = "inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-5 font-semibold text-accent-ink";

export function bookingStep(getDb: GetDb, opts: BookingStepOptions): FormStep {
  const typeOf = (c: Context, slug: string | undefined) => (slug ? typeBySlug(getDb(c), slug) : Promise.resolve(null));
  /** What the form charges in: its items' currency, else its payment step's, else usd (forms price.ts formCurrency). */
  const formCurrency = (fields: { type: string; currency?: string }[]) =>
    fields.find((f) => f.type === "items")?.currency ?? fields.find((f) => f.type === "payment")?.currency ?? "usd";
  const chargeFor = (t: BookingType, b: Booking, paid: boolean) =>
    paid ? { label: `${t.name}, ${formatDate(localDate(b.starts_at, b.booker_time_zone ?? "UTC"))}`, unit_cents: t.price_cents!, currency: t.currency ?? "usd" } : undefined;

  return {
    async render(c, ctx, shown) {
      const t = await typeOf(c, ctx.field.booking_type);
      if (!t) return <p>This can no longer be booked here. Please get in touch instead.</p>;
      const hosts = await hostsOf(getDb(c), t.id);
      const business = hosts[0]?.time_zone ?? "UTC";
      const tz = c.req.query("tz") ?? shown.values?.tz;
      const zone = isValidZone(tz) ? String(tz) : business;
      const withTz = (extra = "") => `${ctx.self}${isValidZone(tz) ? `&tz=${encodeURIComponent(String(tz))}` : ""}${extra}`;
      const days = await upcoming(getDb(c), t, zone, opts.days ?? 60);
      const keys = [...days.keys()];
      const chosen = keys.includes(c.req.query("date") ?? "") ? c.req.query("date")! : keys[0];
      const picked = typeof shown.values?.start === "string" ? shown.values.start : "";
      const data = ctx.submission.data;
      const needAddress = t.location_kind === "their_place" && !(typeof data.address === "string" && data.address.trim());
      const needPhone = t.location_kind === "phone" && !ctx.submission.phone;
      const err = (k: string) => (shown.errors?.[k] ? <p class="text-label font-semibold text-ink">{shown.errors[k]}</p> : null);
      if (!keys.length) return <p>There are no open times right now. Please check back soon, or get in touch.</p>;
      return (
        <form method="post" action={ctx.action} class="grid gap-4">
          {ctx.hidden}
          <input type="hidden" name="tz" value={zone} />
          <p class="text-ink-2">{t.name}, {t.duration_min} minutes{t.price_cents ? `, ${formatMoney(t.price_cents, t.currency ?? "usd")}` : ""}.</p>
          <ZoneNote zone={zone} business={business} switchHref={zone !== business ? `${ctx.self}&tz=${encodeURIComponent(business)}` : null} />
          {tz ? null : <ZoneScript business={business} />}
          <div class="max-w-xs">
            <MonthPicker days={keys} chosen={chosen} href={(d) => withTz(`&date=${d}`)} />
          </div>
          <fieldset class="grid gap-2">
            <legend class="mb-2 font-semibold">{formatDate(chosen)}</legend>
            {err("start")}
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(days.get(chosen) ?? []).map((s) => {
                const iso = s.start.toISOString();
                return (
                  <label class={chip + " flex items-center justify-center gap-2 has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:checked]:font-semibold has-[:checked]:text-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"}>
                    <input type="radio" name="start" value={iso} checked={iso === picked} required class="sr-only" />
                    {formatTime(s.start, zone)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          {needAddress ? <label class={field}>Address for the visit<textarea name="address" rows={2} maxlength={500} required class={control}>{String(shown.values?.address ?? "")}</textarea>{err("address")}</label> : null}
          {needPhone ? <label class={field}>Phone, for us to call<input name="phone" type="tel" maxlength={40} required class={control} value={String(shown.values?.phone ?? "")} />{err("phone")}</label> : null}
          <div><button type="submit" class={button}>Book this time</button></div>
        </form>
      );
    },

    async thanks(c, submissionId) {
      const b = await bookingForSubmission(getDb(c), submissionId);
      if (!b) return null;
      const [t, host] = await Promise.all([typeById(getDb(c), b.type_id), resourceById(getDb(c), b.resource_id)]);
      if (!t || !host) return null;
      const zone = b.booker_time_zone ?? host.time_zone;
      const [{ held }] = await getDb(c).sql<{ held: boolean }>`select hold_until is not null as held from bookings where id = ${b.id}::bigint`;
      const file = invite({
        method: "PUBLISH", booking: b, domain: opts.domain ?? new URL(c.req.url).hostname,
        organizer: host.email ? { email: host.email, name: host.name } : null, summary: inviteSummary(t, host), location: b.location,
      });
      return (
        <>
          <h1 class="mb-2 text-title font-semibold">{held ? "Your time is held" : "You are booked"}</h1>
          <p class="mb-1 font-semibold">{formatSlot({ start: b.starts_at, end: b.ends_at }, zone)}</p>
          <p class="mb-1">{t.name}, with {host.name}.</p>
          <p class="mb-4 break-words">{whereText(b, { link: true })}</p>
          <p><a download="booking.ics" href={`data:text/calendar;charset=utf-8,${encodeURIComponent(file)}`} class="font-semibold text-accent underline">Add it to your calendar</a></p>
        </>
      );
    },

    async stillValid(c, ctx) {
      return !!(await bookingForSubmission(getDb(c), ctx.submission.id));
    },

    async take(c, ctx, input) {
      const t = await typeOf(c, ctx.field.booking_type);
      if (!t) return { ok: false, errors: { start: "This can no longer be booked here." } };
      const paid = !!t.price_cents && ctx.form.fields.some((f) => f.type === "payment");
      if (paid && (t.currency ?? "usd") !== formCurrency(ctx.form.fields)) {
        console.error(`booking: type ${t.slug} is priced in ${t.currency}, but form ${ctx.form.key} charges in ${formCurrency(ctx.form.fields)}`);
        return { ok: false, errors: { start: "This can't be booked here just now. Please get in touch instead." } };
      }
      // Booked already (a double click, or back to this step): that booking stands.
      const already = await bookingForSubmission(getDb(c), ctx.submission.id);
      if (already) return { ok: true, charge: chargeFor(t, already, paid) };
      const email = ctx.submission.email;
      if (!email) return { ok: false, errors: { start: "This form needs to ask for an email before a time can be booked." } };
      const raw = typeof input.start === "string" ? input.start : "";
      const start = new Date(raw);
      if (!raw || Number.isNaN(start.getTime())) return { ok: false, errors: { start: "Pick a time." } };
      const one = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
      const data = ctx.submission.data;
      const hosts = await hostsOf(getDb(c), t.id);
      const r = await book(getDb(c), {
        typeId: t.id, start, name: ctx.submission.name || email, email,
        phone: ctx.submission.phone || one("phone") || null,
        address: (typeof data.address === "string" && data.address.trim()) || one("address") || null,
        bookerTimeZone: (isValidZone(one("tz")) ? one("tz") : hosts[0]?.time_zone) ?? null, source: opts.source, submissionId: ctx.submission.id,
        holdUntil: new Date(Date.now() + (opts.holdMinutes ?? 45) * 60_000),
      });
      if (!r.ok) {
        if (r.reason === "invalid") return { ok: false, errors: r.errors };
        const raced = await bookingForSubmission(getDb(c), ctx.submission.id);
        if (raced) return { ok: true, charge: chargeFor(t, raced, paid) };
        return { ok: false, errors: { start: r.reason === "taken" ? "That time was just taken. Pick another." : "This can no longer be booked here." } };
      }
      return { ok: true, charge: chargeFor(t, r.booking, paid) };
    },
  };
}
