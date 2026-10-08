// CSV in: the customer list a business keeps today becomes customers,
// without duplicates and without losing what the CRM already knows.
//
// - Every row is matched first by email (normalizeEmail), then by phone
//   (phone.ts), against the CRM and against earlier rows of the same file,
//   so a list with one person on three rows makes one customer. A row with
//   neither matches by name a customer who has neither.
// - A matched customer only gains: an empty field is filled, tags are added,
//   the last contact only moves later. A field that already has a value is
//   kept unless `overwrite` is set.
// - Anyone still without a last contact gets their latest submission,
//   booking or payment (history.ts latestActivity), by email.
// - The whole import is one transaction: all of it lands or none of it.
// - A dry run reads the database the same way and writes nothing.
import { q, type Db, type Query } from "../data/db";
import { normalizeEmail } from "../data/email";
import type { CustomField } from "../config-schema";
import type { Customer } from "./customers";
import { readFields } from "./fields";
import { latestActivity } from "./history";
import { parseDate } from "./csv-read";
import { cleanPhone, phoneKey } from "./phone";
import { resolveStage, type Stage } from "./stages";
import { clean, parseTags } from "./text";

const SCALARS = ["name", "email", "phone", "company", "address", "source", "owner", "notes"] as const;
type Scalar = (typeof SCALARS)[number];
export const IMPORT_FIELDS = ["name", "first_name", "last_name", ...SCALARS.slice(1), "stage", "tags", "last_contact_at"];

const GUESS: Record<string, RegExp> = {
  name: /^(name|full name|customer|customer name|client|client name|patient|patient name|guest|guest name|contact|contact name)$/,
  first_name: /^(first name|first|given name|forename)$/,
  last_name: /^(last name|last|surname|family name)$/,
  email: /^(e ?mail|email address|e ?mail address)$/,
  phone: /^(phone|phone number|phone no|mobile|mobile number|mobile phone|cell|cell phone|cell number|telephone|tel|primary phone|home phone|work phone)$/,
  company: /^(company|company name|business|organi[sz]ation|account)$/,
  address: /^(address|street address|street|full address|mailing address)$/,
  stage: /^(stage|status|pipeline|pipeline stage)$/,
  source: /^(source|lead source|channel|how did you hear about us|referral source)$/,
  tags: /^(tags?|labels?|groups?|categor(y|ies))$/,
  owner: /^(owner|assigned|assigned to|assignee|rep|sales ?rep|account manager)$/,
  notes: /^(notes?|comments?|description|details|remarks)$/,
  last_contact_at: /^(last contact(ed)?|last contact date|last contacted on|last visit|last activity)$/,
};

// "Cell #", "Phone No.", "E-mail:" read as "cell", "phone no", "e mail".
const norm = (h: string) => h.toLowerCase().replace(/[_\-#.:*]+/g, " ").replace(/\s+/g, " ").trim();

/** Which header feeds which field, guessed from the header names. Custom fields match their key or label. */
export function guessMap(headers: string[], defs: CustomField[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of defs) {
    const h = headers.find((x) => !used.has(x) && (norm(x) === norm(f.key) || norm(x) === norm(f.label)));
    if (h) {
      map[f.key] = h;
      used.add(h);
    }
  }
  for (const [field, rx] of Object.entries(GUESS)) {
    const h = headers.find((x) => !used.has(x) && rx.test(norm(x)));
    if (h) {
      map[field] = h;
      used.add(h);
    }
  }
  return map;
}

export type ImportRecord = {
  line: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: string | null;
  source: string | null;
  owner: string | null;
  notes: string | null;
  stage: string | null;
  tags: string[];
  last_contact_at: string | null;
  fields: Record<string, unknown>;
};

export type Plan = { records: ImportRecord[]; skipped: number[]; warnings: string[] };

/** Rows (header first) to records, by the map. A row with no name, email or phone is skipped. */
export function planRows(rows: string[][], map: Record<string, string>, defs: CustomField[], stages: Stage[]): Plan {
  const headers = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(Object.entries(map).map(([f, h]) => [f, headers.indexOf(h)]));
  const cell = (r: string[], f: string) => (idx[f] !== undefined && idx[f] >= 0 ? (r[idx[f]] ?? "").trim() : "");
  const plan: Plan = { records: [], skipped: [], warnings: [] };
  const unknownStage = new Set<string>();
  const badEmail: number[] = [];
  const fieldWarnings = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const rawEmail = cell(r, "email");
    const email = normalizeEmail(rawEmail);
    if (rawEmail && !email) badEmail.push(line);
    const joined = [cell(r, "first_name"), cell(r, "last_name")].filter(Boolean).join(" ");
    const name = clean(cell(r, "name") || joined, 200);
    const phone = cleanPhone(cell(r, "phone"));
    if (!name && !email && !phoneKey(phone)) {
      plan.skipped.push(line);
      return;
    }
    const stageRaw = cell(r, "stage");
    const stage = stageRaw ? (resolveStage(stages, stageRaw)?.key ?? null) : null;
    if (stageRaw && !stage) unknownStage.add(stageRaw);
    const fr = readFields(defs, Object.fromEntries(defs.filter((f) => map[f.key]).map((f) => [f.key, cell(r, f.key)])), { lenient: true });
    for (const e of fr.errors) fieldWarnings.add(e);
    const last = cell(r, "last_contact_at");
    plan.records.push({
      line,
      name,
      email,
      phone,
      company: clean(cell(r, "company"), 200),
      address: clean(cell(r, "address"), 500),
      source: clean(cell(r, "source"), 100),
      owner: clean(cell(r, "owner"), 200),
      notes: clean(cell(r, "notes"), 10_000),
      stage,
      tags: parseTags(cell(r, "tags")),
      last_contact_at: last ? parseDate(last) : null,
      fields: fr.set,
    });
  });
  if (unknownStage.size) plan.warnings.push(`stage values that name no stage (the default stage is used): ${[...unknownStage].slice(0, 10).join(", ")}`);
  if (badEmail.length) plan.warnings.push(`${badEmail.length} email value(s) are not addresses and were left out (lines ${badEmail.slice(0, 10).join(", ")})`);
  for (const w of [...fieldWarnings].slice(0, 10)) plan.warnings.push(w);
  return plan;
}

type Values = Record<Scalar, string | null> & { stage: string; tags: string[]; fields: Record<string, unknown>; last_contact_at: string | null };
type Target = { id: string | null; values: Values; changed: boolean; rows: number };

export type ImportOptions = { overwrite?: boolean; dryRun?: boolean; defaultStage: string; source?: string | null; tags?: string[]; user: string };
export type ImportSummary = { rows: number; created: number; updated: number; unchanged: number; merged: number; skipped: number; examples: string[] };

export async function runImport(db: Db, plan: Plan, opts: ImportOptions): Promise<ImportSummary> {
  const emails = [...new Set(plan.records.map((r) => r.email).filter((e): e is string => !!e))];
  const keys = [...new Set(plan.records.map((r) => phoneKey(r.phone)).filter((k): k is string => !!k))];
  const names = [...new Set(plan.records.filter((r) => !r.email && !phoneKey(r.phone) && r.name).map((r) => r.name!.toLowerCase()))];
  const known = emails.length || keys.length || names.length
    ? await db.sql<Customer>`
        select c.* from customers c
        where c.email = any(${emails}::citext[]) or c.other_emails && ${emails.map((e) => e.toLowerCase())}::text[]
           or right(regexp_replace(regexp_replace(c.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = any(${keys}::text[])
           or (c.email is null and length(regexp_replace(regexp_replace(coalesce(c.phone, ''), '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g')) < 7 and lower(c.name) = any(${names}::text[]))
        order by c.archived_at nulls first, c.id`
    : [];

  const byEmail = new Map<string, Target>();
  const byPhone = new Map<string, Target[]>();
  // A row with neither an email nor a phone can only be told apart by its
  // name, so it matches a customer of the same name who has neither either:
  // importing the same sheet twice adds nobody twice.
  const byBareName = new Map<string, Target>();
  const targets: Target[] = [];
  const index = (t: Target) => {
    if (t.values.email) byEmail.set(t.values.email.toLowerCase(), t);
    const k = phoneKey(t.values.phone);
    if (k && !(byPhone.get(k) ?? []).includes(t)) byPhone.set(k, [...(byPhone.get(k) ?? []), t]);
    const bare = !t.values.email && !k ? t.values.name?.toLowerCase() : null;
    if (bare && !byBareName.has(bare)) byBareName.set(bare, t);
  };
  for (const c of known) {
    const t: Target = {
      id: String(c.id),
      changed: false,
      rows: 0,
      values: {
        name: c.name, email: c.email, phone: c.phone, company: c.company, address: c.address, source: c.source, owner: c.owner, notes: c.notes,
        stage: c.stage, tags: c.tags ?? [], fields: { ...(c.fields ?? {}) },
        last_contact_at: c.last_contact_at ? new Date(c.last_contact_at).toISOString() : null,
      },
    };
    // Lists are ordered active first, so the first customer to claim a key keeps it.
    if (!(t.values.email && byEmail.has(t.values.email.toLowerCase()))) index(t);
    // A row with an address they also go by (a merge) is theirs too.
    for (const e of c.other_emails ?? []) if (!byEmail.has(e.toLowerCase())) byEmail.set(e.toLowerCase(), t);
  }

  const extraTags = opts.tags ?? [];
  let merged = 0;
  for (const r of plan.records) {
    const key = phoneKey(r.phone);
    let t = r.email ? byEmail.get(r.email) : undefined;
    if (!t && key) t = (byPhone.get(key) ?? []).find((x) => !x.values.email || !r.email);
    if (!t && !r.email && !key && r.name) {
      const same = byBareName.get(r.name.toLowerCase());
      if (same && !same.values.email && !phoneKey(same.values.phone)) t = same;
    }
    if (!t) {
      t = {
        id: null,
        changed: true,
        rows: 0,
        values: {
          name: r.name ?? r.email ?? r.phone ?? "Unknown", email: r.email, phone: r.phone, company: r.company, address: r.address,
          source: r.source ?? opts.source ?? null, owner: r.owner, notes: r.notes, stage: r.stage ?? opts.defaultStage,
          tags: parseTags([...r.tags, ...extraTags]), fields: { ...r.fields }, last_contact_at: r.last_contact_at,
        },
      };
      targets.push(t);
    } else {
      if (t.rows > 0 || (t.id === null)) merged++;
      if (!targets.includes(t)) targets.push(t);
      merge(t, r, extraTags, !!opts.overwrite);
    }
    t.rows++;
    index(t);
  }

  // Someone the CRM has no last contact for gets their latest submission,
  // booking or payment, by email. A date already there (from the CRM or the
  // file) is kept, so the last contact never moves earlier.
  const undated = targets.filter((t) => t.values.email && !t.values.last_contact_at);
  const latest = await latestActivity(db, undated.map((t) => t.values.email!.toLowerCase()));
  for (const t of undated) {
    const at = latest.get(t.values.email!.toLowerCase());
    if (!at) continue;
    t.values.last_contact_at = at.toISOString();
    t.changed = true;
  }

  const summary: ImportSummary = { rows: plan.records.length, created: 0, updated: 0, unchanged: 0, merged, skipped: plan.skipped.length, examples: [] };
  const statements: Query[] = [];
  for (const t of targets) {
    const v = t.values;
    if (t.id === null) {
      summary.created++;
      if (summary.examples.length < 10) summary.examples.push(`add     ${describe(v)}`);
      statements.push(q`
        insert into customers (name, email, phone, company, address, stage, source, tags, owner, fields, notes, last_contact_at, created_by, updated_by)
        values (${v.name}, ${v.email}::citext, ${v.phone}, ${v.company}, ${v.address}, ${v.stage}, ${v.source}, ${v.tags}::text[], ${v.owner}::citext,
                ${JSON.stringify(v.fields)}::jsonb, ${v.notes}, ${v.last_contact_at}::timestamptz, ${opts.user}, ${opts.user})
        on conflict (email) where email is not null do nothing`);
    } else if (t.changed) {
      summary.updated++;
      if (summary.examples.length < 10) summary.examples.push(`update  #${t.id} ${describe(v)}`);
      statements.push(q`
        update customers set name = ${v.name}, email = ${v.email}::citext, phone = ${v.phone}, company = ${v.company}, address = ${v.address},
          stage = ${v.stage}, source = ${v.source}, tags = ${v.tags}::text[], owner = ${v.owner}::citext, fields = ${JSON.stringify(v.fields)}::jsonb,
          notes = ${v.notes}, last_contact_at = ${v.last_contact_at}::timestamptz, updated_at = now(), updated_by = ${opts.user}
        where id = ${t.id}::bigint`);
    } else summary.unchanged++;
  }
  if (!opts.dryRun && statements.length) await db.transaction(statements);
  return summary;
}

function merge(t: Target, r: ImportRecord, extraTags: string[], overwrite: boolean) {
  const v = t.values;
  for (const f of SCALARS) {
    const next = r[f];
    if (next === null || next === undefined || next === "") continue;
    const cur = v[f];
    if (cur === null || cur === "" || (overwrite && cur !== next)) {
      if (cur !== next) {
        v[f] = next;
        t.changed = true;
      }
    }
  }
  if (r.stage && overwrite && r.stage !== v.stage) {
    v.stage = r.stage;
    t.changed = true;
  }
  const tags = parseTags([...v.tags, ...r.tags, ...extraTags]);
  if (tags.length !== v.tags.length) {
    v.tags = tags;
    t.changed = true;
  }
  for (const [k, val] of Object.entries(r.fields)) {
    const cur = v.fields[k];
    if (cur === undefined || cur === null || cur === "" || (overwrite && cur !== val)) {
      if (cur !== val) {
        v.fields[k] = val;
        t.changed = true;
      }
    }
  }
  if (r.last_contact_at && (!v.last_contact_at || new Date(r.last_contact_at) > new Date(v.last_contact_at))) {
    v.last_contact_at = r.last_contact_at;
    t.changed = true;
  }
}

function describe(v: Values): string {
  return [v.name, v.email, v.phone, v.company ? `(${v.company})` : "", `[${v.stage}]`, v.tags.length ? v.tags.map((x) => `#${x}`).join(" ") : ""].filter(Boolean).join("  ");
}
