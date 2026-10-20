// Sending: a text a person or a flow sends, and the automatic texts' claims
// and rules. Every automatic text is a `text_sends` row, claimed before it
// goes so two runs never send it twice; what it says is worked out when it
// goes (`deliver`), from what it is about, so a text that waited for 8am
// says what is true at 8am. Edge-safe: the CRM's production Worker sends
// the missed-call text and its own pages' texts; the job sends the rest.
//
// The rules (docs/plans/crm-calls-and-texts.md, "The rules every flow keeps"):
// - consent: a ticked box, or they called or texted first
// - never to a number that said STOP, or a contact marked Don't text
// - consent by box only for a text that isn't an answer to them (the nudge
//   to finish booking, the review request)
// - nothing automatic from 8pm to 8am in the business's zone, but the
//   missed-call text and a confirmation or thank-you within minutes of
//   what they did
// - at most three automatic texts to a number a day, the booking's
//   confirmation and reminder neither stopped nor counted
// - none to a landline (Twilio Lookup, once per number)
// - the first text a number gets carries the STOP line
// - by email instead, for the flows that can, when a text can't go
import type { Db } from "../data/db";
import { setting, type Env } from "../data/env";
import { emailsCustomers, sendEmail } from "../data/send";
import { newToken, tokenHash } from "../data/token";
import { emailOptedOut, unsubscribeLink } from "../data/unsubscribe";
import { phoneKey } from "../customers/customer";
import { EMAILS, fill, flowOf, flowSettings, isQuiet, notQuiet, STOP_LINE, type Fill, type FlowKey, type FlowSettings } from "./flows";
import { canText, mainNumber, OPTED_OUT, optedOut, reachedUs, record, textedBefore, toE164, type Communication, type PhoneNumber } from "./store";
import { TwilioError, type Provider, type SentText } from "./twilio";

/** Where a customer's pages are (an email's link back to their form, its unsubscribe link): the Website's address, or the CRM's /q. Null while customers can't open them. */
export type Links = { base: string; prefix: "" | "/q" };

export type PhoneCtx = {
  db: Db;
  /** For email, and to know whether this runtime can email a customer. */
  env: Env;
  /** The owner's Twilio here, or null (not connected, or not reachable from this runtime). */
  provider: Provider | null;
  /** The business's name (data/business.ts), or "us" until it is set. */
  business: string;
  /** No business name set yet, so `business` is the stand-in "us": the pages say so. */
  unnamed?: boolean;
  /** The business's time zone: quiet hours and "tomorrow". */
  zone: string;
  /** Where customers' pages are, asked only when an email needs one (finding out can take a request). */
  links: () => Promise<Links | null>;
  /** The business's postal address (data/business.ts), for the follow-up emails CAN-SPAM counts as commercial. */
  address?: string | null;
  /** The status callback for texts (hooks.ts), when this runtime knows it. */
  statusUrl?: string | null;
  now?: () => Date;
};

const nowOf = (ctx: PhoneCtx) => (ctx.now ? ctx.now() : new Date());

// ---- one text -----------------------------------------------------------------

/** `communication` is null only for a notice to the owner (not kept). */
export type TextResult = { ok: true; communication: Communication | null } | { ok: false; why: string };

/**
 * Send one text from the business number and keep it. `sentBy` is a
 * person's email, `flow:<key>`, or `ai`. A person may text any number that
 * has not opted out (the consent rule is for automatic texts). `owner`: a
 * notice to the owner's own cell, which is not a customer's thread: it is
 * not kept in Messages and carries no STOP line.
 */
export async function sendText(
  ctx: PhoneCtx,
  t: { to: string; body: string; sentBy: string; contactId?: string | null; from?: PhoneNumber | null; owner?: boolean },
): Promise<TextResult> {
  if (!ctx.provider) return { ok: false, why: "Twilio isn't connected to this app." };
  const from = t.from ?? (await mainNumber(ctx.db));
  if (!from) return { ok: false, why: "There's no business number yet: choose one in Settings, Phone and texts." };
  if (from.texting !== "approved") return { ok: false, why: "Texting starts when Twilio approves your number (Settings, Phone and texts)." };
  const to = toE164(t.to);
  if (!to) return { ok: false, why: "That isn't a phone number we can text." };
  const key = phoneKey(to)!;
  if (!t.owner && (await optedOut(ctx.db, key))) return { ok: false, why: "This number has opted out of texts." };
  const body = t.body.trim() + (t.owner || (await textedBefore(ctx.db, key)) ? "" : STOP_LINE);
  const kept = { phoneNumberId: from.id, local: from.e164, remote: to, kind: "text" as const, direction: "out" as const, body, sentBy: t.sentBy, contactId: t.contactId ?? null };
  let sent: SentText;
  try {
    sent = await ctx.provider.sendText({ from: from.e164, to, body, statusUrl: t.owner ? null : ctx.statusUrl ?? null });
  } catch (e) {
    // Opted out at Twilio (a STOP the app never saw): kept as their STOP, so nothing more is tried.
    const out = e instanceof TwilioError && e.code === OPTED_OUT;
    if (!t.owner) await record(ctx.db, { ...kept, status: "failed", keyword: out ? "stop" : null });
    if (out) return { ok: false, why: "This number has opted out of texts." };
    return { ok: false, why: `Twilio didn't send it: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (t.owner) return { ok: true, communication: null };
  return { ok: true, communication: await record(ctx.db, { ...kept, status: sent.status, providerId: sent.id }) };
}

// ---- automatic texts: the claims -----------------------------------------------

export type SubjectType = "call" | "submission" | "draft" | "booking";

/** A text a flow will send, once: the row is unique per flow, step and subject. */
export async function schedule(
  db: Db,
  s: { flow: FlowKey; step?: number; subjectType: SubjectType; subjectId: string; phone?: string | null; email?: string | null; dueAt?: Date },
): Promise<string | null> {
  const key = s.phone ? phoneKey(s.phone) : null;
  const [r] = await db.sql<{ id: string }>`
    insert into text_sends (flow, step, subject_type, subject_id, remote_key, email, due_at)
    values (${s.flow}, ${s.step ?? 1}, ${s.subjectType}, ${s.subjectId}, ${key}, ${s.email ?? null}::citext, ${(s.dueAt ?? new Date()).toISOString()}::timestamptz)
    on conflict (flow, step, subject_type, subject_id) do nothing
    returning id::text as id`;
  return r?.id ?? null;
}

export type Slot = { start: string; label: string };
export type SendRow = {
  id: string; flow: FlowKey; step: number; subject_type: SubjectType; subject_id: string; remote_key: string | null; email: string | null;
  due_at: Date; link: string | null; offer: Slot[] | null; created_at: Date; updated_at: Date;
};

/** Every row due by now, oldest first. */
export async function dueSends(db: Db, now: Date, limit = 200): Promise<SendRow[]> {
  return db.sql<SendRow>`
    select id::text as id, flow, step, subject_type, subject_id, remote_key, email::text as email, due_at, link, offer, created_at, updated_at
    from text_sends where status = 'due' and due_at <= ${now.toISOString()}::timestamptz order by due_at, id limit ${limit}`;
}

export async function sendById(db: Db, id: string): Promise<SendRow | null> {
  const [r] = await db.sql<SendRow>`
    select id::text as id, flow, step, subject_type, subject_id, remote_key, email::text as email, due_at, link, offer, created_at, updated_at
    from text_sends where id = ${id}::bigint`;
  return r ?? null;
}

/** What a flow's text is about, worked out when it goes: who, how to reach them, and what to fill in. */
export type Rendered =
  | { skip: string }
  | {
      to: { phone: string | null; email: string | null; name: string | null; contactId: string | null; consent: boolean };
      /** The variant for a text, and for an email (when the flow has one). */
      variant: string;
      emailVariant?: string;
      fill: Fill;
      /** The times this text offers, kept so a reply of 1, 2 or 3 books one. */
      offer?: Slot[];
    };

export type Renderer = (ctx: PhoneCtx, row: SendRow, s: FlowSettings) => Promise<Rendered>;

/**
 * Send one claimed automatic text, by text or by email, or say why not.
 * Quiet hours move it to 8am (the missed-call text excepted). Returns what
 * happened, for the job's report.
 */
export async function deliver(ctx: PhoneCtx, row: SendRow, render: Renderer): Promise<"sent" | "skipped" | "failed" | "later"> {
  const db = ctx.db;
  const now = nowOf(ctx);
  const [claimed] = await db.sql`update text_sends set status = 'sending', updated_at = now() where id = ${row.id}::bigint and status = 'due' returning id`;
  if (!claimed) return "skipped";
  const finish = async (status: "sent" | "skipped" | "failed" | "due", why: string | null, extra: { communicationId?: string | null; dueAt?: Date; channel?: "text" | "email"; key?: string | null; email?: string | null; offer?: Slot[] } = {}) => {
    await db.sql`
      update text_sends set status = ${status}, why = ${why}, communication_id = coalesce(${extra.communicationId ?? null}::bigint, communication_id),
        offer = coalesce(${extra.offer ? JSON.stringify(extra.offer) : null}::jsonb, offer),
        due_at = coalesce(${extra.dueAt?.toISOString() ?? null}::timestamptz, due_at), channel = coalesce(${extra.channel ?? null}, channel),
        remote_key = coalesce(${extra.key ?? null}, remote_key), email = coalesce(${extra.email ?? null}::citext, email), updated_at = now()
      where id = ${row.id}::bigint`;
  };
  try {
    const settings = (await flowSettings(db))[row.flow];
    if (!settings.enabled) return (await finish("skipped", "the flow is off"), "skipped");
    // Quiet hours first: what it says (and the links it makes) is worked out only when it goes. A reply to
    // what the person just did goes at any hour: the missed-call text, and a confirmation or thank-you
    // within minutes of their booking or form (someone booking at 11pm expects it then).
    const answering = row.flow === "missed_call" || (ANSWERS.has(row.flow) && now.getTime() - new Date(row.created_at).getTime() < 10 * 60_000);
    if (!answering && isQuiet(now, ctx.zone)) return (await finish("due", "quiet hours", { dueAt: notQuiet(now, ctx.zone) }), "later");
    const r = await render(ctx, row, settings);
    if ("skip" in r) return (await finish("skipped", r.skip), "skipped");

    const flow = flowOf(row.flow);
    const phone = r.to.phone ? toE164(r.to.phone) : null;
    const key = phone ? phoneKey(phone) : null;
    const number = ctx.provider ? await canText(db) : null;
    const reachable = !!(number && phone && key && r.to.consent && !(await optedOut(db, key)));
    const landline = reachable && (await isLandline(ctx, phone!, key!));
    const allowed = reachable && !landline;
    // Three a day at most; past that it goes by email where the flow has one, as any text that can't go.
    // A confirmation or reminder is never held back by the cap (it is what they need most), nor counted in it.
    const capped = allowed && !UNCAPPED.has(row.flow) && (await textsToday(db, key!, row.id)) >= 3;
    const textable = allowed && !capped;
    if (textable) {
      const body = fill(settings.words[r.variant] ?? "", r.fill);
      const sent = await sendText(ctx, { to: phone!, body, sentBy: `flow:${row.flow}`, contactId: r.to.contactId, from: number });
      if (!sent.ok) return (await finish("failed", sent.why, { channel: "text", key }), "failed");
      return (await finish("sent", null, { communicationId: sent.communication?.id, channel: "text", key, offer: r.offer }), "sent");
    }
    const mail = flow.email ? EMAILS[row.flow]?.[r.emailVariant ?? r.variant] : undefined;
    if (mail && r.to.email && emailsCustomers(ctx.env)) {
      // An unsubscribe stops the follow-ups it came on, never a booking's own confirmation or reminder.
      const commercial = COMMERCIAL.has(row.flow);
      if (commercial && (await emailOptedOut(db, r.to.email))) return (await finish("skipped", "they unsubscribed from these emails", { channel: "email" }), "skipped");
      const footer = commercial ? await emailFooter(ctx, r.to.email) : "";
      const sent = await sendEmail(ctx.env, {
        to: [r.to.email], subject: fill(mail.subject, r.fill), text: fillEmail(mail.text, r.fill) + footer, replyTo: setting(ctx.env, "NOTIFY_REPLY_TO") ?? null,
      });
      if (sent.status === "failed") return (await finish("failed", sent.error, { channel: "email", email: r.to.email }), "failed");
      if (sent.status === "none") return (await finish("skipped", sent.why, { channel: "email" }), "skipped");
      return (await finish("sent", null, { channel: "email", email: r.to.email }), "sent");
    }
    if (capped) return (await finish("skipped", "three automatic texts to this number today already"), "skipped");
    if (landline) return (await finish("skipped", mail ? "a landline can't get texts, and no email to send instead" : "a landline can't get texts"), "skipped");
    return (await finish("skipped", whyNot({ provider: !!ctx.provider, number: !!number, phone: !!phone, consent: r.to.consent, flowEmails: !!mail, email: !!r.to.email })), "skipped");
  } catch (e) {
    await finish("failed", e instanceof Error ? e.message : String(e));
    return "failed";
  }
}

/** Follow-up emails that CAN-SPAM counts as commercial: they carry the business's address and an unsubscribe link. */
const COMMERCIAL = new Set<FlowKey>(["unbooked", "after_visit"]);

/** The end of a commercial follow-up email: who sent it, where they are, and how to stop these. */
async function emailFooter(ctx: PhoneCtx, email: string): Promise<string> {
  const links = await ctx.links();
  const stop = links ? `Unsubscribe: ${await unsubscribeLink(ctx.db, `${links.base}${links.prefix}`, email)}` : 'Don\'t want these emails? Reply "unsubscribe" and we\'ll stop.';
  return `\n\n--\n${[ctx.business, ctx.address].filter(Boolean).join(", ")}\n${stop}`;
}

/** An email's words keep their lines; a missing fill-in drops its line. */
export function fillEmail(text: string, f: Fill): string {
  return text
    .replace("{times_list}", f.times_list ?? "{times_list}")
    .split("\n")
    .map((line) => (line.trim() ? fill(line, f, { line: true }) : ""))
    .filter((line, i, all) => line || (i > 0 && all[i - 1] !== ""))
    .join("\n");
}

function whyNot(o: { provider: boolean; number: boolean; phone: boolean; consent: boolean; flowEmails: boolean; email: boolean }): string {
  if (!o.provider || !o.number) return o.flowEmails ? "no texting yet, and no email to send instead" : "texting isn't set up yet";
  if (!o.phone) return "no phone number to text";
  if (!o.consent) return o.flowEmails && o.email ? "they didn't agree to texts, and no email sender to send instead" : "they didn't agree to texts";
  return "this number opted out of texts";
}

/** Lines that can't take a text (Twilio Lookup's types). A Lookup that can't say counts as able. */
const NO_TEXTS = new Set(["landline", "fixedVoip", "tollFree", "pager", "voicemail"]);

/** Whether a number is a landline, asked of Twilio once per number and kept (phone_lines). */
async function isLandline(ctx: PhoneCtx, phone: string, key: string): Promise<boolean> {
  const [known] = await ctx.db.sql<{ line_type: string | null }>`select line_type from phone_lines where remote_key = ${key}`;
  if (known) return NO_TEXTS.has(known.line_type ?? "");
  const type = await ctx.provider!.lineType(phone);
  if (type) await ctx.db.sql`insert into phone_lines (remote_key, line_type) values (${key}, ${type}) on conflict (remote_key) do nothing`;
  return NO_TEXTS.has(type ?? "");
}

/** Flows that answer what the person just did, and so go at night when sent within minutes of it. */
const ANSWERS = new Set<FlowKey>(["thanks", "booked"]);
/** Flows the three-a-day cap neither stops nor counts: the booking's own confirmation and reminder. */
const UNCAPPED = new Set<FlowKey>(["booked", "reminder"]);

/**
 * Automatic texts to a number in the last 24 hours (the cap's: not the
 * confirmations and reminders): sent, or being sent by
 * another run at this moment (the job and a webhook can both be sending to
 * it), this one aside.
 */
async function textsToday(db: Db, key: string, self: string): Promise<number> {
  const [r] = await db.sql<{ n: number }>`
    select count(*)::int as n from text_sends
    where remote_key = ${key} and id <> ${self}::bigint and updated_at > now() - interval '24 hours'
      and flow <> all(${[...UNCAPPED]}::text[]) and ((status = 'sent' and channel = 'text') or status = 'sending')`;
  return r.n;
}

/**
 * Whether they agreed: a ticked box, or they called or texted first. `boxOnly`
 * for a text that isn't an answer to them (the nudge to finish booking, the
 * review request): calling once is consent to hear back about that call, not
 * to these.
 */
export async function mayText(db: Db, phone: string | null, ticked: boolean, o: { boxOnly?: boolean } = {}): Promise<boolean> {
  if (ticked) return true;
  if (o.boxOnly) return false;
  const key = phone ? phoneKey(phone) : null;
  return key ? reachedUs(db, key) : false;
}

// ---- the link an email carries ----------------------------------------------------

/** A draft's link back, at the step they stopped on, for its emails: a second key, so the page they have open keeps working. */
export async function draftLink(db: Db, links: Links, draftId: string, formKey: string): Promise<string> {
  const key = newToken();
  await db.sql`update submission_drafts set text_key_hash = ${await tokenHash(key)} where id = ${draftId}::bigint`;
  return `${links.base}${links.prefix}/forms/${formKey}/next?k=${key}`;
}
