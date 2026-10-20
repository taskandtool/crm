// Twilio's webhooks: calls and texts to the business's numbers, and what
// becomes of them. Mounted ahead of the app's team gate, at /hooks/twilio.
//
//   app.route("/", phoneHooks(getDb, { ctx: (c) => phoneCtx(c), ... }));
//
// They reach the app through Task & Tool's inbound route
// (`hooks.<zone>/<app token>/hooks/twilio/...`, minted by `inboundUrl`),
// which forwards to production's Worker or the machine whatever the app's
// serving state, so no public path is opened for them. Each number's
// webhook addresses carry a secret of the CRM's own as basic-auth
// credentials in the URL (user `tw`, the secret as password), which Twilio sends (after a
// 401 asking for them) and the route forwards as X-Forwarded-Authorization,
// since it uses Authorization itself; only its hash is stored. Twilio's
// own signature is not checked: it is made with the Auth Token, which a
// brokered connection never shows the app.
//
// A call: Twilio asks /voice and rings the number's `ring_to` with the
// caller's number shown; the owner hears "press 1 to answer" first
// (/screen), because a cell's own voicemail would otherwise answer and
// count as picked up. No press (busy, no answer, a hang-up): the greeting
// and a voicemail (/dialed), and the missed-call text. A text: /sms keeps
// it, answers 1, 2 or 3 to a "Stopped before booking" text by booking that
// time, and tells the owner's cell when nobody has Messages open.
import { Hono, type Context } from "hono";
import type { GetDb } from "../data/db";
import { tokenHash } from "../data/token";
import { book, toType } from "../booking/book";
import { phoneKey, saveLead, savePerson } from "../customers/customer";
import { fill, OWNER_TEXTS, SPOKEN } from "./flows";
import { nextThree, onBooked, onMissedCall, openNow, render, sendMissed } from "./follow";
import { deliver, schedule, sendById, sendText, type PhoneCtx, type Slot } from "./send";
import {
  attachRecording, attachVoicemail, byProviderId, lastSeenMessages, numberById, optedOut, ownerOf, ownerReplyDue, prettyPhone, record, toE164, updateStatus,
  type PhoneNumber,
} from "./store";
import { isRecordingSid, twiml } from "./twilio";

export type HookOpts = {
  /** This request's phone context: the owner's Twilio, the business, where links go. */
  ctx: (c: Context) => PhoneCtx | Promise<PhoneCtx>;
  /** A new person reached the business by phone (a voicemail, a reply): their lead was made. The CRM adds its Call back task. */
  onLead?: (c: Context, l: { customerId: string; leadId: string; title: string }) => void | Promise<void>;
  /** The team's link to a thread in Messages, for the owner's cell. */
  threadLink?: (c: Context, remoteKey: string) => string | null | Promise<string | null>;
};

const xml = (c: Context, body: string) => c.body(body, 200, { "Content-Type": "text/xml; charset=utf-8" });

/**
 * What a hook does besides answering Twilio runs before the answer, not
 * after it: in production the request's database is closed once the answer
 * is sent. A failure is logged and never fails the hook (Twilio would only
 * ask again).
 */
const settle = (work: Promise<unknown>) => work.catch((e) => console.error("phone:", e));

/** The secret in a webhook address, checked: the forwarded Authorization (or Authorization, off the route). */
async function authorized(c: Context, n: PhoneNumber): Promise<boolean> {
  const h = c.req.header("x-forwarded-authorization") ?? c.req.header("authorization") ?? "";
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h.trim());
  if (!m) return false;
  let pair = "";
  try {
    pair = atob(m[1]);
  } catch {
    return false;
  }
  const secret = pair.startsWith("tw:") ? pair.slice(3) : "";
  return !!secret && (await tokenHash(secret)) === n.hook_secret_hash;
}

export function phoneHooks(getDb: GetDb, opts: HookOpts) {
  const app = new Hono();

  // Every hook names its number (?n=). A call or a text coming in carries
  // that number's secret; what follows from one (the dial's result, the
  // voicemail, a delivery report) must name a call or text already kept on
  // that number, since Twilio resolves those addresses without the secret.
  const ENTRY = new Set(["voice", "sms"]);
  // "Call me to try it" answers with fixed words and touches nothing, so it needs no kept call.
  const OPEN = new Set(["test"]);
  app.use("/hooks/twilio/*", async (c, next) => {
    if (c.req.method !== "POST") return c.notFound();
    const db = getDb(c);
    const n = await numberById(db, c.req.query("n") ?? "");
    if (!n) return c.notFound();
    const hook = c.req.path.split("/").pop() ?? "";
    if (ENTRY.has(hook)) {
      if (!(await authorized(c, n))) return c.body("", 401, { "WWW-Authenticate": 'Basic realm="twilio"' });
    } else if (!OPEN.has(hook)) {
      const f = (await c.req.parseBody()) as Record<string, string>;
      // The id the hook acts on, and only that one: the owner's leg names its parent call, a
      // text's delivery report its text, everything else its own call.
      const sid = hook === "screen" || hook === "screened" ? f.ParentCallSid : hook === "status" && f.MessageStatus ? f.MessageSid : f.CallSid;
      const known = sid ? await byProviderId(db, sid) : null;
      if (!known || known.phone_number_id !== n.id) return c.body("", 403);
    }
    c.set("number" as never, n as never);
    await next();
  });
  const numberOf = (c: Context) => c.get("number" as never) as PhoneNumber;
  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>;
  // Relative to the hook Twilio called (`hooks.<zone>/<token>/hooks/twilio/voice`): a sibling, so the route's token stays in it.
  const self = (c: Context, path: string, extra: Record<string, string> = {}) =>
    `${path.replace(/^\/hooks\/twilio\//, "")}?${new URLSearchParams({ n: c.req.query("n") ?? "", ...extra })}`;

  // ---- calls ------------------------------------------------------------------

  app.post("/hooks/twilio/voice", async (c) => {
    const db = getDb(c);
    const n = numberOf(c);
    const f = await form(c);
    const from = toE164(f.From ?? "") ?? f.From ?? "unknown";
    // A call out from the CRM (click-to-call) is answered by its own TwiML (/bridge).
    if (f.Direction && f.Direction !== "inbound") return xml(c, twiml.hangup());
    const ctx = await opts.ctx(c);
    await record(db, { phoneNumberId: n.id, local: n.e164, remote: from, kind: "call", direction: "in", status: "ringing", providerId: f.CallSid ?? null });
    const greeting = n.record_calls ? fill(SPOKEN.recorded, { business: ctx.business }) : null;
    if (!n.ring_to) return xml(c, voicemailTwiml(c, n, ctx, await openNow(db)));
    return xml(c, twiml.dial({
      to: n.ring_to, callerId: from, timeout: n.ring_seconds, greeting, record: n.record_calls,
      action: self(c, "/hooks/twilio/dialed"),
      screen: self(c, "/hooks/twilio/screen"),
      recordingStatus: self(c, "/hooks/twilio/recorded", { what: "call" }),
    }));
  });

  // The owner's leg, before it connects.
  app.post("/hooks/twilio/screen", async (c) => {
    const db = getDb(c);
    const ctx = await opts.ctx(c);
    const n = numberOf(c);
    const call = await byProviderId(db, (await form(c)).ParentCallSid ?? "");
    const who = call ? (await ownerOf(db, call.remote_key)).contact?.name ?? null : null;
    const say = who ? fill(SPOKEN.screenNamed, { business: ctx.business }).replace("{caller}", who) : fill(SPOKEN.screen, { business: ctx.business });
    return xml(c, twiml.screen({ say, action: self(c, "/hooks/twilio/screened") }));
  });

  app.post("/hooks/twilio/screened", async (c) => {
    const f = await form(c);
    const pressed = f.Digits === "1";
    if (pressed && f.ParentCallSid) await updateStatus(getDb(c), f.ParentCallSid, { status: "in-progress", answeredBy: numberOf(c).ring_to ?? "owner" });
    return xml(c, twiml.accepted(pressed));
  });

  // How the ringing went: answered (someone pressed 1), or the voicemail and the missed-call text.
  app.post("/hooks/twilio/dialed", async (c) => {
    const db = getDb(c);
    const n = numberOf(c);
    const f = await form(c);
    const call = await byProviderId(db, f.CallSid);
    if (!call) return xml(c, twiml.hangup());
    // Answered means joined to the caller: someone pressed 1. A cell's own voicemail answers the screening
    // leg and hangs up there, which Twilio reports as completed, but not bridged (DialBridged).
    const bridged = f.DialBridged ? f.DialBridged === "true" : !!call.answered_by;
    if (bridged && f.DialCallStatus === "completed") {
      await updateStatus(db, f.CallSid, { status: "completed", durationS: Number(f.DialCallDuration) || null });
      return xml(c, twiml.hangup());
    }
    await updateStatus(db, f.CallSid, { status: f.DialCallStatus === "completed" ? "no-answer" : f.DialCallStatus || "no-answer" });
    const ctx = await opts.ctx(c);
    // Claimed now, sent when the call is over (the voicemail hook, or the call's end): the greeting answers at once.
    await onMissedCall(ctx, call.id, call.remote_e164);
    return xml(c, voicemailTwiml(c, n, ctx, await openNow(db)));
  });

  function voicemailTwiml(c: Context, n: PhoneNumber, ctx: PhoneCtx, open: boolean): string {
    if (!n.voicemail) return twiml.say(fill(SPOKEN.noVoicemail, { business: ctx.business }));
    const texting = n.texting === "approved" && !!ctx.provider;
    const say = !open ? fill(SPOKEN.closed, { business: ctx.business }) : texting ? SPOKEN.voicemail : SPOKEN.voicemailNoText;
    return twiml.voicemail({
      say, action: self(c, "/hooks/twilio/voicemail"), transcribe: self(c, "/hooks/twilio/transcribed"), recordingStatus: self(c, "/hooks/twilio/recorded", { what: "voicemail" }),
    });
  }

  // The voicemail is left: they are a real caller, so a lead (once per caller with no open one).
  app.post("/hooks/twilio/voicemail", async (c) => {
    const db = getDb(c);
    const f = await form(c);
    const secs = Number(f.RecordingDuration);
    // Twilio's <Record> action names the recording only in its URL (RecordingSid comes with /recorded).
    const fromUrl = /\/Recordings\/(RE[0-9a-f]{32})(?:\.\w+)?$/.exec(f.RecordingUrl ?? "")?.[1];
    const rsid = isRecordingSid(f.RecordingSid) ? f.RecordingSid : isRecordingSid(fromUrl) ? fromUrl : null;
    const call = await attachVoicemail(db, f.CallSid, { recordingSid: rsid, seconds: Number.isFinite(secs) ? secs : null });
    if (call && rsid && secs >= 2) await settle(leadFor(c, call.remote_e164, "Voicemail"));
    // They hung up after the tone: the call is over, so its missed-call text can go.
    if (call) await settle(sendMissed(await opts.ctx(c), call.id));
    return xml(c, twiml.hangup());
  });

  app.post("/hooks/twilio/transcribed", async (c) => {
    const f = await form(c);
    if (f.TranscriptionStatus === "completed") await attachVoicemail(getDb(c), f.CallSid, { transcript: (f.TranscriptionText ?? "").slice(0, 5000) || null });
    return c.body(null, 204);
  });

  app.post("/hooks/twilio/recorded", async (c) => {
    const f = await form(c);
    // A <Dial>'s recording names the call that dialed: the one the guard found.
    if (f.RecordingStatus !== "completed" || !isRecordingSid(f.RecordingSid)) return c.body(null, 204);
    if (c.req.query("what") === "call") await attachRecording(getDb(c), f.CallSid, f.RecordingSid);
    // The voicemail's own recording, in case its action came without it.
    if (c.req.query("what") === "voicemail") await attachVoicemail(getDb(c), f.CallSid, { recordingSid: f.RecordingSid });
    return c.body(null, 204);
  });

  // A call out from the CRM: the owner's phone answered, now ring the customer from the business number.
  app.post("/hooks/twilio/bridge", async (c) => {
    const n = numberOf(c);
    const to = toE164(c.req.query("to") ?? "");
    if (!to) return xml(c, twiml.hangup());
    return xml(c, twiml.bridge({ to, callerId: n.e164, record: n.record_calls, action: self(c, "/hooks/twilio/bridged"), recordingStatus: self(c, "/hooks/twilio/recorded", { what: "call" }) }));
  });

  app.post("/hooks/twilio/bridged", async (c) => {
    const f = await form(c);
    await updateStatus(getDb(c), f.CallSid, { status: f.DialCallStatus || "completed", durationS: Number(f.DialCallDuration) || null });
    return xml(c, twiml.hangup());
  });

  // "Call me to try it": the owner's phone, called from the business number.
  app.post("/hooks/twilio/test", async (c) => {
    const ctx = await opts.ctx(c);
    const n = numberOf(c);
    return xml(c, twiml.say(`This is ${ctx.business}'s business number, ${prettyPhone(n.e164).replace(/[()]/g, "")}. Calls to it ring this phone. To hear a missed call, call it from another phone and don't press 1.`));
  });

  // ---- texts ------------------------------------------------------------------

  app.post("/hooks/twilio/sms", async (c) => {
    const db = getDb(c);
    const n = numberOf(c);
    const f = await form(c);
    const from = toE164(f.From ?? "") ?? f.From ?? "";
    const body = (f.Body ?? "").slice(0, 1600);
    const ctx = await opts.ctx(c);
    // The owner answering a forwarded text from their cell: tell them where to reply, and keep nothing.
    // At most once an hour, so a phone that answers texts by itself can't start a loop.
    if (n.ring_to && from === n.ring_to) {
      if (await ownerReplyDue(db, n.id)) {
        const link = (await opts.threadLink?.(c, "")) ?? "the CRM";
        await settle(sendText(ctx, { to: from, body: fill(OWNER_TEXTS.replyHere.replace("{link}", link), { business: ctx.business }), sentBy: "flow:owner", owner: true }));
      }
      return xml(c, twiml.noReply());
    }
    const media = Array.from({ length: Math.min(Number(f.NumMedia) || 0, 10) }, (_, i) => ({ url: f[`MediaUrl${i}`], type: f[`MediaContentType${i}`] }))
      .filter((m) => /^https:\/\//.test(m.url ?? ""));
    // "Yes" or "Start" opts back in only after a STOP; before one, it is an answer like any other.
    const said = keyword(f.OptOutType, body);
    const kw = said === "start" && !(await optedOut(db, phoneKey(from) ?? "")) ? null : said;
    const text = await record(db, { phoneNumberId: n.id, local: n.e164, remote: from, kind: "text", direction: "in", status: "received", body, media, keyword: kw, providerId: f.MessageSid ?? null });
    // A text Twilio delivers twice is answered once: only the delivery that kept it goes on.
    if (!text.inserted) return xml(c, twiml.noReply());
    // A keyword (STOP, START, HELP and Twilio's other words for them) is Twilio's to answer, and it is kept;
    // the owner still hears of it, since "Cancel" or "Yes" may be meant for them as much as for Twilio.
    await settle((async () => {
      const booked = !kw && (await replyToBook(c, ctx, text.remote_e164, body));
      if (!kw && !text.contact_id) await leadFor(c, text.remote_e164, "Text");
      if (!booked) await tellOwner(c, ctx, n, text.remote_key, text.remote_e164, body);
    })());
    return xml(c, twiml.noReply());
  });

  /** A text's delivery, or a call's end, as Twilio reports it. */
  app.post("/hooks/twilio/status", async (c) => {
    const db = getDb(c);
    const f = await form(c);
    if (f.MessageSid && f.MessageStatus) {
      await updateStatus(db, f.MessageSid, {
        status: f.MessageStatus, error: f.ErrorCode ? `${f.ErrorCode}${f.ErrorMessage ? `: ${f.ErrorMessage}` : ""}` : null, errorCode: Number(f.ErrorCode) || null,
      });
    } else if (f.CallSid && f.CallStatus) {
      const call = await byProviderId(db, f.CallSid);
      // A caller who hung up while it rang: the dial never reported, so it is missed here.
      if (call && call.direction === "in" && call.status === "ringing") {
        await updateStatus(db, f.CallSid, { status: f.CallStatus === "completed" ? "no-answer" : f.CallStatus });
        // Gone within a few seconds (a pocket dial, a one-ring scam): no text.
        if (Date.now() - new Date(call.created_at).getTime() >= 6_000) await settle(onMissedCall(await opts.ctx(c), call.id, call.remote_e164, { send: true }));
      } else if (call && call.direction === "in" && !call.answered_by && f.CallStatus === "completed") {
        // A missed call over (they hung up in the greeting, or there is no voicemail): its text goes now.
        await settle(sendMissed(await opts.ctx(c), call.id));
      } else if (call && ["completed", "busy", "no-answer", "failed", "canceled"].includes(f.CallStatus)) {
        await updateStatus(db, f.CallSid, { status: call.answered_by || call.direction === "out" ? f.CallStatus : call.status, durationS: Number(f.CallDuration) || null });
      }
    }
    return c.body(null, 204);
  });

  // ---- what a text or a voicemail leads to ---------------------------------------

  /** A person new to the business reached it: their customer and a lead, unless they have one open. */
  async function leadFor(c: Context, remote: string, how: "Voicemail" | "Text"): Promise<void> {
    const db = getDb(c);
    const key = phoneKey(remote);
    if (!key) return;
    const { contact, choices } = await ownerOf(db, key);
    if (choices.length > 1 && !contact) return;
    const person = contact ?? (await savePerson(db, { name: null, email: null, phone: remote, source: how === "Text" ? "Text" : "Phone call", at: new Date() }, null));
    if (!person) return;
    const [open] = await db.sql`select 1 from leads where customer_id = ${person.id}::bigint and status = 'open' limit 1`.catch(() => [1]);
    if (open) return;
    const title = `${how} from ${prettyPhone(remote)}`;
    const leadId = await saveLead(db, { customerId: person.id, source: "phone", title }, null);
    await db.sql`update communications set contact_id = ${person.id}::bigint where remote_key = ${key} and contact_id is null`;
    if (leadId) await opts.onLead?.(c, { customerId: person.id, leadId, title });
  }

  /**
   * A reply of 1, 2 or 3 to the times a "Stopped before booking" text
   * offered, within two days: book that time if it's still free and send
   * "Booked"; gone, offer the next three, once. True when it was answered.
   */
  async function replyToBook(c: Context, ctx: PhoneCtx, remote: string, body: string): Promise<boolean> {
    const pick = /^\s*([123])\s*[.)!]?\s*$/.exec(body)?.[1];
    if (!pick) return false;
    const db = ctx.db;
    const key = phoneKey(remote);
    // An offer answers once, taken as it is read: two replies at once can't both book, and
    // whatever comes of this one, the next "1" is a message for a person.
    const [offered] = await db.sql<{ id: string; subject_id: string; step: number; offer: Slot[] }>`
      update text_sends t set offer = null
      from (select id, offer from text_sends
            where flow = 'unbooked' and remote_key = ${key} and status = 'sent' and offer is not null and updated_at > now() - interval '2 days'
            order by updated_at desc limit 1 for update skip locked) o
      where t.id = o.id and t.offer is not null
      returning t.id::text as id, t.subject_id, t.step, o.offer`;
    if (!offered) return false;
    const slot = offered.offer[Number(pick) - 1];
    if (!slot) return false;
    const [d] = await db.sql<{ id: string; form_key: string; name: string | null; email: string | null; phone: string | null; submission_id: string | null; created_at: Date }>`
      select id::text as id, form_key, name, email::text as email, phone, submission_id::text as submission_id, created_at from submission_drafts where id = ${offered.subject_id}::bigint`;
    if (!d?.email || d.submission_id) return false;
    const [already] = await db.sql`
      select 1 from bookings where status = 'confirmed' and email = ${d.email}::citext and created_at > ${new Date(d.created_at).toISOString()}::timestamptz limit 1`;
    if (already) return false;
    const [f] = await db.sql<{ fields: { type: string; booking_type?: string }[] }>`select fields from forms where key = ${d.form_key}`;
    const slug = f?.fields.find((x) => x.type === "booking")?.booking_type;
    const [t] = slug ? await db.sql`select * from booking_types where slug = ${slug}` : [];
    if (!t) return false;
    const type = toType(t);
    const r = await book(db, {
      typeId: type.id, start: new Date(slot.start), name: d.name ?? prettyPhone(remote), email: d.email, phone: d.phone ?? remote, source: "text", bookerTimeZone: ctx.zone,
      // A reply has no address: the team adds it, as for a booking taken by phone.
      addressOptional: true,
      textConsent: "Replied to a text to book",
    });
    if (r.ok) {
      await onBooked(ctx, { event: "booked", booking: r.booking });
      return true;
    }
    if (r.reason !== "taken" || offered.step >= 3) return false;
    const offer = await nextThree(db, type, ctx.zone);
    const sendId = await schedule(db, { flow: "unbooked", step: 3, subjectType: "draft", subjectId: d.id, phone: remote, email: d.email });
    if (!sendId || offer.length < 3) return false;
    const row = await sendById(db, sendId);
    if (row) {
      await deliver(ctx, row, async (cx, rw, st) => {
        const base = await render(cx, { ...rw, step: 1 }, st);
        if ("skip" in base) return base;
        return { ...base, variant: "taken", fill: { ...base.fill, slot1: offer[0].label, slot2: offer[1].label, slot3: offer[2].label }, offer };
      });
    }
    return true;
  }

  /** A text came in and nobody has opened Messages for ten minutes: the owner's cell hears of it. */
  async function tellOwner(c: Context, ctx: PhoneCtx, n: PhoneNumber, key: string, remote: string, body: string): Promise<void> {
    if (!n.ring_to || n.texting !== "approved" || !ctx.provider) return;
    const seen = await lastSeenMessages(ctx.db).catch(() => null);
    if (seen && Date.now() - new Date(seen).getTime() < 10 * 60_000) return;
    const { contact } = await ownerOf(ctx.db, key);
    const fromWho = contact ? `${contact.name} ${prettyPhone(remote)}` : prettyPhone(remote);
    // No link known (a webhook in production before any page found the address): fill drops "Reply in the CRM".
    const link = await opts.threadLink?.(c, key);
    const words = OWNER_TEXTS.forward.replace("{from}", fromWho).replace("{body}", body.slice(0, 300)).replace("{link}", link ?? "{link}");
    await sendText(ctx, { to: n.ring_to, body: fill(words, { business: ctx.business }), sentBy: "flow:owner", owner: true });
  }

  return app;
}

/** "Stop texting me", "wrong number", "remove me": opting out in their own words. */
const OPT_OUT_WORDS = /\b(stop (texting|messaging|sending|contacting)|(don['’]?t|do not) (text|message|contact) me|no more (texts|messages)|wrong number|remove me|take me off|unsubscribe( me)?|opt me out)\b/i;

/** STOP, START or HELP, as Twilio's Advanced Opt-Out names it, or as typed, or an opt-out in their own words. */
export function keyword(optOutType: string | undefined, body: string): "stop" | "start" | "help" | null {
  const t = (optOutType ?? "").toUpperCase();
  if (t === "STOP" || t === "START" || t === "HELP") return t.toLowerCase() as "stop" | "start" | "help";
  const w = body.trim().toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"].includes(w)) return "stop";
  // An opt-out in their own words counts too (the FCC's "any reasonable means", in force since April 2025).
  if (body.length <= 160 && OPT_OUT_WORDS.test(body)) return "stop";
  if (["START", "YES", "UNSTOP"].includes(w)) return "start";
  if (["HELP", "INFO"].includes(w)) return "help";
  return null;
}
