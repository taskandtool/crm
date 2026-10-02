// Custom fields: declared in crm.config.json, stored in customers.fields
// (jsonb), so a business gets "Insurance" or "Truck" without a migration.
// This reads them from a form, a script flag or a spreadsheet cell, checked
// against their type.
import type { CustomField } from "../config-schema";
import { normalizeEmail } from "../data/email";
import { parseDate } from "./csv-read";
import { cleanPhone } from "./phone";

export type FieldRead = { set: Record<string, unknown>; unset: string[]; errors: string[] };

/**
 * Read custom fields by key from `input`. A key absent from `input` is left
 * alone; an empty value clears it. `lenient` is for spreadsheets: loose
 * dates, and a select value outside the options kept as written (with a
 * warning) rather than refused.
 */
export function readFields(defs: CustomField[], input: Record<string, unknown>, opts: { lenient?: boolean } = {}): FieldRead {
  const out: FieldRead = { set: {}, unset: [], errors: [] };
  for (const f of defs) {
    if (!(f.key in input)) continue;
    const raw = input[f.key];
    const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!s) {
      out.unset.push(f.key);
      continue;
    }
    switch (f.type) {
      case "number": {
        const n = Number(s.replace(/[, ]/g, ""));
        if (Number.isFinite(n)) out.set[f.key] = n;
        else out.errors.push(`${f.label}: "${s}" is not a number`);
        break;
      }
      case "date": {
        const d = opts.lenient ? parseDate(s) : /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDate(s) : null;
        if (d) out.set[f.key] = d;
        else out.errors.push(`${f.label}: "${s}" is not a date (YYYY-MM-DD)`);
        break;
      }
      case "select": {
        const o = (f.options ?? []).find((x) => x.toLowerCase() === s.toLowerCase());
        if (o) out.set[f.key] = o;
        else if (opts.lenient) {
          out.set[f.key] = s.slice(0, 200);
          out.errors.push(`${f.label}: "${s}" is not one of its options; kept as written`);
        } else out.errors.push(`${f.label}: choose one of ${(f.options ?? []).join(", ")}`);
        break;
      }
      case "email": {
        const e = normalizeEmail(s);
        if (e) out.set[f.key] = e;
        else out.errors.push(`${f.label}: "${s}" is not an email address`);
        break;
      }
      case "phone":
        out.set[f.key] = cleanPhone(s);
        break;
      default:
        out.set[f.key] = s.slice(0, 2000);
    }
  }
  return out;
}

/** A stored custom field value as text, for a page, an input or a CSV cell. */
export function fieldText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
