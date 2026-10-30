// The automatic texts: six flows, each a small definition the sender, the
// flow's picture (admin.tsx FlowPicture) and the AI's command all read, so
// what is shown is what is sent. Our words are here; an owner's changes
// are `text_flows` rows (only what differs), and deleting the row brings
// ours back. The words, their lengths and why each says what it says:
// docs/plans/crm-calls-and-texts-messages.md in the platform repo.
//
// A text is one 160-character segment of plain characters (GSM-7): one
// emoji or curly quote makes the whole text the 70-character kind. Saving
// words straightens quotes and dashes and refuses emoji (`checkWords`).
// Edge-safe.
import type { Db } from "../data/db";
import { addDays, localDate, wallClock, wallToInstant } from "../booking/slots";
import { prettyPhone } from "./store";

const FLOW_KEYS = ["missed_call", "thanks", "unbooked", "booked", "reminder", "after_visit"] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];

/** One step of a flow, as its picture shows it and its sender runs it. */
export type Step =
  | { kind: "start"; says: string }
  | { kind: "wait"; says: string }
  | { kind: "text"; variants: { key: string; label?: string; email?: string }[]; replies?: { when: string; then: string }[] }
  | { kind: "end"; says: string };

export type Flow = {
  key: FlowKey;
  name: string;
  /** One line on the flow's row. */
  summary: string;
  /** On when the owner has not said otherwise. */
  on: boolean;
  /** Where it runs, said on its picture. */
  where: string;
  /** The flow's own timing, in minutes, where it has one: its choices and ours. */
  timing?: { choices: number[]; ours: number; says: (min: number) => string };
  /** The fill-ins its texts can use: what it knows about each person and visit. */
  fills: FillKey[];
  steps: (t: number | null) => Step[];
  stops: string[];
  /** What the 30-day count counts besides sends. */
  outcome: "booked" | "replied" | null;
  /** Whether it can go by email when it cannot text. */
  email: boolean;
};

const minutes = (m: number) => (m < 60 ? `${m} minutes` : m % 60 === 0 ? (m === 60 ? "1 hour" : `${m / 60} hours`) : `${m} minutes`);

export const FLOWS: Flow[] = [
  {
    key: "missed_call",
    name: "Missed call",
    summary: "A call nobody picked up gets a text as soon as the call ends.",
    on: true,
    where: "Every call to your business number.",
    fills: ["first_name", "business"],
    steps: () => [
      { kind: "start", says: "Someone calls, nobody presses 1 to answer, and they hang up (after leaving a voicemail, or not)" },
      {
        kind: "text",
        variants: [{ key: "one" }],
        replies: [{ when: "They reply", then: "it's in Messages for you, and they become a lead" }],
      },
      { kind: "end", says: "Done." },
    ],
    stops: ["they said STOP", "they got this text in the last 24 hours", "they hung up within six seconds", "it's a landline"],
    outcome: "replied",
    email: false,
  },
  {
    key: "thanks",
    name: "Thanks for reaching out",
    summary: "A form that doesn't book gets a thank-you right away.",
    on: true,
    where: 'Forms with "Follow up automatically" on and no booking step.',
    fills: ["first_name", "business"],
    steps: () => [
      { kind: "start", says: "Someone sends the form" },
      { kind: "text", variants: [{ key: "one" }], replies: [{ when: "They reply", then: "it's in Messages for you" }] },
      { kind: "end", says: "Done." },
    ],
    stops: ["they said STOP"],
    outcome: "replied",
    email: true,
  },
  {
    key: "unbooked",
    name: "Stopped before booking",
    summary: "Someone who leaves a form before booking gets three times to pick from.",
    on: true,
    where: 'Forms with "Follow up automatically" on and a booking step.',
    fills: ["first_name", "business", "service", "slot1", "slot2", "slot3"],
    timing: { choices: [10, 30, 60], ours: 10, says: (m) => `${minutes(m)} to ${minutes(m + 15)} later` },
    steps: (t) => [
      { kind: "start", says: "Someone fills in the form and leaves before booking" },
      { kind: "wait", says: `${FLOWS_BY().unbooked.timing!.says(t ?? 10)} (texts 8am to 8pm only)` },
      {
        kind: "text",
        variants: [{ key: "times", label: "With three open times this week" }, { key: "notimes", label: "When there aren't three open times this week", email: "nextday" }],
        replies: [
          { when: "They reply 1, 2 or 3", then: 'booked, and "Booked" goes' },
          { when: "That time is gone", then: "they get new times" },
          { when: "They reply anything else", then: "it's yours in Messages; this flow stops" },
        ],
      },
      { kind: "wait", says: "The next morning at 10, if they haven't booked or replied" },
      { kind: "text", variants: [{ key: "nextday" }] },
      { kind: "end", says: "Done. Never a third text." },
    ],
    stops: ["they book", "they said STOP", "someone on your team replies"],
    outcome: "booked",
    email: true,
  },
  {
    key: "booked",
    name: "Booked",
    summary: "Every booking gets a confirmation right away.",
    on: true,
    where: "Every booking, online or made by your team, from someone who agreed to texts.",
    fills: ["first_name", "business", "service", "host", "time"],
    steps: () => [
      { kind: "start", says: "Someone books" },
      { kind: "text", variants: [{ key: "one" }] },
      { kind: "end", says: "Done. Their confirmation email goes as well." },
    ],
    stops: ["they said STOP"],
    outcome: null,
    email: false,
  },
  {
    key: "reminder",
    name: "Looking forward to it",
    summary: "The day before a visit, a text to say you'll see them.",
    on: true,
    where: "Every booking from someone who agreed to texts.",
    fills: ["first_name", "business", "service", "host", "when"],
    timing: { choices: [1440, 120], ours: 1440, says: (m) => (m === 1440 ? "The day before, at the time of the visit (texts 8am to 8pm only)" : `${minutes(m)} before the visit (texts 8am to 8pm only)`) },
    steps: (t) => [
      { kind: "start", says: "A visit is coming up" },
      { kind: "wait", says: FLOWS_BY().reminder.timing!.says(t ?? 1440) },
      { kind: "text", variants: [{ key: "one" }], replies: [{ when: "They reply", then: "it's in Messages for you" }] },
      { kind: "end", says: "Done. Skipped when they booked less than a day ahead." },
    ],
    stops: ["the visit is cancelled or moved (moved: it goes again for the new time)", "they said STOP"],
    outcome: "replied",
    email: false,
  },
  {
    key: "after_visit",
    name: "After the visit",
    summary: "A thank-you after the visit. Add your review link to the words to ask for a review.",
    on: false,
    where: "Every visit marked done. A visit nobody marks done gets nothing.",
    fills: ["first_name", "business", "service", "host"],
    timing: { choices: [60, 120, 240], ours: 120, says: (m) => `${minutes(m)} after the visit ends (texts 8am to 8pm only)` },
    steps: (t) => [
      { kind: "start", says: "A visit is marked done" },
      { kind: "wait", says: FLOWS_BY().after_visit.timing!.says(t ?? 120) },
      { kind: "text", variants: [{ key: "one" }] },
      { kind: "end", says: "Done. The same to everyone: asking only happy customers for reviews breaks Google's rules and the FTC's." },
    ],
    stops: ["the visit was cancelled or a no-show", "they said STOP"],
    outcome: null,
    email: true,
  },
];

let byKey: Record<FlowKey, Flow> | null = null;
function FLOWS_BY(): Record<FlowKey, Flow> {
  return (byKey ??= Object.fromEntries(FLOWS.map((f) => [f.key, f])) as Record<FlowKey, Flow>);
}
export const flowOf = (key: FlowKey): Flow => FLOWS_BY()[key];
export const isFlowKey = (k: unknown): k is FlowKey => typeof k === "string" && (FLOW_KEYS as readonly string[]).includes(k);

/** Our words: flow → variant → text. `{fill-ins}` are filled per person (FILL_INS). */
export const WORDS: Record<FlowKey, Record<string, string>> = {
  missed_call: {
    one: "Hi {first_name}, it's {business}. Sorry we missed your call! Reply here with what you need and we'll get back to you soon.",
  },
  thanks: {
    one: "Hi {first_name}, it's {business}. Thanks for reaching out, we got your request! You'll hear from us soon, or text here anytime.",
  },
  unbooked: {
    times: "Hi {first_name}, it's {business}. Reply 1, 2 or 3 to book: 1) {slot1} 2) {slot2} 3) {slot3}, or a time that suits you.",
    notimes: "Hi {first_name}, it's {business}. Reply with a time that works for you and we'll get you booked.",
    nextday: "Hi {first_name}, just checking in from {business}. Still want to get that booked? Reply with a time that works.",
    taken: "Sorry, that time just went! How about 1) {slot1} 2) {slot2} 3) {slot3}? Or reply with a time that suits you.",
  },
  booked: {
    one: "Hi {first_name}, you're booked with {business} for {time}. Reply here if you need to change it.",
  },
  reminder: {
    one: "Hi {first_name}, looking forward to seeing you {when}! {host} from {business}. Reply here if anything changes.",
  },
  after_visit: {
    one: "Hi {first_name}, it's {business}. Thanks for having us today! Reply here if there's anything else we can do.",
  },
};

/** The emails flows 2, 3 and 6 send instead when they cannot text. */
export const EMAILS: Partial<Record<FlowKey, Record<string, { subject: string; text: string }>>> = {
  thanks: {
    one: {
      subject: "We got your request",
      text: "Hi {first_name},\n\nThanks for reaching out to {business}. We got your request and you'll hear from us soon. If anything changes, reply to this email.\n\n{business}",
    },
  },
  unbooked: {
    times: {
      subject: "Pick a time for your {service}",
      text: "Hi {first_name},\n\nThanks for your request. You stopped just before picking a time, so here are the next few open ones:\n\n{times_list}\n\nPick one of these or another time here: {form_link}\n\nYour answers are saved. If none of these suit you, reply with a time that does.\n\n{business}",
    },
    nextday: {
      subject: "Still want a time?",
      text: "Hi {first_name},\n\nJust checking in. Your request is saved and one step from booked: {form_link}\n\nOr reply with a time that works for you.\n\n{business}",
    },
  },
  after_visit: {
    one: {
      subject: "Thanks from {business}",
      text: "Hi {first_name},\n\nThanks for having us today. Reply to this email if there's anything else we can do.\n\n{business}",
    },
  },
};

/** What callers hear, and the replies to keywords. */
export const SPOKEN = {
  recorded: "Thanks for calling {business}. This call may be recorded.",
  screen: "Call for {business}. Press 1 to answer.",
  screenNamed: "Call for {business} from {caller}. Press 1 to answer.",
  voicemail: "Sorry we missed you. Leave a message after the tone, or hang up and we'll text you.",
  voicemailNoText: "Sorry we missed you. Leave a message after the tone and we'll call you back.",
  closed: "Thanks for calling {business}. We're closed right now. Leave a message after the tone and we'll call you back.",
  noVoicemail: "Sorry we missed you. Please call again soon.",
};
export const KEYWORD_REPLIES = {
  help: "{business}: texts about your requests and visits. Call or text {number}. Reply STOP to opt out.",
  stop: "You won't get more texts from {business}. Reply START to get them again.",
  start: "Texts from {business} are back on. Reply STOP to opt out.",
};
/** A text a person forwards to the owner's cell, and the answer to a reply from it. */
export const OWNER_TEXTS = {
  forward: "Text for {business} from {from}: {body} Reply in the CRM: {link}",
  replyHere: "Reply in the CRM so it comes from {business}'s number: {link}",
};
export const STOP_LINE = " Reply STOP to opt out.";
export const FILL_INS = [
  "first_name", "business", "time", "when", "host", "service", "slot1", "slot2", "slot3", "times_list",
  "form_link", "number",
] as const;
export type FillKey = (typeof FILL_INS)[number];
export type Fill = Partial<Record<FillKey, string | null>>;

/** What each fill-in becomes, as the words editor explains them. */
export const FILL_SAYS: Record<FillKey, string> = {
  first_name: 'their first name (left out when it isn\'t known: "Hi, it\'s...")', business: "your business's name", time: "the visit's day and time",
  when: '"tomorrow at 2pm"', host: "who they're seeing", service: "the service", slot1: "the first open time", slot2: "the second open time",
  slot3: "the third open time", times_list: "the open times, a line each", form_link: "a link back to their form",
  number: "your business number",
};

/**
 * Words with their fill-ins, as a person reads them. A missing name drops
 * "{first_name}" with its comma ("Hi," stays), a missing host its "{host}
 * from", any other missing fill-in its sentence.
 */
export function fill(words: string, f: Fill, o: { line?: boolean } = {}): string {
  let s = words;
  if (!f.first_name) s = s.replace(/ \{first_name\}(?=,)/g, "").replace(/\{first_name\}/g, "there");
  if (!f.host) s = s.replace(/\{host\} from /g, "");
  s = s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = (f as Record<string, string | null | undefined>)[k];
    return v ?? `\u0000${k}`;
  });
  if (s.includes("\u0000")) {
    // Drop each sentence that still has a missing fill-in, and the "Pick one here:" that led into it.
    const parts = s.split(/(?<=[.!?:])\s+/);
    s = parts.filter((part, i) => !part.includes("\u0000") && !(part.endsWith(":") && parts[i + 1]?.includes("\u0000"))).join(" ");
  }
  // Words that ended on a dropped fill-in end with a full stop; an email's line keeps its colon.
  s = s.replace(/\s+/g, " ").trim();
  return o.line ? s : s.replace(/:$/, ".");
}

// ---- the plain characters a text may hold ------------------------------------------

const GSM = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€",
);
const EXTENDED = new Set("^{}\\[~]|€");

/** Straightened: curly quotes, dashes, ellipses and odd spaces as their plain forms. */
function plainText(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-") // tropes-allow
    .replace(/…/g, "...")
    .replace(/[    ]/g, " ");
}

/** How many texts it sends as: 160 a text (153 each when split), 70 (67) once any character is not plain. */
export function segments(s: string): { count: number; plain: boolean } {
  const chars = [...s];
  const plain = chars.every((c) => GSM.has(c));
  const len = plain ? chars.reduce((n, c) => n + (EXTENDED.has(c) ? 2 : 1), 0) : chars.length;
  const one = plain ? 160 : 70;
  const many = plain ? 153 : 67;
  return { count: len <= one ? 1 : Math.ceil(len / many), plain };
}

/** The longest real values a text is measured with: a 20-letter business. */
export const MEASURE: Fill = {
  first_name: "Christopher", business: "Lakeside Home Repair", time: "Wed, Sep 30 at 10:30am", when: "tomorrow at 10:30am",
  host: "Alexandra", service: "Furnace check", slot1: "Wed 10am", slot2: "Wed 1pm", slot3: "Thu 10am",
  form_link: "https://lakesidehome.com/forms/quote/next?k=x7Kp2Qa", number: "(555) 201-0142",
};

/**
 * Words the owner asked for, made safe to save: straightened, emoji refused,
 * fill-ins checked, and how many texts it sends as with long real values.
 */
export function checkWords(words: string, fills: readonly string[] = FILL_INS): { ok: true; words: string; texts: number } | { ok: false; why: string } {
  const w = plainText(words.trim());
  if (!w) return { ok: false, why: "The words are empty." };
  if (w.length > 600) return { ok: false, why: "That is too long: at most 600 characters, and one text is 160." };
  const unknown = [...w.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !fills.includes(k));
  if (unknown.length) return { ok: false, why: `{${unknown[0]}} isn't filled in here. This text can use ${fills.map((k) => `{${k}}`).join(", ")}.` };
  const seg = segments(fill(w, MEASURE));
  if (!seg.plain) return { ok: false, why: "An emoji or special character makes the text three times longer (70 characters a text). Use plain letters." };
  return { ok: true, words: w, texts: seg.count };
}

// ---- the owner's changes --------------------------------------------------------

/** `enabledAt`: when the owner last turned it on (null for ours, never switched). */
export type FlowSettings = { enabled: boolean; words: Record<string, string>; timing: number | null; changed: boolean; enabledAt: Date | null };

/** Each flow's switch, words and timing: ours, with the owner's changes over them (words only for texts it still has). */
export async function flowSettings(db: Db): Promise<Record<FlowKey, FlowSettings>> {
  const rows = await db.sql<{ key: string; enabled: boolean | null; words: Record<string, string>; timing: number | null; enabled_at: Date | null }>`
    select key, enabled, words, timing, enabled_at from text_flows`;
  const out = {} as Record<FlowKey, FlowSettings>;
  for (const f of FLOWS) {
    const r = rows.find((x) => x.key === f.key);
    const timing = r?.timing != null && f.timing?.choices.includes(r.timing) ? r.timing : (f.timing?.ours ?? null);
    const theirs = Object.entries(r?.words ?? {}).filter(([v]) => Object.hasOwn(WORDS[f.key], v));
    out[f.key] = { enabled: r?.enabled ?? f.on, words: { ...WORDS[f.key], ...Object.fromEntries(theirs) }, timing, changed: !!r, enabledAt: r?.enabled_at ? new Date(r.enabled_at) : null };
  }
  return out;
}

export async function setEnabled(db: Db, key: FlowKey, enabled: boolean, by: string): Promise<void> {
  await db.sql`
    insert into text_flows (key, enabled, enabled_at, updated_by) values (${key}, ${enabled}, ${enabled ? new Date().toISOString() : null}::timestamptz, ${by})
    on conflict (key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now(),
      -- Turned on from off (ours counts as its default): the moment it may start from.
      enabled_at = case when excluded.enabled and not coalesce(text_flows.enabled, ${flowOf(key).on}) then now() else text_flows.enabled_at end`;
}

/** New words for one variant, checked first. */
export async function setWords(db: Db, key: FlowKey, variant: string, words: string, by: string): Promise<{ ok: true; texts: number } | { ok: false; why: string }> {
  if (!Object.hasOwn(WORDS[key], variant)) return { ok: false, why: `${flowOf(key).name} has no "${variant}" wording. It has: ${Object.keys(WORDS[key]).join(", ")}.` };
  const c = checkWords(words, flowOf(key).fills);
  if (!c.ok) return c;
  await db.sql`
    insert into text_flows (key, words, updated_by) values (${key}, ${JSON.stringify({ [variant]: c.words })}::jsonb, ${by})
    on conflict (key) do update set words = text_flows.words || excluded.words, updated_by = excluded.updated_by, updated_at = now()`;
  return { ok: true, texts: c.texts };
}

export async function setTiming(db: Db, key: FlowKey, minutes: number, by: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const t = flowOf(key).timing;
  if (!t) return { ok: false, why: `${flowOf(key).name} has no timing to change.` };
  if (!t.choices.includes(minutes)) return { ok: false, why: `${flowOf(key).name} can wait ${t.choices.join(", ")} minutes.` };
  await db.sql`
    insert into text_flows (key, timing, updated_by) values (${key}, ${minutes}, ${by})
    on conflict (key) do update set timing = excluded.timing, updated_by = excluded.updated_by, updated_at = now()`;
  return { ok: true };
}

/** One text's words back to ours. */
export async function resetWords(db: Db, key: FlowKey, variant: string, by: string): Promise<void> {
  await db.sql`update text_flows set words = words - ${variant}, updated_by = ${by}, updated_at = now() where key = ${key}`;
}

/** Back to ours: the switch, the words and the timing. */
export async function resetFlow(db: Db, key: FlowKey): Promise<void> {
  await db.sql`delete from text_flows where key = ${key}`;
}

// ---- quiet hours ---------------------------------------------------------------

/** Quiet hours, in the business's zone: from 8pm to 8am. */
const QUIET = { from: 20, to: 8 };

/** Whether an instant is in quiet hours (8pm to 8am) in the business's zone. */
export function isQuiet(t: Date, zone: string): boolean {
  const { h } = wallClock(t.getTime(), zone);
  return h >= QUIET.from || h < QUIET.to;
}

/** The first instant at or after `t` outside quiet hours: 8am that morning, or the next one after 8pm. */
export function notQuiet(t: Date, zone: string): Date {
  if (!isQuiet(t, zone)) return t;
  const today = localDate(t, zone);
  const day = wallClock(t.getTime(), zone).h >= QUIET.from ? addDays(today, 1) : today;
  return wallToInstant(day, QUIET.to * 60, zone, "forward")!;
}

/** The words Twilio's Advanced Opt-Out answers keywords with, for the campaign and the messaging service. */
export function keywordReplies(business: string, number: string): Record<"help" | "stop" | "start", string> {
  return {
    help: fill(KEYWORD_REPLIES.help, { business, number: prettyPhone(number) }),
    stop: fill(KEYWORD_REPLIES.stop, { business }),
    start: fill(KEYWORD_REPLIES.start, { business }),
  };
}
