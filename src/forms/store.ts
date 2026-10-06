// Reading forms and writing submissions. The Website and the CRM look in the
// same submissions table.
import { q, type Db } from "../data/db";
import { checkFields, sitePath, type Field, type Form, type Submission } from "./fields";
import type { Charge } from "./price";

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

/** A form with no steps, sent whole: complete as it arrives (completed_at's default). */
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

// ---- drafts: a form with steps, before its questions are all answered -------------

export type Draft = {
  id: string;
  form_key: string;
  /** Steps finished. */
  step: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  data: Record<string, unknown>;
  spam: boolean;
  submission_id: string | null;
};

const toDraft = (r: Record<string, any>): Draft => ({
  id: String(r.id), form_key: r.form_key, step: Number(r.step), name: r.name ?? null, email: r.email ?? null, phone: r.phone ?? null,
  data: r.data ?? {}, spam: !!r.spam, submission_id: r.submission_id == null ? null : String(r.submission_id),
});

/** The first step's answers, under the key the visitor holds (its hash). */
export async function startDraft(
  db: Db,
  d: Omit<Submission, "data"> & { data: Record<string, unknown>; form_key: string; key_hash: string; source: string; page: string | null; spam: boolean },
): Promise<Draft> {
  const [row] = await db.sql`
    insert into submission_drafts (form_key, key_hash, name, email, phone, data, spam, source, page)
    values (${d.form_key}, ${d.key_hash}, ${d.name}, ${d.email}, ${d.phone}, ${JSON.stringify(d.data)}::jsonb, ${d.spam}, ${d.source}, ${d.page})
    returning *`;
  return toDraft(row);
}

export async function draftByKey(db: Db, formKey: string, keyHash: string): Promise<Draft | null> {
  const [row] = await db.sql`select * from submission_drafts where key_hash = ${keyHash} and form_key = ${formKey}`;
  return row ? toDraft(row) : null;
}

/**
 * A step's answers, merged into the draft, and the step counted, only when
 * the draft is still at step `from`: a second post of the same step (a double
 * click, the back button) changes nothing and says so.
 */
export async function saveStep(db: Db, id: string, from: number, sub: Omit<Submission, "data"> & { data: Record<string, unknown> }): Promise<boolean> {
  const rows = await db.sql`
    update submission_drafts set
      name = coalesce(${sub.name}, name), email = coalesce(${sub.email}::citext, email), phone = coalesce(${sub.phone}, phone),
      -- Each page's consent wording and order lines join the earlier pages' rather than replacing them.
      data = data || ${JSON.stringify(sub.data)}::jsonb
             || case when ${JSON.stringify(sub.data)}::jsonb ? '_consent'
                     then jsonb_build_object('_consent', coalesce(data -> '_consent', '{}'::jsonb) || (${JSON.stringify(sub.data)}::jsonb -> '_consent'))
                     else '{}'::jsonb end
             || case when ${JSON.stringify(sub.data)}::jsonb ? '_lines'
                     then jsonb_build_object('_lines', coalesce(data -> '_lines', '{}'::jsonb) || (${JSON.stringify(sub.data)}::jsonb -> '_lines'))
                     else '{}'::jsonb end,
      step = step + 1, updated_at = now()
    where id = ${id}::bigint and step = ${from} returning id`;
  return rows.length > 0;
}

/**
 * The questions are answered: the draft becomes a submission, once. The draft
 * is locked first, so two posts make one submission; the second gets the
 * first's id. `complete` when no booking or payment step follows. Returns
 * the submission's id and whether this call made it.
 */
export async function finishDraft(db: Db, id: string, complete: boolean): Promise<{ submissionId: string; made: boolean } | null> {
  const [, made, now] = await db.transaction([
    q`select id from submission_drafts where id = ${id}::bigint for update`,
    q`with made as (
        insert into submissions (form_key, name, email, phone, data, source, page, status, completed_at)
        select form_key, name, email, phone, data, source, page, case when spam then 'spam' else 'new' end,
               case when ${complete} then now() end
        from submission_drafts where id = ${id}::bigint and submission_id is null
        returning id)
      update submission_drafts set submission_id = (select id from made), updated_at = now()
      where id = ${id}::bigint and exists (select 1 from made)
      returning submission_id::text`,
    q`select submission_id::text from submission_drafts where id = ${id}::bigint`,
  ]);
  if (made[0]) return { submissionId: made[0].submission_id, made: true };
  return now[0]?.submission_id ? { submissionId: now[0].submission_id, made: false } : null;
}

/**
 * A step after the questions is done: its charge (a booking's price) kept
 * under the step's name, replacing any from an earlier try, and the draft
 * moved on, together; only when the draft is still at step `from`. Moving
 * past the `last` step completes the submission.
 */
export async function finishStep(db: Db, draftId: string, submissionId: string, from: number, step: string, charge: Charge | null, advance: boolean, last: boolean): Promise<boolean> {
  const [moved] = await db.transaction([
    q`update submission_drafts set step = step + ${advance ? 1 : 0}, updated_at = now() where id = ${draftId}::bigint and step = ${from} returning id`,
    q`update submissions set data = jsonb_set(data, '{_charges}', (coalesce(data -> '_charges', '{}'::jsonb) - ${step}::text) || ${charge ? JSON.stringify({ [step]: charge }) : "{}"}::jsonb),
             completed_at = case when ${advance && last} then coalesce(completed_at, now()) else completed_at end,
             updated_at = now()
      where id = ${submissionId}::bigint and exists (select 1 from submission_drafts where id = ${draftId}::bigint and step = ${from + (advance ? 1 : 0)})`,
  ]);
  return moved.length > 0;
}

/** Back to an earlier step (a held time was released): its charge goes with it, and it is not complete. */
export async function rewindDraft(db: Db, draftId: string, submissionId: string, to: number, step: string): Promise<void> {
  await db.transaction([
    q`update submission_drafts set step = ${to}, updated_at = now() where id = ${draftId}::bigint and step > ${to}`,
    q`update submissions set data = jsonb_set(data, '{_charges}', coalesce(data -> '_charges', '{}'::jsonb) - ${step}::text),
             completed_at = null, updated_at = now()
      where id = ${submissionId}::bigint`,
  ]);
}

/**
 * A form that ends in payment is complete when Stripe says it is paid: the
 * payments webhook's afterPaid calls this with the payment it marked
 * (payments/webhook.ts). Returns the submission it is for, complete now or
 * already, so what follows completion can run (and run again: it is safe
 * to); null for a payment that is not a submission's.
 */
export async function completePaidSubmission(db: Db, paymentId: string): Promise<string | null> {
  const [, [row]] = await db.transaction([
    q`update submissions s set completed_at = now(), updated_at = now()
      from payments p
      where p.id = ${paymentId}::bigint and p.ref_type = 'submission' and s.id::text = p.ref_id
        and p.status in ('paid', 'partially_refunded', 'refunded') and s.completed_at is null`,
    q`select s.id::text as id from submissions s join payments p on s.id::text = p.ref_id
      where p.id = ${paymentId}::bigint and p.ref_type = 'submission' and p.status in ('paid', 'partially_refunded', 'refunded')`,
  ]);
  return (row?.id as string | undefined) ?? null;
}

export async function submissionById(db: Db, id: string) {
  const [row] = await db.sql`select id::text as id, name, email::text as email, phone, data, page from submissions where id = ${id}::bigint`;
  return row
    ? { id: row.id as string, name: row.name ?? null, email: row.email ?? null, phone: row.phone ?? null, data: (row.data ?? {}) as Record<string, unknown>, page: (row.page ?? null) as string | null }
    : null;
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
