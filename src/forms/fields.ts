// A form's definition and the one validator every submission goes through.
// The definition is a row in forms (`fields` is this ordered array), so
// the renderer, the server check and the form editor all read the same thing.
//
//   const r = validate(form.fields, input);           // input from the POST body
//   if (!r.ok) return rerender(r.errors, r.values);    // per-field messages
//   insert r.submission                               // name, email, phone in columns; the rest in data
//
// Fields named `name`, `email` and `phone` fill those columns of
// submissions, so the CRM finds the person; every other answer goes in
// `data`, keyed by the field's name. Anything posted that is not a field is
// ignored. Edge-safe.
import { normalizeEmail } from "../data/email";

export const FIELD_TYPES = [
  "text", "email", "tel", "textarea", "select", "checkbox", "radio", "date", "number", "consent", "items", "photo",
  // Not answers: `page` starts a new step; `booking` and `payment` are steps
  // run by the booking and payments skills (steps.ts).
  "page", "booking", "payment",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  /** The answer's key in `data`, and the input's name: lowercase letters, digits, underscores. */
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** For select and radio (one of them) and checkbox (any of them; without options a checkbox is one yes or no). */
  options?: string[];
  /** Most characters accepted; defaults by type (DEFAULT_MAX). */
  maxLength?: number;
  help?: string;
  /** Overrides the autocomplete hint the renderer picks from the name and type. */
  autocomplete?: string;
  /** A `booking` step: the slug of the booking type it books. */
  booking_type?: string;
  /** An `items` field: what can be bought, and the currency of its prices. */
  items?: Item[];
  currency?: string;
  /** A `payment` step: fixed fees (some only when an answer says so), their currency when nothing else names one, and the tax rate (payments skill's tax_rates id). */
  fees?: Fee[];
  tax_rate_id?: string;
}

/** Something an `items` field sells: its price in minor units of the field's currency, per `unit`. */
export type Item = { key: string; label: string; price_cents: number; unit?: string; image?: string; max?: number };
/** A fee a payment step adds: always, or `when` a choice's answer is (or, for a checkbox, includes) one of its options, as written ("Delivery"). */
export type Fee = { label: string; price_cents: number; when?: { field: string; is: string } };

/** The types that are a step of their own rather than an answer. */
export const STEP_TYPES = ["page", "booking", "payment"] as const;
export const isAnswer = (f: Field) => !(STEP_TYPES as readonly string[]).includes(f.type);

/** A row of forms, as the snippets use it. */
export interface Form {
  key: string;
  title: string;
  fields: Field[];
  notify_emails: string[];
  redirect_to: string | null;
  success_message: string | null;
  submit_label: string | null;
  active: boolean;
}

/** What a browser posts: one string per name, or several for a checkbox group. */
export type Input = Record<string, string | string[]>;
export type Errors = Record<string, string>;
export type Answer = string | number | boolean | string[] | Record<string, number>;

export type Submission = {
  name: string | null;
  email: string | null;
  phone: string | null;
  data: Record<string, Answer>;
};

export type Validated =
  | { ok: true; submission: Submission; values: Input }
  | { ok: false; errors: Errors; values: Input };

/** Names the form machinery posts beside the fields; a field may not use them. */
export const RESERVED = ["company_website", "_started", "_page", "_consent", "_utm", "_ref", "_referrer", "_draft", "_step", "_charges", "_lines"];
/** The hidden inputs that carry a visitor's place in a form with steps: their key, and the step the page was. */
export const DRAFT_FIELD = "_draft";
export const STEP_FIELD = "_step";
/** Names every JavaScript object already answers to; a field named one would read a built-in, not an answer. */
const BUILT_IN = new Set(Object.getOwnPropertyNames(Object.prototype));

export const DEFAULT_MAX: Record<FieldType, number> = {
  text: 200,
  email: 254,
  tel: 40,
  textarea: 5000,
  select: 200,
  checkbox: 200,
  radio: 200,
  date: 10,
  number: 30,
  consent: 10,
  items: 0,
  photo: 30,
  page: 0,
  booking: 0,
  payment: 0,
};

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** A photo's answer: where the page uploaded it, an upload of this project's apps (/_files). */
export const PHOTO_PATH = /^\/_files\/[\w-]{22}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validate(fields: Field[], input: Input): Validated {
  const errors: Errors = {};
  const values: Input = {};
  const sub: Submission = { name: null, email: null, phone: null, data: {} };
  const consent: Record<string, string> = {};

  for (const f of fields.filter(isAnswer)) {
    const raw = Object.hasOwn(input, f.name) ? input[f.name] : undefined;
    const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .filter((v): v is string => typeof v === "string")
      .map((v) => clean(v, f.type === "textarea"))
      .filter((v) => v !== "");
    const one = list[0] ?? "";
    const max = f.maxLength ?? DEFAULT_MAX[f.type];
    values[f.name] = f.type === "checkbox" && f.options?.length ? list : one;

    if (f.type === "consent" || (f.type === "checkbox" && !f.options?.length)) {
      const yes = one !== "";
      if (!yes && f.required) errors[f.name] = "Please tick this box to continue.";
      else if (f.type === "consent") {
        sub.data[f.name] = yes;
        if (yes) consent[f.name] = f.label; // the words they agreed to, as they read them
      } else sub.data[f.name] = yes;
      continue;
    }

    if (f.type === "items") {
      // Quantities arrive as <name>[<key>]; the answer is { key: quantity } of those above zero.
      const chosen: Record<string, number> = {};
      let bad = false;
      for (const it of f.items ?? []) {
        const k = `${f.name}[${it.key}]`;
        const raw = Object.hasOwn(input, k) ? input[k] : undefined;
        const text = clean(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "", false);
        values[k] = text;
        if (!text) continue;
        const n = Number(text);
        if (!/^\d{1,4}$/.test(text) || n > (it.max ?? 99)) bad = true;
        else if (n > 0) chosen[it.key] = n;
      }
      if (bad) errors[f.name] = "Enter how many as a whole number, within the most allowed.";
      else if (!Object.keys(chosen).length && f.required) errors[f.name] = "Choose at least one.";
      else sub.data[f.name] = chosen as unknown as Answer;
      continue;
    }

    if (f.type === "checkbox") {
      if (!list.length) {
        if (f.required) errors[f.name] = "Choose at least one.";
        else sub.data[f.name] = [];
      } else if (list.some((v) => !f.options!.includes(v))) errors[f.name] = "Choose from the options shown.";
      else sub.data[f.name] = [...new Set(list)];
      continue;
    }

    if (!one) {
      if (f.required) errors[f.name] = f.type === "select" || f.type === "radio" ? "Choose one of the options." : "Please fill this in.";
      continue;
    }
    if (one.length > max) {
      errors[f.name] = `Keep this under ${max} characters.`;
      continue;
    }

    let answer: Answer = one;
    if (f.type === "email" || f.name === "email") {
      const e = normalizeEmail(one);
      if (!e) {
        errors[f.name] = "Enter an email address like name@example.com.";
        continue;
      }
      answer = e;
    } else if (f.type === "select" || f.type === "radio") {
      if (!f.options?.includes(one)) {
        errors[f.name] = "Choose one of the options.";
        continue;
      }
    } else if (f.type === "number") {
      const n = Number(one.replace(/,/g, ""));
      if (!Number.isFinite(n)) {
        errors[f.name] = "Enter a number.";
        continue;
      }
      answer = n;
    } else if (f.type === "date") {
      if (!isDate(one)) {
        errors[f.name] = "Enter a date as year, month and day.";
        continue;
      }
    } else if (f.type === "photo") {
      if (!PHOTO_PATH.test(one)) {
        errors[f.name] = "Attach the photo again.";
        continue;
      }
    } else if (f.type === "tel") {
      if (!/^[+()\d\s.\-x]{5,}$/i.test(one)) {
        errors[f.name] = "Enter a phone number using digits.";
        continue;
      }
    }

    if (f.name === "email" && typeof answer === "string") sub.email = answer;
    else if (f.name === "name" && typeof answer === "string") sub.name = answer;
    else if (f.name === "phone" && typeof answer === "string") sub.phone = answer;
    else sub.data[f.name] = answer;
  }

  if (Object.keys(consent).length) (sub.data as Record<string, unknown>)._consent = consent;
  return Object.keys(errors).length ? { ok: false, errors, values } : { ok: true, submission: sub, values };
}

// Hostile text made harmless before anything checks or stores it. Control
// characters go (a NUL is refused by Postgres, a newline in a one-line answer
// forges lines in the owner's email); only a long answer keeps its line
// breaks and tabs. Bidi overrides go, so a name cannot display reversed. An
// answer of nothing but invisible characters is no answer.
function clean(v: string, multiline: boolean): string {
  let s = v.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  s = multiline
    ? s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    : s.replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]+/g, " ");
  s = s.trim();
  return /^[\s\p{Cf}]*$/u.test(s) ? "" : s;
}

function isDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * A definition from anywhere (a row, the editor's POST) made safe to use:
 * the fields that are well formed, and what is wrong with the rest. The editor
 * refuses to save while problems are listed; a row read for rendering just
 * drops a broken field.
 */
export function checkFields(input: unknown): { fields: Field[]; problems: Errors } {
  const fields: Field[] = [];
  const problems: Errors = {};
  const seen = new Set<string>();
  const list = Array.isArray(input) ? input : [];
  list.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    const type = FIELD_TYPES.includes(r.type as FieldType) ? (r.type as FieldType) : null;
    const options = Array.isArray(r.options) ? [...new Set(r.options.filter((o): o is string => typeof o === "string").map((o) => o.trim()).filter(Boolean))] : [];
    const at = String(i);
    if (!NAME.test(name)) problems[at] = "A name is lowercase letters, digits and underscores, starting with a letter.";
    else if (RESERVED.includes(name)) problems[at] = `The name ${name} is used by the form itself. Choose another.`;
    else if (BUILT_IN.has(name)) problems[at] = `The name ${name} is reserved. Choose another.`;
    else if (seen.has(name)) problems[at] = `Two fields are named ${name}. Each name must be different.`;
    else if (!label) problems[at] = "Every field needs a label.";
    else if (!type) problems[at] = "Choose a type for this field.";
    else if ((type === "select" || type === "radio") && options.length < 2) problems[at] = "A choice needs at least two options, one per line.";
    else if (type === "booking" && !(typeof r.booking_type === "string" && BOOKING_SLUG.test(r.booking_type))) problems[at] = "Say which booking type this step books, by its slug.";
    else if (type === "items" && !(typeof r.currency === "string" && /^[a-z]{3}$/i.test(r.currency))) problems[at] = "Say the currency of the prices, like usd.";
    else if (type === "items" && !readItems(r.items)) problems[at] = "List what can be bought: each with a key (lowercase letters, digits, hyphens), a label and a price in cents.";
    else if (type === "payment" && !readFees(r.fees)) problems[at] = "Each fee needs a label and a price in cents; a fee only for an answer names the field and the answer.";
    if (problems[at]) return;
    seen.add(name);
    const f: Field = { name, label, type: type! };
    if (r.required === true) f.required = true;
    if (options.length && (type === "select" || type === "radio" || type === "checkbox")) f.options = options;
    if (typeof r.maxLength === "number" && r.maxLength > 0) f.maxLength = Math.min(Math.floor(r.maxLength), DEFAULT_MAX.textarea);
    if (typeof r.help === "string" && r.help.trim()) f.help = r.help.trim();
    if (typeof r.autocomplete === "string" && /^[a-z0-9 -]{1,60}$/.test(r.autocomplete)) f.autocomplete = r.autocomplete;
    if (type === "booking") f.booking_type = r.booking_type as string;
    if (type === "items") {
      f.items = readItems(r.items)!;
      f.currency = (r.currency as string).toLowerCase();
    }
    if (type === "payment") {
      const fees = readFees(r.fees)!;
      if (fees.length) f.fees = fees;
      if (typeof r.currency === "string" && /^[a-z]{3}$/i.test(r.currency)) f.currency = r.currency.toLowerCase();
      if (typeof r.tax_rate_id === "string" && /^\d{1,18}$/.test(r.tax_rate_id)) f.tax_rate_id = r.tax_rate_id;
    }
    fields.push(f);
  });
  // The steps' order: questions first, then a booking, then a payment, one of
  // each at most. A step out of place is reported and left out.
  const misplaced = new Map<Field, string>();
  const booking = fields.filter((f) => f.type === "booking"), payment = fields.filter((f) => f.type === "payment");
  booking.slice(1).forEach((f) => misplaced.set(f, "A form books one time at most."));
  payment.slice(1).forEach((f) => misplaced.set(f, "A form takes one payment at most."));
  if (payment.length && fields[fields.length - 1] !== payment[0]) misplaced.set(payment[0], "The payment is the last step.");
  let lastAnswer = -1;
  fields.forEach((f, i) => { if (isAnswer(f)) lastAnswer = i; });
  for (const f of [...booking, ...payment]) {
    if (lastAnswer < 0) misplaced.set(f, "Ask at least one question (their name or email) before a booking or payment step.");
    else if (fields.indexOf(f) < lastAnswer) misplaced.set(f, "A booking or payment step comes after every question.");
  }
  // One currency for everything a form sells.
  const currencies = [...new Set(fields.filter((f) => f.type === "items" || (f.type === "payment" && f.currency)).map((f) => f.currency))];
  if (currencies.length > 1) for (const f of fields.filter((f) => (f.type === "items" || f.type === "payment") && f.currency !== currencies[0])) misplaced.set(f, `Everything a form sells is in one currency; this is ${f.currency}, the first is ${currencies[0]}.`);
  // A fee for an answer names a choice in this form and one of its options, as written.
  const choices = new Map(fields.filter((f) => f.options?.length).map((f) => [f.name, f.options!]));
  for (const f of payment) {
    for (const fee of f.fees ?? []) {
      if (!fee.when) continue;
      const options = choices.get(fee.when.field);
      if (!options) misplaced.set(f, `The fee "${fee.label}" is for an answer to ${fee.when.field}, which is not a choice in this form (a select, radio or checkbox with options).`);
      else if (!options.includes(fee.when.is)) misplaced.set(f, `The fee "${fee.label}" is for "${fee.when.is}", which is not one of ${fee.when.field}'s options: ${options.join(", ")}.`);
    }
  }
  for (const [f, why] of misplaced) problems[String(list.findIndex((r) => (r as Field)?.name === f.name))] = why;
  return { fields: fields.filter((f) => !misplaced.has(f)), problems };
}

const BOOKING_SLUG = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const ITEM_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const cents = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

function readItems(v: unknown): Item[] | null {
  if (!Array.isArray(v) || !v.length || v.length > 50) return null;
  const out: Item[] = [];
  const keys = new Set<string>();
  for (const raw of v as Record<string, unknown>[]) {
    const key = typeof raw?.key === "string" ? raw.key : "";
    const label = typeof raw?.label === "string" ? raw.label.trim() : "";
    if (!ITEM_KEY.test(key) || keys.has(key) || !label || !cents(raw.price_cents)) return null;
    keys.add(key);
    const it: Item = { key, label: label.slice(0, 200), price_cents: raw.price_cents as number };
    if (typeof raw.unit === "string" && raw.unit.trim()) it.unit = raw.unit.trim().slice(0, 40);
    if (typeof raw.image === "string" && sitePath(raw.image)) it.image = raw.image;
    if (Number.isInteger(raw.max) && (raw.max as number) > 0 && (raw.max as number) <= 9999) it.max = raw.max as number;
    out.push(it);
  }
  return out;
}

function readFees(v: unknown): Fee[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10) return null;
  const out: Fee[] = [];
  for (const raw of v as Record<string, any>[]) {
    const label = typeof raw?.label === "string" ? raw.label.trim() : "";
    if (!label || !cents(raw.price_cents)) return null;
    const fee: Fee = { label: label.slice(0, 200), price_cents: raw.price_cents };
    if (raw.when !== undefined) {
      if (!(typeof raw.when?.field === "string" && NAME.test(raw.when.field) && typeof raw.when?.is === "string")) return null;
      fee.when = { field: raw.when.field, is: raw.when.is };
    }
    out.push(fee);
  }
  return out;
}

/** One step of a form: a page of questions, or a booking or payment step. */
export type Step = { kind: "fields"; label: string | null; fields: Field[] } | { kind: "booking" | "payment"; label: string; field: Field };

/**
 * The form's steps, in order. A `page` field starts a new page of questions
 * (its label heads it); a booking or payment step is a step of its own. A
 * form with no `page`, booking or payment is one step, as every form was.
 */
export function stepsOf(fields: Field[]): Step[] {
  const steps: Step[] = [];
  let page: { kind: "fields"; label: string | null; fields: Field[] } | null = null;
  for (const f of fields) {
    if (f.type === "page") {
      page = { kind: "fields", label: f.label, fields: [] };
      steps.push(page);
    } else if (f.type === "booking" || f.type === "payment") {
      steps.push({ kind: f.type, label: f.label, field: f });
      page = null;
    } else {
      if (!page) {
        page = { kind: "fields", label: null, fields: [] };
        steps.push(page);
      }
      page.fields.push(f);
    }
  }
  return steps.filter((st) => st.kind !== "fields" || st.fields.length);
}

/** A form's address and key: lowercase letters, digits and hyphens. */
export const FORM_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A path on this site to send people to after a submission, or null. Never another site. */
export function sitePath(p: unknown): string | null {
  return typeof p === "string" && /^\/(?![/\\])[^\s]*$/.test(p) && p.length <= 300 ? p : null;
}
