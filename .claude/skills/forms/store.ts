// Reading forms and writing submissions. The CRM, the Booking app and the
// Website all look in the same submissions table.
import type { Db } from "../data/db";
import { checkFields, sitePath, type Field, type Form, type Submission } from "./fields";

/** The form with this key, or null. A broken field in the row is left out, never rendered half-made. */
export async function loadForm(db: Db, key: string): Promise<Form | null> {
  const [row] = await db.sql`
    select key, title, fields, notify_emails::text[] as notify_emails, redirect_to, success_message, submit_label, active
    from forms where key = ${key}`;
  return row ? toForm(row) : null;
}

export function toForm(row: Record<string, any>): Form {
  return {
    key: row.key,
    title: row.title,
    fields: checkFields(row.fields).fields,
    notify_emails: row.notify_emails ?? [],
    redirect_to: sitePath(row.redirect_to),
    success_message: row.success_message ?? null,
    submit_label: row.submit_label ?? null,
    active: row.active !== false,
  };
}

/**
 * Create a form if no row has its key yet. Never overwrites: once the row
 * exists it is the owner's, edited in /admin/forms. Run from setup.
 */
export async function seedForm(db: Db, form: { key: string; title: string; fields: Field[] } & Partial<Form>, source: string): Promise<void> {
  await db.sql`
    insert into forms (key, title, fields, notify_emails, redirect_to, success_message, submit_label, source)
    values (${form.key}, ${form.title}, ${JSON.stringify(form.fields)}::jsonb, ${form.notify_emails ?? []}::citext[],
            ${form.redirect_to ?? null}, ${form.success_message ?? null}, ${form.submit_label ?? null}, ${source})
    on conflict (key) do nothing`;
}

export async function insertSubmission(
  db: Db,
  s: Omit<Submission, "data"> & { data: Record<string, unknown>; form_key: string; source: string; page: string | null; status: "new" | "spam" },
): Promise<number> {
  const [row] = await db.sql<{ id: string }>`
    insert into submissions (form_key, name, email, phone, data, source, page, status)
    values (${s.form_key}, ${s.name}, ${s.email}, ${s.phone}, ${JSON.stringify(s.data)}::jsonb, ${s.source}, ${s.page}, ${s.status})
    returning id`;
  return Number(row.id);
}

/** The contact form the Website starts with; the key the old `leads` rows move to. */
export const CONTACT_FORM: { key: string; title: string; fields: Field[]; submit_label: string } = {
  key: "contact",
  title: "Contact",
  submit_label: "Send the message",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "phone", label: "Phone", type: "tel" },
    { name: "message", label: "What do you need?", type: "textarea" },
  ],
};
