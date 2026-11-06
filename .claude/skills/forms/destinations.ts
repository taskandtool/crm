// Where a lead goes besides this database: a webhook, a connection (i360 and the
// like) or an email. The submission is saved first. A send that fails is marked
// failed, the team is emailed once, and the submission's page shows what went, what
// came back and a Resend button.
//
// Each submission gets one row per destination (`lead_deliveries`), claimed before
// sending, so two requests or two apps do not both send it. Edge-safe.
//
//   // in the app's routes, the forms routes do this for their own submissions:
//   afterResponse(c, leadMoment(db, envOf(c), id, "complete", { link }));
import type { Db } from "../data/db";
import { setting, type Env } from "../data/env";
import { gatewayFetch } from "../data/gateway";
import { normalizeEmail } from "../data/email";
import { sendEmail, teamAddresses } from "../data/send";
import { FORM_KEY } from "./fields";
import { CLICK_KEYS, UTM_KEYS, type Click, type Touch, type Utm } from "./origin";
import { formTitle, loadForm } from "./store";

export type DestinationKind = "webhook" | "connection" | "email";
export type Moment = "answered" | "complete";

export type Destination = {
  id: string;
  key: string;
  title: string;
  kind: DestinationKind;
  /** A webhook: the secret holding its address. A connection: its slug. An email: the addresses, comma-separated. */
  target: string;
  /** A connection: the vendor's path. */
  path: string | null;
  /** The body, with {{placeholders}}; null sends every field. */
  template: unknown;
  forms: string[];
  send_when: Moment;
  needs: string[];
  active: boolean;
};

export type Delivery = {
  id: string;
  submission_id: string;
  destination_id: string;
  title: string;
  kind: DestinationKind;
  status: "waiting" | "due" | "sending" | "sent" | "failed";
  attempts: number;
  body: string | null;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  sent_at: Date | null;
  updated_at: Date;
};

/** What a lead's fields are called in a template and in the body sent when there is none. */
export type Fields = Record<string, string | number | boolean>;

type Options = {
  /** The submission's page, for the email to the team about a failed send. */
  link?: string;
  /** How many tries a send gets, when a person is waiting: Resend, Not spam. */
  tries?: number;
  doFetch?: typeof fetch;
  /** Only tests shorten the waits. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * Three tries over a few seconds for a blip, kept inside the 30 seconds a Worker has
 * after its response. A longer outage is the team's Resend. A timeout is not tried
 * again: the vendor may have it, and a second create can make a duplicate.
 */
const WAITS = [0, 1_000, 3_000];
const TIMEOUT_MS = 10_000;
/** No further try after this long: one more slow answer still fits. */
const RETRY_BUDGET_MS = 15_000;
const KEEP_BODY = 20_000;
const KEEP_RESPONSE = 2_000;
/** A send that stopped partway (its process died) may be resent after this long. */
export const STALE_MINUTES = 10;

export const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// ---- what a lead's fields are ---------------------------------------------------

/**
 * Every field a destination can use: the person, each answer, where they came from
 * and the appointment. Hidden keys (`_consent`, `_lines`) stay out, and nothing
 * nested goes: a vendor's mapping wants flat names.
 */
export async function leadFields(db: Db, submissionId: string): Promise<Fields | null> {
  const [s] = await db.sql<{ id: string; form_key: string; title: string | null; name: string | null; email: string | null; phone: string | null; data: Record<string, unknown> | null; page: string | null; created_at: Date; text_consent: string | null }>`
    select s.id::text as id, s.form_key, f.title, s.name, s.email::text as email, s.phone, s.data, s.page, s.created_at, s.text_consent
    from submissions s left join forms f on f.key = s.form_key where s.id = ${submissionId}::bigint`;
  if (!s) return null;
  const out: Fields = {};
  const put = (k: string, v: unknown) => {
    if (typeof v === "string" ? v !== "" : typeof v === "number" || typeof v === "boolean") out[k] = v as string | number | boolean;
  };
  const data = s.data ?? {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("_")) continue;
    put(k, Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : v);
  }
  const parts = (s.name ?? "").trim().split(/\s+/).filter(Boolean);
  put("first_name", parts[0]);
  put("last_name", parts.slice(1).join(" "));
  put("name", s.name);
  put("email", s.email);
  put("phone", s.phone);
  put("id", s.id);
  put("form", s.form_key);
  put("form_title", formTitle(s.form_key, s.title));
  put("page", s.page);
  put("received_at", new Date(s.created_at).toISOString());
  put("text_consent", s.text_consent);

  const utm = (data._utm ?? {}) as Utm;
  for (const k of UTM_KEYS) put(`utm_${k}`, utm[k]);
  const click = (data._click ?? {}) as Click;
  for (const k of CLICK_KEYS) put(k, click[k]);
  put("referrer", data._referrer);
  put("landing_page", data._landing);
  const first = (data._first ?? {}) as Touch;
  for (const k of UTM_KEYS) put(`first_utm_${k}`, first.utm?.[k]);

  const [has] = await db.sql<{ bookings: boolean }>`select to_regclass('bookings') is not null as bookings`;
  if (has.bookings) {
    const [b] = await db.sql<{ starts_at: Date; ends_at: Date; location: string | null; service: string | null; host: string | null }>`
      select b.starts_at, b.ends_at, b.location, t.name as service, r.name as host
      from bookings b left join booking_types t on t.id = b.type_id left join resources r on r.id = b.resource_id
      where b.submission_id = ${submissionId}::bigint and b.status = 'confirmed' order by b.id desc limit 1`;
    if (b) {
      put("appointment_start", new Date(b.starts_at).toISOString());
      put("appointment_end", new Date(b.ends_at).toISOString());
      put("appointment_service", b.service);
      put("appointment_with", b.host);
      put("appointment_location", b.location);
    }
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const ONLY_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

/**
 * A template filled in. A value that is only one placeholder keeps its type, and
 * its key is left out when the lead has no such field, so a vendor's optional field
 * is absent rather than empty. A placeholder inside other words becomes the value,
 * or nothing.
 */
export function fillTemplate(t: unknown, fields: Fields): unknown {
  if (typeof t === "string") {
    const whole = ONLY_PLACEHOLDER.exec(t.trim());
    if (whole) return fields[whole[1]];
    return t.replace(PLACEHOLDER, (_m, k: string) => String(fields[k] ?? ""));
  }
  if (Array.isArray(t)) return t.map((x) => fillTemplate(x, fields)).filter((x) => x !== undefined);
  if (t && typeof t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) {
      const filled = fillTemplate(v, fields);
      if (filled !== undefined) out[k] = filled;
    }
    return out;
  }
  return t;
}

/** Which `needs` the lead does not have yet. */
export const missingFields = (needs: string[], fields: Fields) => needs.filter((k) => fields[k] === undefined || fields[k] === "");

/** One line of an email, its later lines indented, so what a visitor typed cannot pass for a line of ours. */
export const emailLine = (label: string, value: unknown) => `${label}: ${String(value).replace(/\n/g, "\n    ")}`;

const humanName = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** What is not an answer: said otherwise in the email, or of no use to whoever reads it. */
const NOT_ANSWERS = new Set([
  "id", "form", "form_title", "name", "first_name", "last_name", "email", "phone", "page", "received_at", "text_consent", "referrer", "landing_page",
  ...UTM_KEYS.flatMap((k) => [`utm_${k}`, `first_utm_${k}`]), ...CLICK_KEYS,
  "appointment_start", "appointment_end", "appointment_service", "appointment_with", "appointment_location",
]);

/** The lead as a person reads it: who, what they answered in the form's words, the appointment, where they came from, the link. */
function emailText(f: Fields, o: { labels?: Record<string, string>; link?: string }): string {
  const lines: string[] = [];
  const add = (label: string, k: string) => {
    if (f[k] !== undefined) lines.push(emailLine(label, f[k]));
  };
  add("Name", "name");
  add("Email", "email");
  add("Phone", "phone");
  for (const k of Object.keys(f)) if (!NOT_ANSWERS.has(k)) add(o.labels?.[k] ?? humanName(k), k);
  add("Appointment", "appointment_start");
  add("Service", "appointment_service");
  add("With", "appointment_with");
  add("Where", "appointment_location");
  add("Source", "utm_source");
  add("Campaign", "utm_campaign");
  add("Ad", "utm_content");
  add("Page", "page");
  if (o.link) lines.push("", `Open it: ${o.link}`);
  return lines.join("\n");
}

// ---- sending ----------------------------------------------------------------------

type Tried = { ok: boolean; status: number | null; response: string | null; error: string | null; retry: boolean };

/** What a destination is sent for these fields, as text: what the row keeps. */
export function bodyFor(d: Pick<Destination, "kind" | "template">, fields: Fields, o: { labels?: Record<string, string>; link?: string } = {}): string {
  if (d.kind === "email") return emailText(fields, o);
  return JSON.stringify(d.template == null ? fields : fillTemplate(d.template, fields));
}

function isHttps(address: string): boolean {
  try {
    return new URL(address).protocol === "https:";
  } catch {
    return false;
  }
}

/** Stop waiting for a promise that has no timeout of its own. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<never>((_, no) => setTimeout(() => no(new DOMException("timed out", "TimeoutError")), ms))]);
}

/** One try. A vendor's 4xx is its answer and will not change; a dropped connection, a 429 or a 5xx may. */
async function tryOnce(env: Env, d: Destination, fields: Fields, body: string, doFetch: typeof fetch): Promise<Tried> {
  try {
    if (d.kind === "email") {
      const to = d.target.split(",").map((e) => e.trim()).filter(Boolean);
      const who = [fields.name, fields.email].filter(Boolean).join(", ");
      const sent = await within(sendEmail(env, { to, subject: `New lead${who ? `: ${who}` : ""}`, text: body, replyTo: typeof fields.email === "string" ? fields.email : null, team: true }, doFetch), TIMEOUT_MS);
      if (sent.status === "sent") {
        const skipped = sent.skipped ?? [];
        return skipped.length
          ? { ok: false, status: null, response: null, error: `Not sent to ${skipped.join(", ")}: they cannot open this app. Connect Resend or Postmark to email anyone`, retry: false }
          : { ok: true, status: null, response: `Sent by ${sent.via}`, error: null, retry: false };
      }
      return sent.status === "none"
        ? { ok: false, status: null, response: null, error: sent.why, retry: false }
        : { ok: false, status: null, response: null, error: sent.error.slice(0, 500), retry: true };
    }
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) };
    let res: Response;
    if (d.kind === "webhook") {
      const address = setting(env, d.target);
      if (!address) return { ok: false, status: null, response: null, error: `This webhook's address is not set on this app: ask the AI to set the secret ${d.target}.`, retry: false };
      // Never the value in a message: the address is the credential.
      if (!isHttps(address)) return { ok: false, status: null, response: null, error: `The secret ${d.target} is not a valid https address.`, retry: false };
      res = await doFetch(address, init);
    } else {
      res = await gatewayFetch(env, d.target, d.path ?? "/", init, doFetch);
      const refused = res.headers.get("x-tasktool-refusal");
      if (refused) return { ok: false, status: res.status, response: null, error: `Task & Tool refused the ${d.target} call: ${refused}`, retry: false };
    }
    const response = (await res.text()).slice(0, KEEP_RESPONSE);
    return res.ok
      ? { ok: true, status: res.status, response, error: null, retry: false }
      : { ok: false, status: res.status, response, error: res.status >= 500 ? `${d.title} had a problem (${res.status}).` : `${d.title} refused this lead (${res.status}).`, retry: res.status === 429 || res.status >= 500 };
  } catch (e) {
    if ((e as Error).name === "TimeoutError") return { ok: false, status: null, response: null, error: `${d.title} did not answer in ${TIMEOUT_MS / 1000} seconds. It may have arrived: check there before you resend.`, retry: false };
    // A connection's message can quote the address, so only its kind is kept.
    return { ok: false, status: null, response: null, error: `Could not reach ${d.title} (${(e as Error).name}).`, retry: true };
  }
}

const toDestination = (r: Record<string, any>): Destination => ({
  id: String(r.id), key: r.key, title: r.title, kind: r.kind, target: r.target, path: r.path ?? null,
  template: r.template ?? null, forms: r.forms ?? [], send_when: r.send_when, needs: r.needs ?? [], active: r.active !== false,
});

/** Tell the team once that a lead did not reach a destination. Never throws. */
async function alertTeam(db: Db, env: Env, deliveryId: string, d: Destination, fields: Fields, error: string, o: Options): Promise<void> {
  try {
    const [claimed] = await db.sql`update lead_deliveries set alerted_at = now() where id = ${deliveryId}::bigint and alerted_at is null returning id`;
    if (!claimed) return;
    const [form] = await db.sql<{ notify_emails: string[] }>`select notify_emails::text[] as notify_emails from forms where key = ${String(fields.form ?? "")}`;
    const to = form?.notify_emails?.length ? form.notify_emails : await teamAddresses(env, o.doFetch);
    const who = fields.name || fields.email || fields.phone || "A lead";
    const sent = await sendEmail(env, {
      to,
      subject: `${who} did not reach ${d.title}`,
      text: [`${who} is saved, but did not reach ${d.title}. ${error}`, `It won't be sent again unless you resend it${o.link ? `: ${o.link}` : " from the submission's page."}`].join("\n\n"),
      team: true,
    }, o.doFetch);
    if (sent.status !== "sent") console.error(`forms: nobody was told delivery ${deliveryId} failed: ${sent.status === "none" ? sent.why : sent.error}`);
  } catch (e) {
    console.error(`forms: nobody was told delivery ${deliveryId} failed:`, e);
  }
}

/** Claim one row and send it. `moment` says whether a lead still missing a field can wait for the last step. */
async function sendDelivery(db: Db, env: Env, id: string, moment: Moment, o: Options): Promise<void> {
  const [row] = await db.sql<Record<string, any>>`
    update lead_deliveries set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id = ${id}::bigint
      and (status in ('due', 'failed', 'sent', 'waiting')
           or (status = 'sending' and updated_at < now() - make_interval(mins => ${STALE_MINUTES})))
    returning id::text as id, submission_id::text as submission_id, destination_id::text as destination_id`;
  if (!row) return;
  const [dest] = await db.sql<Record<string, any>>`select * from lead_destinations where id = ${row.destination_id}::bigint`;
  const fields = dest ? await leadFields(db, row.submission_id) : null;
  if (!dest || !fields) {
    await db.sql`update lead_deliveries set status = 'failed', error = 'The destination or the submission is gone', updated_at = now() where id = ${id}::bigint`;
    return;
  }
  const d = toDestination(dest);
  const missing = missingFields(d.needs, fields);
  if (missing.length) {
    const error = `Missing ${missing.join(", ")}`;
    if (moment !== "complete") {
      await db.sql`update lead_deliveries set status = 'waiting', error = ${error}, updated_at = now() where id = ${id}::bigint`;
      return;
    }
    await db.sql`update lead_deliveries set status = 'failed', error = ${error}, updated_at = now() where id = ${id}::bigint`;
    await alertTeam(db, env, id, d, fields, error, o);
    return;
  }
  const labels = d.kind === "email" ? Object.fromEntries(((await loadForm(db, String(fields.form))) ?.fields ?? []).map((f) => [f.name, f.label])) : undefined;
  const body = bodyFor(d, fields, { labels, link: o.link });
  const doFetch = o.doFetch ?? fetch;
  const wait = o.wait ?? sleep;
  const waits = WAITS.slice(0, o.tries ?? WAITS.length);
  let tried: Tried = { ok: false, status: null, response: null, error: "Not tried", retry: false };
  const started = Date.now();
  for (const ms of waits) {
    if (Date.now() - started > RETRY_BUDGET_MS) break;
    if (ms) await wait(ms);
    tried = await tryOnce(env, d, fields, body, doFetch);
    if (tried.ok || !tried.retry) break;
  }
  await db.sql`
    update lead_deliveries set status = ${tried.ok ? "sent" : "failed"}, body = ${body.slice(0, KEEP_BODY)}, response_status = ${tried.status},
      response_body = ${tried.response}, error = ${tried.error}, sent_at = case when ${tried.ok} then now() else sent_at end, updated_at = now()
    where id = ${id}::bigint`;
  if (!tried.ok) await alertTeam(db, env, id, d, fields, tried.error ?? "Not sent", o);
}

/**
 * A moment in a lead's life: its questions are done, or its last step is. Writes a
 * row for each destination that takes this form (a form with `leads` off only when
 * named), and sends what is due. Spam gets nothing until a person says it is not.
 * Safe to run again: each row goes once. Never run this in the visitor's way.
 */
export async function leadMoment(db: Db, env: Env, submissionId: string, moment: Moment, o: Options = {}): Promise<void> {
  const complete = moment === "complete";
  const due = await db.sql<{ id: string }>`
    with made as (
      insert into lead_deliveries (submission_id, destination_id, status)
      select s.id, d.id, case when d.send_when = 'answered' or ${complete} then 'due' else 'waiting' end
      from submissions s
      left join forms f on f.key = s.form_key
      join lead_destinations d on d.active and (s.form_key = any(d.forms) or (d.forms = '{}' and coalesce(f.leads, true)))
      where s.id = ${submissionId}::bigint and s.status <> 'spam'
      on conflict (submission_id, destination_id) do nothing
      returning id, status),
    woken as (
      update lead_deliveries set status = 'due', updated_at = now()
      where submission_id = ${submissionId}::bigint and status = 'waiting' and ${complete}
      returning id, status)
    select id::text as id from made where status = 'due' union all select id::text as id from woken`;
  // Side by side, so a slow vendor does not use up another's time.
  await Promise.all(due.map(({ id }) => sendDelivery(db, env, id, moment, o)));
}

// ---- for people -------------------------------------------------------------------

/** Each send of a submission, for its page. */
export function deliveriesOf(db: Db, submissionId: string): Promise<Delivery[]> {
  return db.sql<Delivery>`
    select l.id::text as id, l.submission_id::text as submission_id, l.destination_id::text as destination_id, d.title, d.kind, l.status, l.attempts,
           l.body, l.response_status, l.response_body, l.error, l.sent_at, l.updated_at
    from lead_deliveries l join lead_destinations d on d.id = l.destination_id
    where l.submission_id = ${submissionId}::bigint order by (l.status = 'failed') desc, d.title, l.id`;
}

/** A person pressed Resend: one try, while they wait. False when this row is not that submission's. */
export async function resendDelivery(db: Db, env: Env, submissionId: string, deliveryId: string, o: Options = {}): Promise<boolean> {
  const [row] = await db.sql`select 1 from lead_deliveries where id = ${deliveryId}::bigint and submission_id = ${submissionId}::bigint`;
  if (!row) return false;
  await sendDelivery(db, env, deliveryId, "complete", { tries: 1, ...o });
  return true;
}

/** Which destinations a form's leads go to, by leadMoment's rule; every one without a form. */
export async function destinationsOf(db: Db, formKey?: string): Promise<Destination[]> {
  const rows = await db.sql<Record<string, any>>`
    select * from lead_destinations d
    where ${formKey ?? null}::text is null or ${formKey ?? null}::text = any(d.forms)
       or (d.forms = '{}' and coalesce((select f.leads from forms f where f.key = ${formKey ?? null}), true))
    order by d.title, d.key`;
  return rows.map(toDestination);
}

// ---- checking what someone asked for ---------------------------------------------

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_NAME = /^[a-zA-Z0-9_]+$/;

export type DestinationInput = { title: string; kind: DestinationKind; target: string; path: string | null; template: unknown; forms: string[]; send_when: Moment; needs: string[]; active: boolean };

/** A destination's definition, checked: the reasons it cannot be saved, or the values to save. */
export function checkDestination(raw: unknown): { ok: true; value: DestinationInput } | { ok: false; problems: string[] } {
  const def = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const title = typeof def.title === "string" ? def.title.trim() : "";
  if (!title) problems.push(`"title" is required: what the team calls it, like "i360"`);
  const kind = def.kind as DestinationKind;
  if (!["webhook", "connection", "email"].includes(kind as string)) problems.push(`"kind" is one of webhook, connection, email`);
  const target = typeof def.target === "string" ? def.target.trim() : "";
  if (kind === "webhook" && !SECRET_NAME.test(target)) problems.push(`"target" for a webhook is the name of the secret holding its address, like LEAD_WEBHOOK_URL`);
  if (kind === "connection" && !SLUG.test(target)) problems.push(`"target" for a connection is its slug from list-connections, like i360`);
  if (kind === "email" && !(target && target.split(",").every((e) => normalizeEmail(e)))) problems.push(`"target" for an email is the addresses, separated by commas`);
  const path = typeof def.path === "string" && def.path.trim() ? def.path.trim() : null;
  if (kind === "connection" && !(path && path.startsWith("/"))) problems.push(`"path" for a connection is the vendor's path, starting with /`);
  if (kind !== "connection" && path) problems.push(`"path" is only for a connection`);
  const template = def.template ?? null;
  if (template !== null && (typeof template !== "object" || Array.isArray(template))) problems.push(`"template" is an object of the body's fields, with {{placeholders}}`);
  if (kind === "email" && template !== null) problems.push(`"template" is not for an email, which lists every field`);
  const forms = def.forms ?? [];
  if (!(Array.isArray(forms) && forms.every((f) => typeof f === "string" && FORM_KEY.test(f)))) problems.push(`"forms" is a list of form keys; leave it out for every form that makes leads`);
  const send = def.send_when ?? "answered";
  if (send !== "answered" && send !== "complete") problems.push(`"send_when" is answered (the questions are done) or complete (the last step is)`);
  const needs = def.needs ?? [];
  if (!(Array.isArray(needs) && needs.every((n) => typeof n === "string" && FIELD_NAME.test(n)))) problems.push(`"needs" is a list of field names that must be present to send`);
  if (def.active !== undefined && typeof def.active !== "boolean") problems.push(`"active" is true or false`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { title, kind, target, path, template, forms: forms as string[], send_when: send as Moment, needs: needs as string[], active: def.active !== false } };
}

/** One try for a test from chat, kept nowhere. */
export async function testSend(env: Env, d: Destination, fields: Fields, doFetch: typeof fetch = fetch) {
  return tryOnce(env, d, fields, bodyFor(d, fields), doFetch);
}
