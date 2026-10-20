// What starts each automatic text, and what each says when it goes. The
// starts: a missed call (hooks.ts), a submission and a booking (the CRM's
// own form and booking hooks), and the job's scan: the submissions and
// bookings another app made (the Website's forms), a draft left before
// booking, a visit coming up, a visit done (`scan`). The Website never
// texts: it writes the rows, and the scan finds them.
// Each start is a `schedule` (send.ts); `deliver` asks `render` here what
// to say. Edge-safe, but `scan` and the job's sends are the CRM's.
import type { Db } from "../data/db";
import { formatTime, localDate, addDays, wallToInstant } from "../booking/slots";
import { bookableTypes as bookable, openSlotsFor, toType, type BookingType } from "../booking/book";
import { stepsOf, type Field } from "../forms/fields";
import { phoneKey } from "../customers/customer";
import { flowOf, flowSettings, notQuiet, type Fill, type FlowSettings } from "./flows";
import { communicationById, ownerOf } from "./store";
import { deliver, draftLink, dueSends, mayText, schedule, sendById, type PhoneCtx, type Rendered, type SendRow, type Slot } from "./send";

const firstName = (name: string | null | undefined) => {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n && !/^\+?\d/.test(n) ? n : null;
};

/** Whether anyone is working now, by the team's hours. No hours set: never "closed". */
export async function openNow(db: Db, now = new Date()): Promise<boolean> {
  const [r] = await db.sql<{ any: boolean; open: boolean }>`
    select exists (select 1 from availability a join resources r on r.id = a.resource_id where r.active) as any,
           exists (select 1 from availability a join resources r on r.id = a.resource_id
                   where r.active and a.weekday = extract(dow from (${now.toISOString()}::timestamptz at time zone r.time_zone))::int
                     and (${now.toISOString()}::timestamptz at time zone r.time_zone)::time >= a.start_local
                     and (${now.toISOString()}::timestamptz at time zone r.time_zone)::time < a.end_local) as open`;
  return !r.any || r.open;
}

/** A form's booking step's service, when it has one. */
async function formBooking(db: Db, formKey: string): Promise<{ follow_up: boolean; type: BookingType | null; hasBooking: boolean; title: string } | null> {
  const [f] = await db.sql<{ fields: Field[]; follow_up: string | null; title: string }>`
    select fields, to_jsonb(f)->>'follow_up' as follow_up, title from forms f where key = ${formKey}`;
  if (!f) return null;
  const step = stepsOf(f.fields ?? []).find((s) => s.kind === "booking");
  const slug = step && step.kind === "booking" ? step.field.booking_type : null;
  const [t] = slug ? await db.sql`select * from booking_types where slug = ${slug} and active` : [];
  return { follow_up: f.follow_up === "true", type: t ? toType(t) : null, hasBooking: !!step, title: f.title };
}

/** The next three open times of a service in the coming week, as a text names them ("Tue 9am"). */
export async function nextThree(db: Db, type: BookingType, zone: string, now = new Date()): Promise<Slot[]> {
  const open = await openSlotsFor(db, type, now, new Date(now.getTime() + 7 * 86_400_000), now);
  const picked: typeof open = [];
  // Spread them: no two in the same hour, so "Tue 9am, Tue 9:30am" doesn't use up the choice.
  for (const s of open) {
    if (picked.length === 3) break;
    if (picked.some((p) => Math.abs(p.start.getTime() - s.start.getTime()) < 3_600_000)) continue;
    picked.push(s);
  }
  return picked.map((s) => ({ start: s.start.toISOString(), label: slotLabel(s.start, zone) }));
}

/** "Tue 9am", "Wed 1:30pm": short, and plain characters only. */
function slotLabel(t: Date, zone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(t);
  return `${day} ${shortTime(t, zone)}`;
}
const shortTime = (t: Date, zone: string) => formatTime(t, zone).replace(/:00/, "").replace(/\s?([AP])M/i, (_m, a: string) => `${a.toLowerCase()}m`).replace(/ |\s/g, "");

/** "Tue, Oct 21 at 9:00am", in a zone. */
function visitTime(t: Date, zone: string): string {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(t);
  return `${d} at ${formatTime(t, zone).replace(/\s?([AP])M/i, (_m, a: string) => `${a.toLowerCase()}m`).replace(/ |\s(?=[ap]m)/g, "")}`;
}

/** "today at 2:00pm", "tomorrow at 9:00am", else the day. */
function whenText(t: Date, zone: string, now = new Date()): string {
  const day = localDate(t, zone);
  const time = formatTime(t, zone).replace(/\s?([AP])M/i, (_m, a: string) => `${a.toLowerCase()}m`).replace(/ |\s(?=[ap]m)/g, "");
  if (day === localDate(now, zone)) return `today at ${time}`;
  if (day === addDays(localDate(now, zone), 1)) return `tomorrow at ${time}`;
  return visitTime(t, zone);
}

// ---- the starts ---------------------------------------------------------------

/**
 * A call nobody answered: its text, claimed now and sent once the call is
 * over (sendMissed, from the voicemail or the call's end), so it never
 * arrives while they are still listening to the greeting, and it can say
 * whether they left a message. `send` sends it at once: a call already over.
 */
export async function onMissedCall(ctx: PhoneCtx, callId: string, remote: string, o: { send?: boolean } = {}): Promise<void> {
  // Due in three minutes: the job sends it then only if neither of the call's own webhooks came.
  const dueAt = new Date((ctx.now ? ctx.now() : new Date()).getTime() + 3 * 60_000);
  const id = await schedule(ctx.db, { flow: "missed_call", subjectType: "call", subjectId: callId, phone: remote, dueAt });
  if (id && o.send) await deliverOne(ctx, id);
}

/** The call is over (a voicemail left, or the call ended): its missed-call text goes, if one waits. */
export async function sendMissed(ctx: PhoneCtx, callId: string): Promise<void> {
  const [row] = await ctx.db.sql<{ id: string }>`
    select id::text as id from text_sends where flow = 'missed_call' and subject_type = 'call' and subject_id = ${callId} and status = 'due'`;
  if (row) await deliverOne(ctx, row.id);
}

/**
 * A form submission is complete: "Booked" for the booking its booking step
 * made (call it once that booking is confirmed: after confirmFormBooking, or
 * once paid), else "Thanks for reaching out" for a form that follows up.
 * `send: false` only schedules it (the scan). Whether it scheduled one.
 */
export async function onSubmitted(ctx: PhoneCtx, submissionId: string, o: { send?: boolean } = {}): Promise<boolean> {
  const [s] = await ctx.db.sql<{ form_key: string; phone: string | null; email: string | null }>`
    select form_key, phone, email::text as email from submissions where id = ${submissionId}::bigint`;
  if (!s) return false;
  const form = await formBooking(ctx.db, s.form_key);
  if (form?.hasBooking) {
    const [b] = await ctx.db.sql<{ id: string; phone: string | null; email: string | null }>`
      select id::text as id, phone, email::text as email from bookings where submission_id = ${submissionId}::bigint and status = 'confirmed' limit 1`;
    return b ? onBooked(ctx, { event: "booked", booking: b }, o) : false;
  }
  if (!form?.follow_up) return false;
  const id = await schedule(ctx.db, { flow: "thanks", subjectType: "submission", subjectId: submissionId, phone: s.phone, email: s.email });
  if (id && o.send !== false) await deliverOne(ctx, id);
  return !!id;
}

/** A booking made: "Booked", now. Moves and cancels are the booking emails' to say (their manage link is there). `send` as onSubmitted's. */
export async function onBooked(ctx: PhoneCtx, e: { event: string; booking: { id: string; phone: string | null; email: string | null } }, o: { send?: boolean } = {}): Promise<boolean> {
  if (e.event !== "booked") return false;
  const id = await schedule(ctx.db, { flow: "booked", subjectType: "booking", subjectId: e.booking.id, phone: e.booking.phone, email: e.booking.email });
  if (id && o.send !== false) await deliverOne(ctx, id);
  return !!id;
}

async function deliverOne(ctx: PhoneCtx, id: string): Promise<void> {
  const row = await sendById(ctx.db, id);
  if (row) await deliver(ctx, row, render);
}

/**
 * What time brings, for the job every 15 minutes: submissions and bookings
 * another app made in the last hour (flows 2 and 4: the Website's forms),
 * drafts left before booking (flow 3, and its next-morning nudge), visits
 * coming up (5), visits done (6). Each is scheduled once; then every due row goes. Only what
 * happened since texting or the flow could start is looked at: connecting
 * Twilio texts nobody about the past.
 */
export async function scan(ctx: PhoneCtx): Promise<{ scheduled: number; sent: number; skipped: number; failed: number; later: number }> {
  const db = ctx.db;
  const now = ctx.now ? ctx.now() : new Date();
  const s = await flowSettings(db);
  let scheduled = 0;
  // Three days back at most, and never before the owner turned the flow on.
  const sinceFor = (f: FlowSettings) => new Date(Math.max(now.getTime() - 3 * 86_400_000, f.enabledAt?.getTime() ?? 0)).toISOString();
  // A send that stopped partway (the process died between its claim and its end) is never tried again,
  // since it may have gone; it is marked failed so it shows, rather than sitting in "sending".
  await db.sql`update text_sends set status = 'failed', why = 'stopped partway: not tried again, as it may have gone', updated_at = now()
    where status = 'sending' and updated_at < now() - interval '10 minutes'`;

  // What another app's form or booking page made, in the hour before at most: a CRM added later thanks nobody for
  // last week. Each is one row (text_sends_once), so what the CRM's own pages already scheduled is left as it is.
  const lastHour = (f: FlowSettings) => new Date(Math.max(now.getTime() - 3_600_000, f.enabledAt?.getTime() ?? 0)).toISOString();
  // Found more than ten minutes after the person's own action, it is no longer an answer at night: it waits for 8am (send.ts ANSWERS).
  const dueFor = (at: Date) => (now.getTime() - new Date(at).getTime() < 10 * 60_000 ? now : notQuiet(now, ctx.zone));
  if (s.thanks.enabled) {
    const subs = await db.sql<{ id: string; phone: string | null; email: string | null; completed_at: Date }>`
      select s.id::text as id, s.phone, s.email::text as email, s.completed_at from submissions s join forms f on f.key = s.form_key
      where to_jsonb(f)->>'follow_up' = 'true' and not f.fields @> '[{"type": "booking"}]'::jsonb
        and s.completed_at > ${lastHour(s.thanks)}::timestamptz and s.completed_at <= ${now.toISOString()}::timestamptz and s.status <> 'spam'
        and not exists (select 1 from text_sends t where t.flow = 'thanks' and t.subject_type = 'submission' and t.subject_id = s.id::text)
      order by s.completed_at limit 100`;
    for (const r of subs) {
      if (await schedule(db, { flow: "thanks", subjectType: "submission", subjectId: r.id, phone: r.phone, email: r.email, dueAt: dueFor(r.completed_at) })) scheduled++;
    }
  }
  if (s.booked.enabled) {
    const books = await db.sql<{ id: string; phone: string | null; email: string | null; created_at: Date }>`
      select b.id::text as id, b.phone, b.email::text as email, b.created_at from bookings b
      where b.status = 'confirmed' and b.created_at > ${lastHour(s.booked)}::timestamptz and b.created_at <= ${now.toISOString()}::timestamptz
        and not exists (select 1 from text_sends t where t.flow = 'booked' and t.subject_type = 'booking' and t.subject_id = b.id::text)
      order by b.created_at limit 100`;
    for (const b of books) {
      if (await schedule(db, { flow: "booked", subjectType: "booking", subjectId: b.id, phone: b.phone, email: b.email, dueAt: dueFor(b.created_at) })) scheduled++;
    }
  }

  if (s.unbooked.enabled) {
    const wait = s.unbooked.timing ?? 10;
    const drafts = await db.sql<{ id: string; form_key: string; phone: string | null; email: string | null }>`
      select d.id::text as id, d.form_key, d.phone, d.email::text as email from submission_drafts d join forms f on f.key = d.form_key
      where d.submission_id is null and not d.spam and d.step >= 1 and (d.phone is not null or d.email is not null)
        and to_jsonb(f)->>'follow_up' = 'true' and f.fields @> '[{"type": "booking"}]'::jsonb
        and d.updated_at < ${now.toISOString()}::timestamptz - make_interval(mins => ${wait})
        and d.updated_at > ${sinceFor(s.unbooked)}::timestamptz
        and not exists (select 1 from text_sends t where t.flow = 'unbooked' and t.step = 1 and t.subject_type = 'draft' and t.subject_id = d.id::text)
      order by d.updated_at
      limit 100`;
    for (const d of drafts) {
      if (await schedule(db, { flow: "unbooked", subjectType: "draft", subjectId: d.id, phone: d.phone, email: d.email, dueAt: now })) scheduled++;
    }
    // The next morning at 10, once, after a first text that went.
    const firsts = await db.sql<{ subject_id: string; remote_key: string | null; email: string | null; updated_at: Date }>`
      select t.subject_id, t.remote_key, t.email::text as email, t.updated_at from text_sends t
      where t.flow = 'unbooked' and t.step = 1 and t.status = 'sent' and t.updated_at > ${sinceFor(s.unbooked)}::timestamptz
        and not exists (select 1 from text_sends u where u.flow = 'unbooked' and u.subject_type = 'draft' and u.subject_id = t.subject_id and u.step = 2)`;
    for (const f of firsts) {
      const day = addDays(localDate(new Date(f.updated_at), ctx.zone), 1);
      const at = wallToInstant(day, 10 * 60, ctx.zone, "forward")!;
      if (await schedule(db, { flow: "unbooked", step: 2, subjectType: "draft", subjectId: f.subject_id, phone: f.remote_key, email: f.email, dueAt: at })) scheduled++;
    }
  }

  if (s.reminder.enabled) {
    const before = s.reminder.timing ?? 1440;
    const visits = await db.sql<{ id: string; starts_at: Date; phone: string | null; email: string | null }>`
      select b.id::text as id, b.starts_at, b.phone, b.email::text as email from bookings b
      where b.status = 'confirmed' and b.type_id is not null and b.resource_id is not null and b.phone is not null
        and b.starts_at > ${now.toISOString()}::timestamptz
        and b.starts_at <= ${now.toISOString()}::timestamptz + make_interval(mins => ${before + 30})
        and b.created_at < b.starts_at - make_interval(mins => ${before})
        and not exists (select 1 from text_sends t where t.flow = 'reminder' and t.step = 1 and t.subject_type = 'booking' and t.subject_id = b.id::text || '@' || to_char(b.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'))
      limit 200`;
    for (const v of visits) {
      const at = new Date(new Date(v.starts_at).getTime() - before * 60_000);
      const subject = `${v.id}@${new Date(v.starts_at).toISOString().slice(0, 16)}`;
      if (await schedule(db, { flow: "reminder", subjectType: "booking", subjectId: subject, phone: v.phone, email: v.email, dueAt: at < now ? now : at })) scheduled++;
    }
  }

  if (s.after_visit.enabled) {
    const after = s.after_visit.timing ?? 120;
    const done = await db.sql<{ id: string; ends_at: Date; phone: string | null; email: string | null }>`
      select b.id::text as id, b.ends_at, b.phone, b.email::text as email from bookings b
      where b.status = 'completed' and b.ends_at > ${sinceFor(s.after_visit)}::timestamptz and b.ends_at < ${now.toISOString()}::timestamptz
        and (b.phone is not null or b.email is not null)
        and not exists (select 1 from text_sends t where t.flow = 'after_visit' and t.step = 1 and t.subject_type = 'booking' and t.subject_id = b.id::text)
      limit 200`;
    for (const v of done) {
      const at = new Date(new Date(v.ends_at).getTime() + after * 60_000);
      if (await schedule(db, { flow: "after_visit", subjectType: "booking", subjectId: v.id, phone: v.phone, email: v.email, dueAt: at })) scheduled++;
    }
  }

  const counts = { scheduled, sent: 0, skipped: 0, failed: 0, later: 0 };
  for (const row of await dueSends(db, now)) counts[await deliver(ctx, row, render)]++;
  return counts;
}

// ---- what each says -----------------------------------------------------------

/** What a flow's text is about, worked out as it goes. */
export async function render(ctx: PhoneCtx, row: SendRow, s: FlowSettings): Promise<Rendered> {
  const db = ctx.db;
  const now = ctx.now ? ctx.now() : new Date();
  const base: Fill = { business: ctx.business };
  switch (row.flow) {
    case "missed_call": {
      const call = await communicationById(db, row.subject_id);
      if (!call) return { skip: "the call is gone" };
      const [recent] = await db.sql`
        select 1 from text_sends where flow = 'missed_call' and remote_key = ${call.remote_key} and status in ('sent', 'sending') and updated_at > now() - interval '24 hours' and id <> ${row.id}::bigint limit 1`;
      if (recent) return { skip: "texted about a missed call in the last 24 hours" };
      const { contact } = await ownerOf(db, call.remote_key);
      // One text to every caller, any hour.
      return {
        to: { phone: call.remote_e164, email: null, name: contact?.name ?? null, contactId: contact?.id ?? null, consent: true },
        variant: "one", fill: { ...base, first_name: firstName(contact?.name) },
      };
    }
    case "thanks": {
      const [sub] = await db.sql<{ name: string | null; email: string | null; phone: string | null; text_consent: string | null }>`
        select name, email::text as email, phone, to_jsonb(s)->>'text_consent' as text_consent from submissions s where id = ${row.subject_id}::bigint`;
      if (!sub) return { skip: "the submission is gone" };
      return {
        to: { phone: sub.phone, email: sub.email, name: sub.name, contactId: null, consent: await mayText(db, sub.phone, !!sub.text_consent) },
        variant: "one", fill: { ...base, first_name: firstName(sub.name) },
      };
    }
    case "unbooked": {
      const [d] = await db.sql<{ id: string; form_key: string; name: string | null; email: string | null; phone: string | null; submission_id: string | null; text_consent: string | null; created_at: Date }>`
        select id::text as id, form_key, name, email::text as email, phone, submission_id::text as submission_id, to_jsonb(d)->>'text_consent' as text_consent, created_at
        from submission_drafts d where id = ${row.subject_id}::bigint`;
      if (!d) return { skip: "the form they started is gone" };
      if (d.submission_id) return { skip: "they finished the form" };
      const key = d.phone ? phoneKey(d.phone) : null;
      const [booked] = await db.sql`
        select 1 from bookings where status = 'confirmed' and created_at > ${new Date(d.created_at).toISOString()}::timestamptz
          and ((${d.email}::citext is not null and email = ${d.email}::citext) or (${key}::text is not null and right(regexp_replace(regexp_replace(phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key}))
        limit 1`;
      if (booked) return { skip: "they booked" };
      if (row.step > 1) {
        const [first] = await db.sql<{ updated_at: Date }>`select updated_at from text_sends where flow = 'unbooked' and step = 1 and subject_type = 'draft' and subject_id = ${row.subject_id}`;
        if (first && key) {
          const [answered] = await db.sql`
            select 1 from communications where remote_key = ${key} and created_at > ${new Date(first.updated_at).toISOString()}::timestamptz
              and (direction = 'in' or (direction = 'out' and coalesce(sent_by, '') not like 'flow:%')) limit 1`;
          if (answered) return { skip: "they replied, or someone on the team did" };
        }
      }
      const form = await formBooking(db, d.form_key);
      // One link back to the form for all of this draft's emails (texts carry none): a new one would end the last one's.
      const [earlier] = await db.sql<{ link: string }>`
        select link from text_sends where flow = 'unbooked' and subject_type = 'draft' and subject_id = ${row.subject_id} and link is not null order by step limit 1`;
      const form_link = earlier?.link ?? (await ctx.links().then((l) => (l ? draftLink(db, l, d.id, d.form_key) : null)));
      if (form_link && !earlier) await db.sql`update text_sends set link = ${form_link} where id = ${row.id}::bigint`;
      const who = { phone: d.phone, email: d.email, name: d.name, contactId: null, consent: await mayText(db, d.phone, !!d.text_consent, { boxOnly: true }) };
      const fillIn: Fill = { ...base, first_name: firstName(d.name), form_link, service: form?.type?.name ?? null };
      if (row.step > 1) return { to: who, variant: "nextday", emailVariant: "nextday", fill: fillIn };
      const offer = form?.type ? await nextThree(db, form.type, ctx.zone, now) : [];
      const times_list = offer.length ? offer.map((o) => visitTime(new Date(o.start), ctx.zone)).join("\n") : null;
      // The email lists the times it has; with none, it's the nudge.
      const emailVariant = offer.length ? "times" : "nextday";
      if (offer.length < 3) return { to: who, variant: "notimes", emailVariant, fill: { ...fillIn, times_list } };
      return { to: who, variant: "times", emailVariant, fill: { ...fillIn, slot1: offer[0].label, slot2: offer[1].label, slot3: offer[2].label, times_list }, offer };
    }
    case "booked":
    case "reminder":
    case "after_visit": {
      const id = row.subject_id.split("@")[0];
      const [b] = await db.sql<{ name: string; email: string | null; phone: string | null; starts_at: Date; ends_at: Date; status: string; text_consent: string | null; booker_time_zone: string | null; type_name: string | null; host_name: string | null; host_zone: string | null; customer_id: string | null }>`
        select b.name, b.email::text as email, b.phone, b.starts_at, b.ends_at, b.status, coalesce(to_jsonb(b)->>'text_consent', (select to_jsonb(s)->>'text_consent' from submissions s where s.id = b.submission_id)) as text_consent, b.booker_time_zone,
               t.name as type_name, r.name as host_name, r.time_zone as host_zone, to_jsonb(b)->>'customer_id' as customer_id
        from bookings b left join booking_types t on t.id = b.type_id left join resources r on r.id = b.resource_id where b.id = ${id}::bigint`;
      if (!b) return { skip: "the booking is gone" };
      const zone = b.booker_time_zone || b.host_zone || ctx.zone;
      const who = { phone: b.phone, email: b.email, name: b.name, contactId: b.customer_id, consent: await mayText(db, b.phone, !!b.text_consent, { boxOnly: row.flow === "after_visit" }) };
      const fillIn: Fill = { ...base, first_name: firstName(b.name), service: b.type_name, host: firstName(b.host_name) };
      if (row.flow === "booked") {
        if (b.status !== "confirmed") return { skip: "the booking isn't confirmed" };
        return { to: who, variant: "one", fill: { ...fillIn, time: visitTime(new Date(b.starts_at), zone) } };
      }
      if (row.flow === "reminder") {
        const at = row.subject_id.split("@")[1];
        if (b.status !== "confirmed") return { skip: "the visit isn't on any more" };
        if (at && new Date(b.starts_at).toISOString().slice(0, 16) !== at) return { skip: "the visit moved (it is reminded for its new time)" };
        if (new Date(b.starts_at) <= now) return { skip: "the visit has started" };
        return { to: who, variant: "one", fill: { ...fillIn, when: whenText(new Date(b.starts_at), zone, now) } };
      }
      if (b.status !== "completed") return { skip: "the visit wasn't marked done" };
      return { to: who, variant: "one", fill: fillIn };
    }
  }
}

/** For the flow page: a contact whose details fill the example, the most recent real one, or a sample (`sample`). */
export async function exampleFill(ctx: PhoneCtx): Promise<Fill & { sample: boolean }> {
  const [c] = await ctx.db.sql<{ name: string }>`select name from customers where name ~ '^[A-Za-z]' order by created_at desc limit 1`;
  const now = new Date();
  const links = await ctx.links();
  const form_link = `${links ? `${links.base}${links.prefix}` : "https://example.com"}/forms/quote/next?k=x7Kp2Q`;
  const types = await bookable(ctx.db);
  const offer = types[0] ? await nextThree(ctx.db, types[0], ctx.zone, now).catch(() => []) : [];
  const tomorrow = new Date(now.getTime() + 86_400_000);
  tomorrow.setUTCMinutes(0, 0, 0);
  const [host] = await ctx.db.sql<{ name: string }>`select name from resources where active order by id limit 1`;
  return {
    first_name: firstName(c?.name) ?? "Natalie", business: ctx.business, service: types[0]?.name ?? "Furnace check",
    time: visitTime(tomorrow, ctx.zone), when: whenText(tomorrow, ctx.zone, now), host: firstName(host?.name) ?? "Dan",
    slot1: offer[0]?.label ?? "Tue 9am", slot2: offer[1]?.label ?? "Tue 1pm", slot3: offer[2]?.label ?? "Wed 10am",
    form_link, number: null,
    sample: !firstName(c?.name),
  };
}

/** The flow's own 30-day outcome, for its row: sent, and booked or replied. */
export async function flowCounts(db: Db): Promise<Record<string, { sent: number; outcome: number }>> {
  const rows = await db.sql<{ flow: string; sent: number; booked: number; replied: number }>`
    select t.flow, count(*)::int as sent,
      count(*) filter (where t.flow = 'unbooked' and exists (
        select 1 from bookings b where b.created_at > t.updated_at and b.created_at < t.updated_at + interval '7 days'
          and ((t.email is not null and b.email = t.email) or (t.remote_key is not null and right(regexp_replace(regexp_replace(b.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = t.remote_key))))::int as booked,
      count(*) filter (where t.remote_key is not null and exists (
        select 1 from communications m where m.remote_key = t.remote_key and m.direction = 'in' and m.created_at > t.updated_at and m.created_at < t.updated_at + interval '3 days'))::int as replied
    from text_sends t where t.status = 'sent' and t.updated_at > now() - interval '30 days' and t.step = 1
    group by t.flow`;
  const out: Record<string, { sent: number; outcome: number }> = {};
  for (const r of rows) {
    const o = flowOf(r.flow as never)?.outcome;
    out[r.flow] = { sent: r.sent, outcome: o === "booked" ? r.booked : o === "replied" ? r.replied : 0 };
  }
  return out;
}

