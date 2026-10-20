import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { tokenHash } from "../../data/token";
import { createPerson, createType, setHosts, addWindow } from "../../booking/hours";
import { checkWords, EMAILS, fill, flowOf, FLOWS, isQuiet, MEASURE, notQuiet, segments, setEnabled, setWords, STOP_LINE, WORDS, flowSettings } from "../flows";
import { phoneHooks, keyword } from "../hooks";
import { check, optInPage, steps } from "../registration";
import { onBooked, onSubmitted, scan } from "../follow";
import { fillEmail, sendText, type PhoneCtx } from "../send";
import { addNumber, optedOut, record, setHooks, thread, toE164 } from "../store";
import { TwilioError, type Hooks, type Provider } from "../twilio";
import { unhook } from "../setup";
import { emailOptedOut, unsubscribeLink, unsubscribeRoutes } from "../../data/unsubscribe";
import { saveBusiness } from "../../data/business";
import { textingBox } from "../../forms/consent";

const schemas = ["../../data/schema.sql", "../../booking/schema.sql", "../../forms/schema.sql", "../../customers/schema.sql", "../schema.sql"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));

/** A Twilio that keeps what it was asked to send. */
function fakeTwilio() {
  const texts: { from: string; to: string; body: string }[] = [];
  const calls: { from: string; to: string; twimlUrl: string }[] = [];
  const pointed: { id: string; hooks: Hooks }[] = [];
  const refuse = new Set<string>();
  const landlines = new Set<string>();
  let n = 0;
  const provider: Provider = {
    call: (async () => ({})) as Provider["call"],
    account: async () => ({ sid: "AC1", name: "Test", balance: "20.00", currency: "USD", trial: false }),
    searchNumbers: async () => [{ e164: "+15125550100", pretty: "(512) 555-0100", locality: "Austin", region: "TX" }],
    ownedNumbers: async () => [],
    buyNumber: async (e164) => ({ id: "PN1", e164, pretty: e164, label: null }),
    pointNumber: async (id, hooks) => void pointed.push({ id, hooks }),
    sendText: async (m) => {
      if (refuse.has(m.to)) throw new TwilioError("Attempt to send to unsubscribed recipient", 400, 21610);
      return texts.push(m), { id: `SM${++n}`, status: "queued" };
    },
    startCall: async (c) => (calls.push(c), { id: `CA${++n}` }),
    recording: async () => new Response("mp3"),
    lineType: async (e164) => (landlines.has(e164) ? "landline" : "mobile"),
  };
  return { provider, texts, calls, pointed, refuse, landlines };
}

const SECRET = "s".repeat(43);
const auth = { "X-Forwarded-Authorization": `Basic ${btoa(`tw:${SECRET}`)}` };

/** A recording id in Twilio's shape. */
const RE = "RE" + "0123456789abcdef".repeat(2);

async function setup(s: Scratch, o: { texting?: boolean; links?: boolean } = {}) {
  for (const sql of schemas) await applySchema(s.db, sql);
  const tw = fakeTwilio();
  const n = await addNumber(s.db, { e164: "+15125550100", label: "Business number", provider_id: "PN1", ring_to: "+15125559999" }, "o@x.com");
  await setHooks(s.db, n.id, "https://hooks.example/tok/hooks/twilio", await tokenHash(SECRET));
  if (o.texting !== false) await s.db.sql`update phone_numbers set texting = 'approved' where id = ${n.id}::bigint`;
  let now = new Date("2026-10-20T15:00:00Z"); // 10am in Chicago
  const ctx: PhoneCtx = {
    db: s.db, env: {}, provider: tw.provider, business: "Acme Plumbing", zone: "America/Chicago",
    links: async () => (o.links === false ? null : { base: "https://acme.example", prefix: "" }), now: () => now,
  };
  const app = phoneHooks(() => s.db, { ctx: () => ctx, threadLink: () => "https://crm.example/messages" });
  const post = (path: string, form: Record<string, string>, headers: Record<string, string> = auth) =>
    app.request(`${path}${path.includes("?") ? "&" : "?"}n=${n.id}`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { tw, n, ctx, post, setNow: (d: Date) => (now = d) };
}

async function withDb(fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return;
  try {
    await fn(s);
  } finally {
    await s.drop();
  }
}

// ---- words ---------------------------------------------------------------------

test("every default text fits one text with long real values, the STOP line too where it may be the first", () => {
  const first = new Set(["missed_call.one", "thanks.one", "unbooked.times", "unbooked.notimes", "booked.one"]);
  for (const f of FLOWS) {
    for (const [v, w] of Object.entries(WORDS[f.key])) {
      const text = fill(w, MEASURE) + (first.has(`${f.key}.${v}`) ? STOP_LINE : "");
      const seg = segments(text);
      assert.ok(seg.plain, `${f.key}.${v} has a character that is not plain: ${text}`);
      assert.equal(seg.count, 1, `${f.key}.${v} is ${text.length} characters: ${text}`);
    }
  }
});

test("a missing fill-in drops its sentence, a missing name its greeting's name", () => {
  assert.equal(fill("Hi {first_name}, it's {business}.", { business: "Acme" }), "Hi, it's Acme.");
  assert.equal(fill("Hi {first_name}, you're nearly done. Pick up here: {form_link}", { first_name: "Ann" }), "Hi Ann, you're nearly done.");
  assert.equal(fill("Looking forward! {host} from {business}.", { business: "Acme" }), "Looking forward! Acme.");
});

test("an email keeps its lines and colons; the times go one to a line", () => {
  const text = fillEmail(EMAILS.unbooked!.times.text, { first_name: "Ann", business: "Acme", form_link: "https://a.example/t/x", times_list: "Tue, Oct 21 at 9:00am\nTue, Oct 21 at 1:00pm" });
  assert.match(text, /next few open ones:\n\nTue, Oct 21 at 9:00am\nTue, Oct 21 at 1:00pm\n\nPick one/);
});

test("words are straightened, emoji refused, unknown fill-ins named", () => {
  const ok = checkWords("Hi {first_name}, it’s us — see you");
  assert.ok(ok.ok && ok.words === "Hi {first_name}, it's us - see you");
  const emoji = checkWords("See you soon \u{1F600}");
  assert.ok(!emoji.ok && /three times longer/.test(emoji.why));
  const bad = checkWords("Hi {name}");
  assert.ok(!bad.ok && /\{name\} isn't filled in here/.test(bad.why));
  // A fill-in the flow never knows is refused, not left to vanish from every text.
  const elsewhere = checkWords("Thanks! See you {when}", flowOf("missed_call").fills);
  assert.ok(!elsewhere.ok && /\{when\} isn't filled in here\. This text can use \{first_name\}, \{business\}\./.test(elsewhere.why));
  // A link is typed in the words as it is: no text carries one of ours.
  assert.ok(FLOWS.every((f) => Object.values(WORDS[f.key]).every((w) => !/_link\}|https?:/.test(w))));
});

test("quiet hours are 8pm to 8am in the business's zone, and end at 8am", () => {
  const zone = "America/Chicago";
  assert.equal(isQuiet(new Date("2026-10-20T15:00:00Z"), zone), false); // 10am
  assert.equal(isQuiet(new Date("2026-10-21T02:30:00Z"), zone), true); // 9:30pm
  assert.equal(notQuiet(new Date("2026-10-21T02:30:00Z"), zone).toISOString(), "2026-10-21T13:00:00.000Z"); // 8am CDT
});

test("STOP, START and HELP, as Twilio names them or as typed", () => {
  assert.equal(keyword("STOP", "stop please"), "stop");
  assert.equal(keyword(undefined, " Unsubscribe "), "stop");
  assert.equal(keyword(undefined, "yes"), "start");
  assert.equal(keyword(undefined, "Can you come at 2?"), null);
});

test("toE164 reads North American numbers with or without +1, and refuses the rest", () => {
  assert.equal(toE164("(512) 555-0100"), "+15125550100");
  assert.equal(toE164("1 512 555 0100 ext 4"), "+15125550100");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("555-0100"), null);
});

// ---- calls ---------------------------------------------------------------------

test("a call without the number's secret is asked for it, and a later hook naming no known call is refused", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post } = await setup(s);
    const r = await post("/hooks/twilio/voice", { CallSid: "CA9", From: "+15125550111", To: "+15125550100", Direction: "inbound" }, {});
    assert.equal(r.status, 401);
    assert.match(r.headers.get("WWW-Authenticate") ?? "", /Basic/);
    const later = await post("/hooks/twilio/dialed", { CallSid: "CAnope", DialCallStatus: "no-answer" }, {});
    assert.equal(later.status, 403);
  }));

test("a call rings the owner's cell with press 1; a missed one gets the voicemail and one text, never two in a day", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    const r = await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    const xml = await r.text();
    assert.match(xml, /<Dial timeout="20"[^>]*callerId="\+15125550111"/);
    assert.match(xml, /<Number url="screen\?n=\d+" method="POST">\+15125559999<\/Number>/);
    const screen = await (await post("/hooks/twilio/screen", { CallSid: "CA1child", ParentCallSid: "CA1" })).text();
    assert.match(screen, /Press 1 to answer/);

    const missed = await (await post("/hooks/twilio/dialed", { CallSid: "CA1", DialCallStatus: "no-answer" })).text();
    assert.match(missed, /<Record maxLength="119"/);
    assert.match(missed, /hang up and we'll text you\./);
    assert.equal(tw.texts.length, 0, "nothing while they are still listening to the greeting");
    await post("/hooks/twilio/status", { CallSid: "CA1", CallStatus: "completed" });
    assert.equal(tw.texts.length, 1, "the text goes when the call ends");
    assert.match(tw.texts[0].body, /^Hi, it's Acme Plumbing\. Sorry we missed your call!/);
    assert.match(tw.texts[0].body, /Reply STOP to opt out\.$/);

    await post("/hooks/twilio/voice", { CallSid: "CA2", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    await post("/hooks/twilio/dialed", { CallSid: "CA2", DialCallStatus: "busy" });
    await post("/hooks/twilio/status", { CallSid: "CA2", CallStatus: "completed" });
    assert.equal(tw.texts.length, 1, "a second missed call the same day gets no second text");
  }));

test("pressing 1 answers the call; the call is kept as answered, with no text", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    const ok = await (await post("/hooks/twilio/screened", { CallSid: "CA1child", ParentCallSid: "CA1", Digits: "1" })).text();
    assert.doesNotMatch(ok, /Hangup/);
    await post("/hooks/twilio/dialed", { CallSid: "CA1", DialCallStatus: "completed", DialCallDuration: "95" });
    const [call] = await thread(s.db, "5125550111");
    assert.equal(call.answered_by, "+15125559999");
    assert.equal(call.duration_s, 95);
    assert.equal(tw.texts.length, 0);
  }));

test("a missed call gets one text at any hour, and a link the owner types goes as it is", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    const { person } = await service(s);
    // Team hours only on a day that isn't today: the text is the same.
    const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Chicago" }).format(new Date()));
    await s.db.sql`delete from availability where resource_id = ${person.id}::bigint`;
    await addWindow(s.db, person.id, String((today + 3) % 7), "09:00", "17:00", "o@x.com");
    const w = await setWords(s.db, "missed_call", "one", "Hi, it's {business}. Sorry we missed you! Book a time here: https://acme.example/book", "o@x.com");
    assert.ok(w.ok);
    await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    await post("/hooks/twilio/dialed", { CallSid: "CA1", DialCallStatus: "no-answer" });
    await post("/hooks/twilio/status", { CallSid: "CA1", CallStatus: "completed" });
    assert.match(tw.texts[0].body, /^Hi, it's Acme Plumbing\. Sorry we missed you! Book a time here: https:\/\/acme\.example\/book Reply STOP/);
  }));

test("a cell's own voicemail answering is a missed call (not bridged), and gets the missed-call text once", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    // The owner's voicemail took the screening leg: completed, but never joined to the caller.
    const xml = await (await post("/hooks/twilio/dialed", { CallSid: "CA1", DialCallStatus: "completed", DialBridged: "false" })).text();
    assert.match(xml, /<Record /);
    await post("/hooks/twilio/voicemail", { CallSid: "CA1", RecordingSid: RE, RecordingDuration: "14" });
    await post("/hooks/twilio/status", { CallSid: "CA1", CallStatus: "completed" });
    assert.equal(tw.texts.filter((t) => t.to === "+15125550111").length, 1, "once, though the voicemail and the call's end both came");
    assert.match(tw.texts.find((t) => t.to === "+15125550111")!.body, /^Hi, it's Acme Plumbing\. Sorry we missed your call! Reply here with what you need/);
  }));

test("a voicemail, as Twilio's <Record> action names it (only in its URL), makes the caller a contact and a lead", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post } = await setup(s);
    await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    await post("/hooks/twilio/dialed", { CallSid: "CA1", DialCallStatus: "no-answer" });
    await post("/hooks/twilio/voicemail", { CallSid: "CA1", RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${RE}`, RecordingDuration: "12" });
    const [vm] = await s.db.sql<{ voicemail_sid: string }>`select voicemail_sid from communications where provider_id = 'CA1'`;
    assert.equal(vm.voicemail_sid, RE);
    await new Promise((res) => setTimeout(res, 80));
    const leads = await s.db.sql`select l.title, l.source, c.phone from leads l join customers c on c.id = l.customer_id`;
    assert.equal(leads.length, 1);
    assert.equal(leads[0].source, "phone");
    assert.equal(leads[0].title, "Voicemail from (512) 555-0111");
  }));

// ---- the texting registration --------------------------------------------------

test("the registration is read from Twilio as the owner makes it in the Console, and never made by API", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { tw, n } = await setup(s, { texting: false });
    const asked: string[] = [];
    let campaign = "IN_PROGRESS";
    tw.provider.call = (async (method: string, host: string, path: string) => {
      asked.push(`${method} ${host} ${path}`);
      if (path === "/v1/CustomerProfiles") return { results: [{ sid: "BU1", status: "twilio-approved" }] };
      if (path === "/v1/a2p/BrandRegistrations") return { data: [{ sid: "BN1", status: "APPROVED", errors: [] }] };
      if (path === "/v1/Services") return { services: [{ sid: "MG0", friendly_name: "Other" }, { sid: "MG1", friendly_name: "Acme texts", use_inbound_webhook_on_number: false }] };
      if (path === "/v1/Services/MG0/PhoneNumbers") return { phone_numbers: [{ sid: "PN9" }] };
      if (path === "/v1/Services/MG1/PhoneNumbers") return { phone_numbers: [{ sid: "PN1" }] };
      if (path === "/v1/Services/MG1/Compliance/Usa2p") return { compliance: [{ sid: "QE1", campaign_status: campaign, errors: [] }] };
      return {};
    }) as Provider["call"];
    let r = await check(s.db, tw.provider, n);
    assert.equal(r.texting, "pending");
    assert.deepEqual(r.reg.service, { sid: "MG1", name: "Acme texts" });
    // The one change: the service sends texts to the number's webhook, which is ours.
    assert.deepEqual(asked.filter((a) => a.startsWith("POST")), ["POST messaging /v1/Services/MG1"]);
    const business = { name: "Acme Plumbing", privacyUrl: "https://acme.example/privacy", termsUrl: null, address: null };
    const rows = steps({ ...n, registration: r.reg }, business, "https://acme.example/forms/quote", await flowSettings(s.db));
    assert.deepEqual(rows.map((x) => x.state), ["done", "done", "waiting"]);
    const paste = rows[2].paste!;
    assert.match(paste.find((p) => p.field === "Sample message 1")!.words, /^Hi Christopher, it's Acme Plumbing\. Sorry we missed your call!/);
    // What reviewers read is the box customers see, on the page they can open.
    const flow = paste.find((p) => p.field.startsWith("How do end-users consent"))!.words;
    assert.match(flow, /for example https:\/\/acme\.example\/forms\/quote/);
    await saveBusiness(s.db, business, "o@x.com");
    assert.ok(flow.includes(`'${await textingBox(s.db, "request")}'`));
    assert.equal(paste.find((p) => p.field.startsWith("Opt-in page"))!.words, "https://acme.example/forms/quote");
    // Our texts carry no link and no number, so the campaign says so, and its three samples agree.
    const said = (rows: ReturnType<typeof steps>, field: string) => rows[2].paste!.find((p) => p.field === field)?.words;
    assert.equal(said(rows, "Messages will include embedded links"), "No");
    assert.equal(said(rows, "Messages will include phone numbers"), "No");
    assert.equal(said(rows, "Sample message 4"), undefined);
    // An owner's review link: the answer turns Yes, and a sample shows it (Twilio 30889).
    await setEnabled(s.db, "after_visit", true, "o@x.com");
    await setWords(s.db, "after_visit", "one", "Hi {first_name}, thanks from {business}! A review helps: https://g.page/r/acme/review", "o@x.com");
    const linked = steps({ ...n, registration: r.reg }, business, null, await flowSettings(s.db));
    assert.equal(said(linked, "Messages will include embedded links"), "Yes");
    assert.match(said(linked, "Sample message 4")!, /https:\/\/g\.page\/r\/acme\/review/);
    assert.equal(said(linked, "Messages will include phone numbers"), "No");
    campaign = "VERIFIED";
    r = await check(s.db, tw.provider, { ...n, registration: r.reg });
    assert.equal(r.texting, "approved");
  }));

test("a toll-free number is verified, read by its number, with the date a turned-down one can be fixed by", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { tw } = await setup(s, { texting: false });
    const n = await addNumber(s.db, { e164: "+18885550100", label: "Toll-free", provider_id: "PN2", ring_to: null }, "o@x.com");
    tw.provider.call = (async (_m: string, _h: string, path: string, params?: Record<string, unknown>) =>
      path === "/v1/Tollfree/Verifications" && params?.TollfreePhoneNumberSid === "PN2"
        ? { verifications: [{ sid: "HH1", status: "TWILIO_REJECTED", rejection_reasons: [{ reason: "Opt-in image not accessible" }], edit_allowed: true, edit_expiration: "2026-10-23T00:00:00Z" }] }
        : {}) as Provider["call"];
    const r = await check(s.db, tw.provider, n);
    assert.equal(r.texting, "failed");
    const [row] = steps({ ...n, registration: r.reg }, { name: "Acme Plumbing", privacyUrl: null, termsUrl: null, address: null }, null, await flowSettings(s.db));
    assert.deepEqual(row.errors, ["Opt-in image not accessible"]);
    assert.match(row.says, /before 2026-10-23/);
  }));

// ---- texts ---------------------------------------------------------------------

test("STOP opts the number out: nothing more goes to it, a person's text included", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, ctx } = await setup(s);
    await post("/hooks/twilio/sms", { MessageSid: "SMa", From: "+15125550111", To: "+15125550100", Body: "STOP", OptOutType: "STOP" });
    assert.equal(await optedOut(s.db, "5125550111"), true);
    const r = await sendText(ctx, { to: "+15125550111", body: "Are you still there?", sentBy: "o@x.com" });
    assert.ok(!r.ok && /opted out/.test(r.why));
    await post("/hooks/twilio/sms", { MessageSid: "SMb", From: "+15125550111", To: "+15125550100", Body: "START", OptOutType: "START" });
    assert.equal(await optedOut(s.db, "5125550111"), false);
  }));

test("a text the owner forwards from their cell is not a customer's: they're told where to reply", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    await post("/hooks/twilio/sms", { MessageSid: "SMa", From: "+15125559999", To: "+15125550100", Body: "on my way" });
    await post("/hooks/twilio/sms", { MessageSid: "SMb", From: "+15125559999", To: "+15125550100", Body: "and again" });
    assert.equal((await thread(s.db, "5125559999")).length, 0, "the owner's cell is not a thread in Messages");
    assert.equal(tw.texts.length, 1, "told once an hour at most, so a phone that answers by itself can't loop");
    assert.match(tw.texts[0].body, /^Reply in the CRM so it comes from Acme Plumbing's number: https:\/\/crm\.example\/messages$/);
  }));

test("a later hook acts only on the call it names, and a recording id is Twilio's shape or nothing", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    await post("/hooks/twilio/sms", { MessageSid: "SMknown", From: "+15125550111", To: "+15125550100", Body: "hello" });
    // A known text's id beside a call nobody kept: refused, so no missed-call text goes.
    const forged = await post("/hooks/twilio/dialed", { MessageSid: "SMknown", CallSid: "CAnobody", DialCallStatus: "no-answer" });
    assert.equal(forged.status, 403);
    await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    await post("/hooks/twilio/voicemail", { CallSid: "CA1", RecordingSid: "../IncomingPhoneNumbers/PN1", RecordingDuration: "12" });
    const [call] = (await thread(s.db, "5125550111")).filter((m) => m.kind === "call");
    assert.equal(call.voicemail_sid, null);
    assert.equal(tw.texts.filter((t) => t.to === "+15125550111").length, 0, "no missed-call text from the forged hook");
  }));

test("a text Twilio delivers twice is answered once, and a plain Yes is an answer, not an opt-in", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post } = await setup(s);
    await post("/hooks/twilio/sms", { MessageSid: "SM1", From: "+15125550111", To: "+15125550100", Body: "Yes", OptOutType: "START" });
    await post("/hooks/twilio/sms", { MessageSid: "SM1", From: "+15125550111", To: "+15125550100", Body: "Yes", OptOutType: "START" });
    const rows = await thread(s.db, "5125550111");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].keyword, null, "no STOP before it, so Yes answered a question");
    const [lead] = await s.db.sql`select title from leads`;
    assert.equal(lead?.title, "Text from (512) 555-0111", "and they are a lead like any new texter");
  }));

test("a text before approval is refused with the reason", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx } = await setup(s, { texting: false });
    const r = await sendText(ctx, { to: "+15125550111", body: "Hi", sentBy: "o@x.com" });
    assert.ok(!r.ok && /approves your number/.test(r.why));
  }));

// ---- the flows ---------------------------------------------------------------------

/** A service with an open host every weekday from 9 to 5 in Chicago. */
async function service(s: Scratch) {
  const p = await createPerson(s.db, { name: "Dan Ruiz", email: "dan@example.com", time_zone: "America/Chicago" }, "o@x.com", "test");
  const t = await createType(s.db, {
    name: "Furnace check", slug: "furnace", duration_min: "60", interval_min: "60", buffer_before_min: "0", buffer_after_min: "0",
    min_notice_min: "0", horizon_days: "30", location_kind: "their_place", location: "",
  }, "o@x.com", "test");
  assert.ok(p.ok && t.ok);
  await setHosts(s.db, t.value.id, [p.value.id]);
  for (const d of [1, 2, 3, 4, 5]) await addWindow(s.db, p.value.id, String(d), "09:00", "17:00", "o@x.com");
  return { person: p.value, type: t.value };
}

test("a form that follows up thanks them by text when they ticked the box, and not when they didn't", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw } = await setup(s);
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('quote', 'Quote request', '[{"name":"name","label":"Name","type":"text"},{"name":"phone","label":"Phone","type":"tel"}]', true)`;
    const [yes] = await s.db.sql<{ id: string }>`insert into submissions (form_key, name, phone, source, text_consent) values ('quote', 'Natalie Ruiz', '512-555-0123', 'test', 'Text me') returning id::text as id`;
    const [no] = await s.db.sql<{ id: string }>`insert into submissions (form_key, name, phone, source) values ('quote', 'Tom', '512-555-0124', 'test') returning id::text as id`;
    await onSubmitted(ctx, yes.id);
    await onSubmitted(ctx, no.id);
    await onSubmitted(ctx, yes.id);
    assert.equal(tw.texts.length, 1, "once, and only to the one who agreed");
    assert.equal(tw.texts[0].to, "+15125550123");
    assert.match(tw.texts[0].body, /^Hi Natalie, it's Acme Plumbing\. Thanks for reaching out/);
    const [skipped] = await s.db.sql<{ why: string }>`select why from text_sends where subject_id = ${no.id}`;
    assert.match(skipped.why, /didn't agree to texts/);
  }));

test("a form left before booking gets three times, and a reply of 2 books the second", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, post, setNow } = await setup(s);
    await service(s);
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('furnace-form', 'Furnace check request',
      '[{"name":"name","label":"Name","type":"text"},{"name":"email","label":"Email","type":"email"},{"name":"phone","label":"Phone","type":"tel"},{"name":"when","label":"Pick a time","type":"booking","booking_type":"furnace"}]', true)`;
    await s.db.sql`insert into submission_drafts (form_key, key_hash, step, name, email, phone, source, text_consent, updated_at, created_at)
      values ('furnace-form', 'h1', 1, 'Natalie Ruiz', 'nat@example.com', '512-555-0123', 'test', 'Text me', '2026-10-20T14:30:00Z', '2026-10-20T14:28:00Z')`;
    setNow(new Date("2026-10-20T15:00:00Z"));
    const r = await scan(ctx);
    assert.equal(r.sent, 1);
    assert.match(tw.texts[0].body, /^Hi Natalie, it's Acme Plumbing\. Reply 1, 2 or 3 to book: 1\) Tue \d+(am|pm) 2\) .+ 3\) .+, or a time that suits you\./);

    const [offer] = await s.db.sql<{ offer: { start: string }[] }>`select offer from text_sends where flow = 'unbooked'`;
    await post("/hooks/twilio/sms", { MessageSid: "SMr", From: "+15125550123", To: "+15125550100", Body: "2" });
    await new Promise((res) => setTimeout(res, 150));
    const [b] = await s.db.sql<{ starts_at: Date; text_consent: string }>`select starts_at, text_consent from bookings`;
    assert.equal(new Date(b.starts_at).toISOString(), offer.offer[1].start);
    assert.ok(b.text_consent);
    assert.match(tw.texts.at(-1)!.body, /^Hi Natalie, you're booked with Acme Plumbing for /);

    // An offer answers once: a second reply, or the same text delivered twice, books nothing more.
    await post("/hooks/twilio/sms", { MessageSid: "SMr", From: "+15125550123", To: "+15125550100", Body: "2" });
    await post("/hooks/twilio/sms", { MessageSid: "SMs", From: "+15125550123", To: "+15125550100", Body: "3" });
    assert.equal((await s.db.sql`select id from bookings`).length, 1);

    // The next morning's nudge is never sent: they booked.
    setNow(new Date("2026-10-21T15:05:00Z"));
    await scan(ctx);
    assert.equal(tw.texts.filter((t) => /checking in/.test(t.body)).length, 0);
  }));

test("the day before a visit: looking forward to it, once; a move reminds again for the new time", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, setNow } = await setup(s);
    const { person, type } = await service(s);
    const [b] = await s.db.sql<{ id: string }>`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status, text_consent, created_at)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-22T15:00:00Z', '2026-10-22T16:00:00Z', 'Natalie Ruiz', 'nat@example.com', '512-555-0123', 'their_place', 'confirmed', 'Text me', '2026-10-18T12:00:00Z')
      returning id::text as id`;
    setNow(new Date("2026-10-21T15:05:00Z"));
    await scan(ctx);
    assert.equal(tw.texts.length, 1);
    assert.equal(tw.texts[0].body, "Hi Natalie, looking forward to seeing you tomorrow at 10:00am! Dan from Acme Plumbing. Reply here if anything changes. Reply STOP to opt out.");
    await scan(ctx);
    assert.equal(tw.texts.length, 1);
    await s.db.sql`update bookings set starts_at = '2026-10-23T15:00:00Z', ends_at = '2026-10-23T16:00:00Z' where id = ${b.id}::bigint`;
    setNow(new Date("2026-10-22T15:05:00Z"));
    await scan(ctx);
    assert.equal(tw.texts.length, 2);
  }));

test("quiet hours hold an automatic text to 8am", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, setNow } = await setup(s);
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('quote', 'Quote', '[{"name":"phone","label":"Phone","type":"tel"}]', true)`;
    const [sub] = await s.db.sql<{ id: string }>`insert into submissions (form_key, name, phone, source, text_consent) values ('quote', 'Natalie', '512-555-0123', 'test', 'Text me') returning id::text as id`;
    setNow(new Date("2026-10-21T03:00:00Z")); // 10pm in Chicago
    await onSubmitted(ctx, sub.id);
    assert.equal(tw.texts.length, 0);
    const [row] = await s.db.sql<{ due_at: Date; status: string }>`select due_at, status from text_sends`;
    assert.equal(row.status, "due");
    assert.equal(new Date(row.due_at).toISOString(), "2026-10-21T13:00:00.000Z");
    setNow(new Date("2026-10-21T13:05:00Z"));
    await scan(ctx);
    assert.equal(tw.texts.length, 1);
  }));

test("a flow switched off sends nothing, and changed words are what goes", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw } = await setup(s);
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('quote', 'Quote', '[{"name":"phone","label":"Phone","type":"tel"}]', true)`;
    const ins = async (phone: string) => (await s.db.sql<{ id: string }>`insert into submissions (form_key, name, phone, source, text_consent) values ('quote', 'Natalie', ${phone}, 'test', 'Text me') returning id::text as id`)[0].id;
    await setEnabled(s.db, "thanks", false, "o@x.com");
    await onSubmitted(ctx, await ins("512-555-0123"));
    assert.equal(tw.texts.length, 0);
    await setEnabled(s.db, "thanks", true, "o@x.com");
    const w = await setWords(s.db, "thanks", "one", "Thanks {first_name}! {business} will call you today.", "ai");
    assert.ok(w.ok);
    await onSubmitted(ctx, await ins("512-555-0124"));
    assert.equal(tw.texts[0].body, "Thanks Natalie! Acme Plumbing will call you today. Reply STOP to opt out.");
    assert.equal((await flowSettings(s.db)).thanks.changed, true);
  }));

test("a booking's confirmation says to reply to change it: the manage link is its email's", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw } = await setup(s);
    const { person, type } = await service(s);
    const [b] = await s.db.sql<{ id: string; phone: string; email: string }>`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status, text_consent)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-22T15:00:00Z', '2026-10-22T16:00:00Z', 'Natalie Ruiz', 'nat@example.com', '512-555-0123', 'their_place', 'confirmed', 'Text me')
      returning id::text as id, phone, email::text as email`;
    await onBooked(ctx, { event: "booked", booking: b });
    assert.match(tw.texts[0].body, /^Hi Natalie, you're booked with Acme Plumbing for Thu, Oct 22 at 10:00am\. Reply here if you need to change it\./);
  }));

test("turning After the visit on texts nobody about a visit done before it was on", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, setNow } = await setup(s);
    const { person, type } = await service(s);
    // Done yesterday, while the flow was off (ours is off).
    await s.db.sql`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status, text_consent)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-19T15:00:00Z', '2026-10-19T16:00:00Z', 'Natalie Ruiz', 'nat@example.com', '512-555-0123', 'their_place', 'completed', 'Text me')`;
    await setEnabled(s.db, "after_visit", true, "o@x.com");
    setNow(new Date(Date.now() + 60_000));
    await scan(ctx);
    assert.equal(tw.texts.length, 0);
    const [r] = await s.db.sql<{ n: number }>`select count(*)::int as n from text_sends where flow = 'after_visit'`;
    assert.equal(r.n, 0);
  }));

test("a booking made inside a form gets Booked once it is confirmed, and no thank-you", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw } = await setup(s);
    const { person, type } = await service(s);
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('book', 'Book a visit', ${JSON.stringify([{ name: "when", label: "When", type: "booking", booking_type: type.slug }])}::jsonb, true)`;
    const [sub] = await s.db.sql<{ id: string }>`
      insert into submissions (form_key, name, email, phone, data, source, text_consent) values ('book', 'Natalie Ruiz', 'nat@example.com', '512-555-0123', '{}', 'test', 'Text me') returning id::text as id`;
    await s.db.sql`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status, submission_id)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-22T15:00:00Z', '2026-10-22T16:00:00Z', 'Natalie Ruiz', 'nat@example.com', '512-555-0123', 'their_place', 'confirmed', ${sub.id}::bigint)`;
    await onSubmitted(ctx, sub.id);
    assert.equal(tw.texts.length, 1);
    assert.match(tw.texts[0].body, /^Hi Natalie, you're booked with Acme Plumbing for Thu, Oct 22 at 10:00am\./);
    await onSubmitted(ctx, sub.id);
    assert.equal(tw.texts.length, 1, "once");
  }));

test("a send Twilio refuses because they opted out (21610) is kept as their STOP; a report of it later too", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, post } = await setup(s);
    tw.refuse.add("+15125550111");
    const r = await sendText(ctx, { to: "+15125550111", body: "Are you still there?", sentBy: "o@x.com" });
    assert.ok(!r.ok && /opted out/.test(r.why));
    assert.equal(await optedOut(s.db, "5125550111"), true);
    // Through a messaging service the refusal can come later, in the delivery report.
    const sent = await sendText(ctx, { to: "+15125550122", body: "Hi", sentBy: "o@x.com" });
    assert.ok(sent.ok && sent.communication);
    await post("/hooks/twilio/status", { MessageSid: sent.communication.provider_id!, MessageStatus: "failed", ErrorCode: "21610" });
    assert.equal(await optedOut(s.db, "5125550122"), true);
  }));

test("Stop using a number points its calls straight at the phone it rang and its texts away, and keeps it on Twilio", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { tw, n } = await setup(s);
    await unhook(s.db, tw.provider, n);
    assert.deepEqual(tw.pointed, [{ id: "PN1", hooks: { voice: "https://twimlets.com/forward?PhoneNumber=%2B15125559999", sms: "", status: "", fallback: null } }]);
    const [left] = await s.db.sql<{ n: number }>`select count(*)::int as n from phone_numbers`;
    assert.equal(left.n, 0);
  }));

test("a caller gone within seconds gets no text; a landline caller gets none either", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post, tw } = await setup(s);
    await post("/hooks/twilio/voice", { CallSid: "CA1", From: "+15125550111", To: "+15125550100", Direction: "inbound" });
    await post("/hooks/twilio/status", { CallSid: "CA1", CallStatus: "completed" });
    assert.equal(tw.texts.filter((t) => t.to === "+15125550111").length, 0, "hung up while it rang, at once");
    tw.landlines.add("+15125550133");
    await post("/hooks/twilio/voice", { CallSid: "CA2", From: "+15125550133", To: "+15125550100", Direction: "inbound" });
    await post("/hooks/twilio/dialed", { CallSid: "CA2", DialCallStatus: "no-answer" });
    await post("/hooks/twilio/status", { CallSid: "CA2", CallStatus: "completed" });
    assert.equal(tw.texts.filter((t) => t.to === "+15125550133").length, 0);
    const [why] = await s.db.sql<{ why: string }>`select why from text_sends where flow = 'missed_call'`;
    assert.equal(why.why, "a landline can't get texts");
  }));

test("an opt-out in their own words is a STOP; an ordinary text about a stopped drain is not", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { post } = await setup(s);
    await post("/hooks/twilio/sms", { MessageSid: "SM1", From: "+15125550111", To: "+15125550100", Body: "The drain is stopped up again" });
    assert.equal(await optedOut(s.db, "5125550111"), false);
    await post("/hooks/twilio/sms", { MessageSid: "SM2", From: "+15125550111", To: "+15125550100", Body: "Please stop texting me" });
    assert.equal(await optedOut(s.db, "5125550111"), true);
  }));

test("an opt-out in their own words: iPhone's curly apostrophe counts, asking for a call instead doesn't", () => {
  assert.equal(keyword(undefined, "Don’t text me again"), "stop");
  assert.equal(keyword(undefined, "Wrong number"), "stop");
  assert.equal(keyword(undefined, "Don't text, call me instead"), null);
  assert.equal(keyword(undefined, "No more texts please"), "stop");
});

test("the booking confirmation goes past the three a day and at 11pm; the review text needs the ticked box", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, setNow } = await setup(s);
    const { person, type } = await service(s);
    // Three automatic texts to this number already today.
    for (const i of [1, 2, 3]) await s.db.sql`
      insert into text_sends (flow, step, subject_type, subject_id, remote_key, status, channel, due_at, updated_at) values ('thanks', 1, 'submission', ${String(900 + i)}, '5125550123', 'sent', 'text', now(), now())`;
    // 11pm where the business is, at the database's own now (the confirmation goes within minutes of the booking).
    setNow(new Date());
    const offset = ((23 - new Date().getUTCHours() + 36) % 24) - 12;
    ctx.zone = offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
    const [b] = await s.db.sql<{ id: string; phone: string; email: string }>`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status, text_consent)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-22T15:00:00Z', '2026-10-22T16:00:00Z', 'Natalie Ruiz', 'nat@example.com', '512-555-0123', 'their_place', 'confirmed', 'Text me')
      returning id::text as id, phone, email::text as email`;
    await onBooked(ctx, { event: "booked", booking: b });
    assert.equal(tw.texts.length, 1, "the confirmation goes at once, cap or no cap, night or no night");
    // A caller who only rang the business (no box) gets no review request by text.
    await record(s.db, { phoneNumberId: null, local: "+15125550100", remote: "+15125550144", kind: "call", direction: "in", status: "no-answer", providerId: "CAx" });
    await s.db.sql`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-20T15:00:00Z', '2026-10-20T16:00:00Z', 'Rae Kim', null, '512-555-0144', 'their_place', 'completed')`;
    await setEnabled(s.db, "after_visit", true, "o@x.com");
    await s.db.sql`update text_flows set enabled_at = '2026-10-19T00:00:00Z' where key = 'after_visit'`;
    ctx.zone = "America/Chicago";
    setNow(new Date("2026-10-21T15:00:00Z"));
    await scan(ctx);
    assert.equal(tw.texts.filter((t) => t.to === "+15125550144").length, 0);
  }));

test("an unsubscribe link stops the follow-up emails to that address, at a press, not an open", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    await setup(s);
    await saveBusiness(s.db, { name: "Acme Plumbing" }, "o@x.com");
    const link = await unsubscribeLink(s.db, "https://acme.example", "nat@example.com");
    const k = new URL(link).searchParams.get("k")!;
    const app = unsubscribeRoutes(() => s.db, { page: (_c, _t, body) => String(body) });
    assert.match(await (await app.request(`/unsubscribe?k=${k}`)).text(), /Stop these emails from Acme Plumbing\?/);
    assert.equal(await emailOptedOut(s.db, "nat@example.com"), false, "opening the link changes nothing");
    assert.match(await (await app.request(`/unsubscribe?k=${k}`, { method: "POST" })).text(), /won(&#39;|')t get these emails/);
    assert.equal(await emailOptedOut(s.db, "NAT@example.com"), true);
  }));

test("a form or a booking on the Website gets its text from the CRM's scan within the hour; an older one gets nothing", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    const { ctx, tw, setNow } = await setup(s);
    const { person, type } = await service(s);
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('quote', 'Quote', '[{"name":"phone","label":"Phone","type":"tel"}]', true)`;
    setNow(new Date("2026-10-20T15:00:00Z"));
    // The Website wrote these rows and nothing else: no text_sends of its own.
    await s.db.sql`insert into submissions (form_key, name, phone, source, text_consent, completed_at) values
      ('quote', 'Natalie', '512-555-0123', 'website', 'Text me', '2026-10-20T14:50:00Z'),
      ('quote', 'Old', '512-555-0124', 'website', 'Text me', '2026-10-20T13:00:00Z')`;
    await s.db.sql`
      insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, status, text_consent, created_at)
      values (${type.id}::bigint, ${person.id}::bigint, '2026-10-22T15:00:00Z', '2026-10-22T16:00:00Z', 'Rae Kim', null, '512-555-0125', 'their_place', 'confirmed', 'Text me', '2026-10-20T14:55:00Z')`;
    const r = await scan(ctx);
    assert.equal(r.scheduled, 2);
    assert.deepEqual(tw.texts.map((t) => t.to).sort(), ["+15125550123", "+15125550125"]);
    assert.match(tw.texts.find((t) => t.to === "+15125550125")!.body, /^Hi Rae, you're booked with Acme Plumbing/);
    await scan(ctx);
    assert.equal(tw.texts.length, 2, "each once");
  }));

test("the texting box shows once there's a number and a name, before texting is approved, and names the pages", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    await setup(s, { texting: false });
    assert.equal(await textingBox(s.db, "request"), null, "no name: no box, never one that says 'us'");
    const bad = await saveBusiness(s.db, { privacyUrl: "acme.example/privacy" }, "o@x.com");
    assert.ok(!bad.ok && bad.field === "privacyUrl");
    await saveBusiness(s.db, { name: "  Acme   Plumbing ", privacyUrl: "https://acme.example/privacy" }, "o@x.com");
    await saveBusiness(s.db, { termsUrl: "https://acme.example/terms" }, "o@x.com");
    assert.equal(await textingBox(s.db, "booking"),
      "Text me about this booking from Acme Plumbing. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms: https://acme.example/terms Privacy: https://acme.example/privacy");
    await s.db.sql`delete from phone_numbers`;
    assert.equal(await textingBox(s.db, "request"), null, "no number: no box");
  }));

test("the registration names the page a customer last ticked the box on, else a form's own page", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withDb(async (s) => {
    await setup(s);
    const links = { base: "https://acme.example", prefix: "" as const };
    await s.db.sql`insert into forms (key, title, fields, follow_up) values ('quote', 'Quote', '[{"name":"phone","label":"Phone","type":"tel"}]', true)`;
    assert.equal(await optInPage(s.db, links), "https://acme.example/forms/quote/start");
    await s.db.sql`insert into submissions (form_key, name, phone, source, page) values ('quote', 'Natalie', '512-555-0123', 'website', '/contact')`;
    assert.equal(await optInPage(s.db, links), "https://acme.example/contact");
    assert.equal(await optInPage(s.db, { base: "https://crm.example", prefix: "/q" }), "https://crm.example/q/forms/quote/start", "the Website's page is not on the CRM's site");
    assert.equal(await optInPage(s.db, null), null, "no page customers can open: none to name");
  }));
