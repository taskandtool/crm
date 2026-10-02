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

export const FIELD_TYPES = ["text", "email", "tel", "textarea", "select", "checkbox", "radio", "date", "number", "consent"] as const;
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
}

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
export type Answer = string | number | boolean | string[];

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
export const RESERVED = ["company_website", "_started", "_page", "_consent", "_utm", "_ref", "_referrer"];
export const COLUMNS = ["name", "email", "phone"] as const;
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
};

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validate(fields: Field[], input: Input): Validated {
  const errors: Errors = {};
  const values: Input = {};
  const sub: Submission = { name: null, email: null, phone: null, data: {} };
  const consent: Record<string, string> = {};

  for (const f of fields) {
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
    if (problems[at]) return;
    seen.add(name);
    const f: Field = { name, label, type: type! };
    if (r.required === true) f.required = true;
    if (options.length && (type === "select" || type === "radio" || type === "checkbox")) f.options = options;
    if (typeof r.maxLength === "number" && r.maxLength > 0) f.maxLength = Math.min(Math.floor(r.maxLength), DEFAULT_MAX.textarea);
    if (typeof r.help === "string" && r.help.trim()) f.help = r.help.trim();
    if (typeof r.autocomplete === "string" && /^[a-z0-9 -]{1,60}$/.test(r.autocomplete)) f.autocomplete = r.autocomplete;
    fields.push(f);
  });
  return { fields, problems };
}

/** A form's address and key: lowercase letters, digits and hyphens. */
export const FORM_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A path on this site to send people to after a submission, or null. Never another site. */
export function sitePath(p: unknown): string | null {
  return typeof p === "string" && /^\/(?![/\\])[^\s]*$/.test(p) && p.length <= 300 ? p : null;
}
