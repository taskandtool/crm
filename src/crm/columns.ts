// The CSV columns of an export, the same from the page and from
// scripts/export.mjs. The header names are the ones scripts/import.mjs reads
// back, so an export imports again as it is. Formula cells are defused by
// admin/csv.ts.
import type { CsvColumn } from "../admin/csv";
import type { CustomField } from "../config-schema";
import type { Customer } from "./customers";
import { fieldText } from "./fields";

export function csvColumns(stageLabels: Map<string, string>, fields: CustomField[]): CsvColumn<Customer>[] {
  return [
    { label: "ID", value: (r) => r.id },
    { label: "Name", value: (r) => r.name },
    { label: "Email", value: (r) => r.email },
    { label: "Phone", value: (r) => r.phone },
    { label: "Company", value: (r) => r.company },
    { label: "Address", value: (r) => r.address },
    { label: "Stage", value: (r) => stageLabels.get(r.stage) ?? r.stage },
    { label: "Source", value: (r) => r.source },
    { label: "Tags", value: (r) => r.tags.join(", ") },
    { label: "Owner", value: (r) => r.owner },
    ...fields.map((fd): CsvColumn<Customer> => ({ label: fd.label, value: (r) => fieldText(r.fields?.[fd.key]) })),
    { label: "Notes", value: (r) => r.notes },
    { label: "Last contact (UTC)", value: (r) => r.last_contact_at },
    { label: "Added (UTC)", value: (r) => r.created_at },
    { label: "Changed (UTC)", value: (r) => r.updated_at },
    { label: "Archived (UTC)", value: (r) => r.archived_at },
  ];
}
