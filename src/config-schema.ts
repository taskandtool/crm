// The shape of crm.config.json and its validator, with no file loaded:
// scripts/check.mjs and the tests import this to judge any config, the
// examples included.
export type StageKind = "open" | "won" | "lost";
export type StageConfig = { key: string; label: string; kind?: StageKind };
export type FieldType = "text" | "number" | "date" | "select" | "phone" | "email";
export type CustomField = { key: string; label: string; type: FieldType; options?: string[] };
export type InboxConfig = {
  /** Which form keys count as people getting in touch: "all", or a list of form keys. */
  forms: "all" | string[];
  /** Form keys never shown (a newsletter sign-up, a careers form). */
  exclude_forms?: string[];
  bookings?: boolean;
  payments?: boolean;
};
/** A customer's jobs, visits, appointments or events: its words, its own custom fields, the currency its amounts are in. */
export type VisitsConfig = { one: string; many: string; fields: CustomField[]; currency?: string };
/** Quotes and invoices: the name printed on them, their currency, standing terms, days to pay. */
export type InvoicesConfig = { name: string; currency?: string; terms?: string; days_until_due?: number };
export type Config = {
  business: string;
  vocabulary: { one: string; many: string };
  stages: StageConfig[];
  sources: string[];
  fields: CustomField[];
  owner_label?: string;
  time_zone: string;
  default_view: "list" | "pipeline";
  pipeline?: boolean;
  inbox: InboxConfig;
  /** false (or absent) turns them off. */
  visits?: VisitsConfig | false;
  /** The team's side of booking (types, hosts, hours, calendars, the bookings); false leaves it out. On unless false. */
  booking?: boolean;
  /** The Website's booking pages, absolute ("https://acme.com/book"): a booking the team makes then mails a manage link there. */
  booking_page?: string;
  /** Quotes and invoices (the invoices skill); false leaves them out. */
  invoices?: InvoicesConfig | false;
};

export const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const FIELD_TYPES: FieldType[] = ["text", "number", "date", "select", "phone", "email"];
export const STAGE_KINDS: StageKind[] = ["open", "won", "lost"];
const FORM_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Custom field keys share the CSV header row and the scripts' flags with the
// built-in columns, so they may not reuse a built-in name.
// The built-in columns' CSV headers (crm/columns.ts): a custom field labelled
// the same would export two "Email" columns and import into the wrong one.
export const BUILT_IN_HEADERS = ["id", "name", "email", "phone", "company", "address", "stage", "source", "tags", "owner", "notes", "last contact (utc)", "added (utc)", "changed (utc)", "archived (utc)"];
// The same for a visit's custom fields (crm/visits.ts's CSV columns).
export const VISIT_BUILT_IN = ["id", "customer", "customer_id", "title", "status", "starts_at", "when", "owner", "amount", "amount_cents", "currency", "notes", "created_at", "updated_at", "created_by", "updated_by"];
export const VISIT_HEADERS = ["id", "customer", "customer email", "customer phone", "what", "status", "notes", "added (utc)"];
export const BUILT_IN = ["id", "name", "email", "phone", "company", "address", "stage", "source", "tags", "owner", "notes", "last_contact_at", "archived", "archived_at", "created_at", "updated_at", "created_by", "updated_by", "first_name", "last_name"];

// Returns the problems with a config object, or an empty list. Used at
// startup (a broken config is a startup error with the reason) and by
// `npm run check`.
export function validate(raw: unknown): string[] {
  const out: string[] = [];
  const c = raw as Partial<Config> | null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["config is not an object"];
  if (typeof c.business !== "string") out.push("business must be a string (one line about the business, or 'to fill')");
  const v = c.vocabulary;
  if (!v || typeof v.one !== "string" || typeof v.many !== "string" || !v.one.trim() || !v.many.trim()) out.push('vocabulary needs one and many, e.g. { "one": "Patient", "many": "Patients" }');

  if (!Array.isArray(c.stages) || c.stages.length === 0) out.push("stages must list at least one stage");
  else {
    const keys = new Set<string>();
    c.stages.forEach((s, i) => {
      if (!s || typeof s !== "object") return out.push(`stages[${i}] is not an object`);
      if (!KEY.test(s.key ?? "")) out.push(`stages[${i}].key must match ${KEY}`);
      if (keys.has(s.key)) out.push(`stages[${i}].key ${s.key} repeats`);
      keys.add(s.key);
      if (typeof s.label !== "string" || !s.label.trim()) out.push(`stages[${i}].label is missing`);
      if (s.kind !== undefined && !STAGE_KINDS.includes(s.kind)) out.push(`stages[${i}].kind must be open, won or lost`);
    });
    if (!c.stages.some((s) => (s?.kind ?? "open") === "open")) out.push("stages needs at least one open stage, where new people land");
  }

  if (!Array.isArray(c.sources) || c.sources.some((s) => typeof s !== "string" || !s.trim())) out.push("sources must be a list of names (it may be empty)");

  out.push(...fieldProblems(c.fields, "fields", BUILT_IN, BUILT_IN_HEADERS));
  if (c.owner_label !== undefined && (typeof c.owner_label !== "string" || !c.owner_label.trim())) out.push("owner_label must be a word such as Owner or Technician");
  if (typeof c.time_zone !== "string" || !validTimeZone(c.time_zone)) out.push(`time_zone must be an IANA zone name such as "America/Chicago" or "UTC" (got ${JSON.stringify(c.time_zone)})`);
  if (c.default_view !== "list" && c.default_view !== "pipeline") out.push("default_view must be list or pipeline");
  if (c.pipeline !== undefined && typeof c.pipeline !== "boolean") out.push("pipeline must be true or false");
  if (c.default_view === "pipeline" && c.pipeline === false) out.push("default_view is pipeline but pipeline is false");

  const ib = c.inbox;
  if (!ib || typeof ib !== "object") out.push('inbox must be an object, e.g. { "forms": "all" }');
  else {
    if (ib.forms !== "all" && !(Array.isArray(ib.forms) && ib.forms.every((k) => typeof k === "string" && FORM_KEY.test(k)))) {
      out.push('inbox.forms must be "all" or a list of form keys');
    }
    if (ib.exclude_forms !== undefined && !(Array.isArray(ib.exclude_forms) && ib.exclude_forms.every((k) => typeof k === "string" && FORM_KEY.test(k)))) {
      out.push("inbox.exclude_forms must be a list of form keys");
    }
    for (const k of ["bookings", "payments"] as const) if (ib[k] !== undefined && typeof ib[k] !== "boolean") out.push(`inbox.${k} must be true or false`);
  }

  if (c.booking !== undefined && typeof c.booking !== "boolean") out.push("booking must be true or false");
  if (c.booking_page !== undefined && !(typeof c.booking_page === "string" && /^https:\/\/[^\s/]+(\/\S*)?$/.test(c.booking_page))) {
    out.push('booking_page must be the Website\'s booking address, like "https://acme.com/book"');
  }
  if (c.invoices !== undefined && c.invoices !== false) {
    const iv = c.invoices as Partial<InvoicesConfig> | null;
    if (!iv || typeof iv !== "object" || Array.isArray(iv)) out.push('invoices must be false or an object, e.g. { "name": "Acme Plumbing", "currency": "USD" }');
    else {
      if (typeof iv.name !== "string" || !iv.name.trim()) out.push('invoices.name is the business name printed on quotes, e.g. "Acme Plumbing" (or "to fill")');
      if (iv.currency !== undefined && !validCurrency(iv.currency)) out.push(`invoices.currency must be a currency code such as "USD" (got ${JSON.stringify(iv.currency)})`);
      if (iv.terms !== undefined && (typeof iv.terms !== "string" || iv.terms.length > 2000)) out.push("invoices.terms must be text of up to 2000 characters");
      if (iv.days_until_due !== undefined && !(Number.isInteger(iv.days_until_due) && iv.days_until_due >= 0 && iv.days_until_due <= 365)) out.push("invoices.days_until_due must be a whole number of days, 0 to 365");
    }
  }
  if (c.visits !== undefined && c.visits !== false) {
    const vs = c.visits as Partial<VisitsConfig> | null;
    if (!vs || typeof vs !== "object" || Array.isArray(vs)) out.push('visits must be false or an object, e.g. { "one": "Job", "many": "Jobs", "fields": [] }');
    else {
      if (typeof vs.one !== "string" || typeof vs.many !== "string" || !vs.one.trim() || !vs.many.trim()) out.push('visits needs one and many, e.g. { "one": "Job", "many": "Jobs" }');
      // The CSV also heads columns with the owner's label, "When (zone)" and "Amount (currency)".
      const owner = (typeof c.owner_label === "string" && c.owner_label.trim() ? c.owner_label : "Owner").trim().toLowerCase();
      out.push(...fieldProblems(vs.fields, "visits.fields", VISIT_BUILT_IN, [...VISIT_HEADERS, owner]));
      if (Array.isArray(vs.fields)) {
        vs.fields.forEach((f, i) => {
          if (typeof f?.label === "string" && /^\s*(when|amount)\s*\(/i.test(f.label)) out.push(`visits.fields[${i}].label ${f.label} reads as a built-in column's name; pick another label`);
        });
      }
      if (vs.currency !== undefined && !validCurrency(vs.currency)) out.push(`visits.currency must be a currency code such as "USD" or "GBP" (got ${JSON.stringify(vs.currency)})`);
    }
  }
  return out;
}

// One list of custom fields: keys are snake_case and never a built-in
// column's, labels never a built-in header, selects have options.
function fieldProblems(fields: unknown, at: string, builtIn: string[], headers: string[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(fields)) return [`${at} must be a list (it may be empty)`];
  const keys = new Set<string>();
  const labels = new Set<string>();
  (fields as CustomField[]).forEach((f, i) => {
    if (!f || typeof f !== "object") return out.push(`${at}[${i}] is not an object`);
    if (!KEY.test(f.key ?? "") || f.key.includes("-")) out.push(`${at}[${i}].key must be lower case letters, digits and _ (got ${JSON.stringify(f.key)})`);
    else if (builtIn.includes(f.key)) out.push(`${at}[${i}].key ${f.key} is a built-in column; pick another key`);
    if (keys.has(f.key)) out.push(`${at}[${i}].key ${f.key} repeats`);
    keys.add(f.key);
    if (typeof f.label !== "string" || !f.label.trim()) out.push(`${at}[${i}].label is missing`);
    else {
      const l = f.label.trim().toLowerCase();
      if (headers.includes(l)) out.push(`${at}[${i}].label ${f.label} is a built-in column's name; pick another label`);
      else if (labels.has(l)) out.push(`${at}[${i}].label ${f.label} repeats`);
      labels.add(l);
    }
    if (!FIELD_TYPES.includes(f.type)) out.push(`${at}[${i}].type must be one of ${FIELD_TYPES.join(", ")}`);
    if (f.type === "select" && (!Array.isArray(f.options) || f.options.length === 0 || f.options.some((o) => typeof o !== "string" || !o.trim()))) {
      out.push(`${at}[${i}] is a select and needs a list of options`);
    }
  });
  return out;
}

export function validCurrency(code: unknown): boolean {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

// A zone name, never an offset: Intl takes "+05:00" as UTC+5, but Postgres
// reads the same text POSIX-style as UTC-5, so a note's "when" would land ten
// hours away from what every page shows.
export function validTimeZone(tz: string): boolean {
  if (!/^[A-Za-z]/.test(tz) || /[+-]\d/.test(tz.replace(/^Etc\/GMT[+-]\d{1,2}$/, ""))) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
