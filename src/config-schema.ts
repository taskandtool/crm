// The shape of crm.config.json and its validator, with no file loaded:
// scripts/check.mjs and the tests import this to judge any config, the
// examples included.
export type StageKind = "open" | "won" | "lost";
export type StageConfig = { key: string; label: string; kind?: StageKind };
export type FieldType = "text" | "number" | "date" | "select" | "phone" | "email";
export type CustomField = { key: string; label: string; type: FieldType; options?: string[] };
/** The events on the schedule (an appointment, a job, a visit): their words, their own custom fields, the currency their amounts are in. */
export type EventsConfig = { one: string; many: string; fields: CustomField[]; currency?: string };
/** Deals: what one piece of work being won is called, the stages seeded on the first run, the currency of their values, and the reasons offered when one is lost. */
export type DealsConfig = { one: string; many: string; stages: StageConfig[]; currency?: string; lost_reasons?: string[] };
/** Tasks: whether a deal made from a lead gets a "Call back" due that day. On unless false. */
export type TasksConfig = { new_lead?: boolean };
/** Quotes and invoices: their currency, standing terms, days to pay, and what a quote is called (the name on them is Settings, Business). */
export type InvoicesConfig = { currency?: string; terms?: string; days_until_due?: number; quote_word?: "Quote" | "Proposal" | "Estimate" };
export const QUOTE_WORDS = ["Quote", "Proposal", "Estimate"] as const;
export type Config = {
  business: string;
  vocabulary: { one: string; many: string };
  /** A customer's status (Lead, Customer, Not a fit), seeded on the first run. */
  statuses: StageConfig[];
  deals: DealsConfig;
  tasks?: TasksConfig;
  sources: string[];
  fields: CustomField[];
  owner_label?: string;
  time_zone: string;
  /** The schedule: its events, the Calendar and the Team. false (or absent) turns it off. */
  events?: EventsConfig | false;
  /** Online booking: the Services customers book, their reminders. Needs events. On unless false. */
  booking?: boolean;
  /** The Website's booking pages, absolute ("https://acme.com/book"): a booking the team makes then mails a manage link there. */
  booking_page?: string;
  /** Quotes and invoices (the invoices skill); false leaves them out. */
  invoices?: InvoicesConfig | false;
};

export const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const FIELD_TYPES: FieldType[] = ["text", "number", "date", "select", "phone", "email"];
export const STAGE_KINDS: StageKind[] = ["open", "won", "lost"];
// Custom field keys share the CSV header row and the scripts' flags with the
// built-in columns, so they may not reuse a built-in name.
// The built-in columns' CSV headers (crm/columns.ts): a custom field labelled
// the same would export two "Email" columns and import into the wrong one.
export const BUILT_IN_HEADERS = ["id", "name", "email", "phone", "company", "address", "stage", "status", "source", "tags", "owner", "notes", "last contact (utc)", "added (utc)", "changed (utc)", "archived (utc)"];
// The same for an event's custom fields (crm/events.ts's CSV columns).
export const EVENT_BUILT_IN = ["id", "customer", "customer_id", "title", "status", "starts_at", "ends_at", "when", "service", "amount", "amount_cents", "currency", "where", "notes", "created_at", "updated_at", "updated_by"];
export const EVENT_HEADERS = ["id", "customer", "customer email", "customer phone", "what", "service", "status", "where", "notes", "added (utc)"];
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

  out.push(...stageProblems(c.statuses, "statuses", "status", "new people"));
  const dl = c.deals as Partial<DealsConfig> | undefined;
  if (!dl || typeof dl !== "object" || Array.isArray(dl)) out.push('deals must be an object, e.g. { "one": "Deal", "many": "Deals", "stages": [...] }');
  else {
    if (typeof dl.one !== "string" || typeof dl.many !== "string" || !dl.one.trim() || !dl.many.trim()) out.push('deals needs one and many, e.g. { "one": "Deal", "many": "Deals" }');
    out.push(...stageProblems(dl.stages, "deals.stages", "stage", "new deals"));
    if (dl.currency !== undefined && !validCurrency(dl.currency)) out.push(`deals.currency must be a currency code such as "USD" (got ${JSON.stringify(dl.currency)})`);
    if (dl.lost_reasons !== undefined && !(Array.isArray(dl.lost_reasons) && dl.lost_reasons.every((r) => typeof r === "string" && r.trim() && r.length <= 100))) {
      out.push("deals.lost_reasons must be a list of short reasons (it may be empty)");
    }
  }
  const fu = c.tasks as Partial<TasksConfig> | undefined;
  if (fu !== undefined && (!fu || typeof fu !== "object" || Array.isArray(fu) || (fu.new_lead !== undefined && typeof fu.new_lead !== "boolean"))) {
    out.push('tasks must be an object, e.g. { "new_lead": true }');
  }

  if (!Array.isArray(c.sources) || c.sources.some((s) => typeof s !== "string" || !s.trim())) out.push("sources must be a list of names (it may be empty)");

  out.push(...fieldProblems(c.fields, "fields", BUILT_IN, BUILT_IN_HEADERS));
  if (c.owner_label !== undefined && (typeof c.owner_label !== "string" || !c.owner_label.trim())) out.push("owner_label must be a word such as Owner or Technician");
  if (typeof c.time_zone !== "string" || !validTimeZone(c.time_zone)) out.push(`time_zone must be an IANA zone name such as "America/Chicago" or "UTC" (got ${JSON.stringify(c.time_zone)})`);

  if (c.booking !== undefined && typeof c.booking !== "boolean") out.push("booking must be true or false");
  if (c.booking_page !== undefined && !(typeof c.booking_page === "string" && /^https:\/\/[^\s/]+(\/\S*)?$/.test(c.booking_page))) {
    out.push('booking_page must be the Website\'s booking address, like "https://acme.com/book"');
  }
  if (c.invoices !== undefined && c.invoices !== false) {
    const iv = c.invoices as Partial<InvoicesConfig> | null;
    if (!iv || typeof iv !== "object" || Array.isArray(iv)) out.push('invoices must be false or an object, e.g. { "currency": "USD" }');
    else {
      if (iv.currency !== undefined && !validCurrency(iv.currency)) out.push(`invoices.currency must be a currency code such as "USD" (got ${JSON.stringify(iv.currency)})`);
      if (iv.terms !== undefined && (typeof iv.terms !== "string" || iv.terms.length > 2000)) out.push("invoices.terms must be text of up to 2000 characters");
      if (iv.days_until_due !== undefined && !(Number.isInteger(iv.days_until_due) && iv.days_until_due >= 0 && iv.days_until_due <= 365)) out.push("invoices.days_until_due must be a whole number of days, 0 to 365");
      if (iv.quote_word !== undefined && !QUOTE_WORDS.includes(iv.quote_word)) out.push(`invoices.quote_word is what a quote is called: ${QUOTE_WORDS.map((x) => `"${x}"`).join(", ")} (got ${JSON.stringify(iv.quote_word)})`);
    }
  }
  if (c.events !== undefined && c.events !== false) {
    const vs = c.events as Partial<EventsConfig> | null;
    if (!vs || typeof vs !== "object" || Array.isArray(vs)) out.push('events must be false or an object, e.g. { "one": "Event", "many": "Events", "fields": [] }');
    else {
      if (typeof vs.one !== "string" || typeof vs.many !== "string" || !vs.one.trim() || !vs.many.trim()) out.push('events needs one and many, e.g. { "one": "Event", "many": "Events" }');
      // The CSV also heads columns with the owner's label, "When (zone)" and "Amount (currency)".
      const owner = (typeof c.owner_label === "string" && c.owner_label.trim() ? c.owner_label : "Owner").trim().toLowerCase();
      out.push(...fieldProblems(vs.fields, "events.fields", EVENT_BUILT_IN, [...EVENT_HEADERS, owner]));
      if (Array.isArray(vs.fields)) {
        vs.fields.forEach((f, i) => {
          if (typeof f?.label === "string" && /^\s*(when|amount)\s*\(/i.test(f.label)) out.push(`events.fields[${i}].label ${f.label} reads as a built-in column's name; pick another label`);
        });
      }
      if (vs.currency !== undefined && !validCurrency(vs.currency)) out.push(`events.currency must be a currency code such as "USD" or "GBP" (got ${JSON.stringify(vs.currency)})`);
    }
  } else if (c.booking !== false) {
    out.push('booking needs events: turn events on, e.g. { "one": "Event", "many": "Events", "fields": [] }, or set "booking": false');
  }
  return out;
}

// A list of statuses or deal stages: slug keys, no repeats, a known kind, and
// at least one open one for new rows to start in.
function stageProblems(list: unknown, at: string, one: string, landing: string): string[] {
  const out: string[] = [];
  if (!Array.isArray(list) || list.length === 0) return [`${at} must list at least one ${one}`];
  const keys = new Set<string>();
  (list as StageConfig[]).forEach((s, i) => {
    if (!s || typeof s !== "object") return out.push(`${at}[${i}] is not an object`);
    if (!KEY.test(s.key ?? "")) out.push(`${at}[${i}].key must match ${KEY}`);
    if (keys.has(s.key)) out.push(`${at}[${i}].key ${s.key} repeats`);
    keys.add(s.key);
    if (typeof s.label !== "string" || !s.label.trim()) out.push(`${at}[${i}].label is missing`);
    if (s.kind !== undefined && !STAGE_KINDS.includes(s.kind)) out.push(`${at}[${i}].kind must be open, won or lost`);
  });
  if (!(list as StageConfig[]).some((s) => (s?.kind ?? "open") === "open")) out.push(`${at} needs at least one open ${one}, where ${landing} land`);
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
