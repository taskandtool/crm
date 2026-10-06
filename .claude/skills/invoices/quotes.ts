// Quotes: a CRM document, not Stripe's. Made as a draft, edited while it is a
// draft, sent through the owner's own sender, then accepted or declined by a
// person. Its status only moves forward:
//
//   draft -> sent -> accepted | declined | expired
//   draft -> accepted | declined | expired      (a yes on the phone before it went out)
//   expired -> accepted | declined               (a late yes still counts)
//
// A sent quote is never edited: copy it to a new draft. Nothing is deleted.
//
//   const r = await createQuote(db, { email, name, currency: "usd", lines: [...] }, by, "crm");
//   await markSent(db, r.value.id, by);
//   await decideQuote(db, id, "accepted", by);
import { likePattern } from "../admin/query";
import { q, type Db } from "../data/db";
import { normalizeEmail } from "../data/email";
import { currencyCode } from "../payments/money";
import { taxRates } from "../payments/tax";
import { clearLines, insertLines, readLines, sumLines, toLine, type Errors, type Line, type Saved, type SavedLine } from "./lines";

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft", sent: "Sent", accepted: "Accepted", declined: "Declined", expired: "Expired",
};

export type Quote = {
  id: string;
  number: string;
  email: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  status: QuoteStatus;
  currency: string;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  valid_until: string | null;
  notes: string | null;
  terms: string | null;
  sent_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  visit_id: string | null;
  source: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type QuoteFields = {
  email?: unknown;
  name?: unknown;
  phone?: unknown;
  address?: unknown;
  currency?: unknown;
  valid_until?: unknown;
  notes?: unknown;
  terms?: unknown;
  visit_id?: unknown;
  lines?: unknown;
};

type Head = {
  email: string; name: string | null; phone: string | null; address: string | null; currency: string;
  valid_until: string | null; notes: string | null; terms: string | null; visit_id: string | null;
};

const opt = (v: unknown, max: number): string | null | false => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return !s ? null : s.length > max ? false : s;
};

/** The customer and terms of a document, checked. Shared with invoices.ts. */
export function readHead(f: QuoteFields & { currency?: unknown }, errors: Errors): Head {
  const email = normalizeEmail(f.email);
  if (!email) errors.email = "Enter the customer's email address.";
  const name = opt(f.name, 200), phone = opt(f.phone, 50), address = opt(f.address, 500);
  if (name === false) errors.name = "Up to 200 characters.";
  if (phone === false) errors.phone = "Up to 50 characters.";
  if (address === false) errors.address = "Up to 500 characters.";
  const currency = currencyCode(f.currency);
  if (!currency) errors.currency = "Enter a currency code like usd.";
  const valid = opt(f.valid_until, 10);
  if (valid !== null && (valid === false || !isDate(valid))) errors.valid_until = "Enter a date like 2026-11-30.";
  const notes = opt(f.notes, 5000), terms = opt(f.terms, 5000);
  if (notes === false) errors.notes = "Up to 5000 characters.";
  if (terms === false) errors.terms = "Up to 5000 characters.";
  const visit = opt(f.visit_id, 18);
  if (visit !== null && (visit === false || !/^\d+$/.test(visit))) errors.visit_id = "Not a job.";
  return {
    email: email ?? "", name: name || null, phone: phone || null, address: address || null, currency: currency ?? "usd",
    valid_until: (valid as string) || null, notes: notes || null, terms: terms || null, visit_id: (visit as string) || null,
  };
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);

async function readQuote(db: Db, f: QuoteFields): Promise<Saved<{ head: Head; lines: Line[] }>> {
  const errors: Errors = {};
  const head = readHead(f, errors);
  const lines = readLines(f.lines, head.currency, await taxRates(db));
  if (!lines.ok) Object.assign(errors, lines.errors);
  return Object.keys(errors).length || !lines.ok ? { ok: false, errors } : { ok: true, value: { head, lines: lines.value } };
}

/** A new draft quote with its lines. Its number is Q- and the id, four digits at least. */
export async function createQuote(db: Db, f: QuoteFields, by: string, source: string): Promise<Saved<Quote>> {
  const r = await readQuote(db, f);
  if (!r.ok) return r;
  const h = r.value.head;
  const out = await db.transaction([
    q`insert into quotes (id, number, email, name, phone, address, currency, valid_until, notes, terms, visit_id, source, created_by, updated_by)
      select n, 'Q-' || lpad(n::text, 4, '0'), ${h.email}, ${h.name}, ${h.phone}, ${h.address}, ${h.currency}, ${h.valid_until}::date,
             ${h.notes}, ${h.terms}, ${h.visit_id}::bigint, ${source}, ${by}, ${by}
      from (select nextval(pg_get_serial_sequence('quotes', 'id')) as n) s`,
    insertLines("quote", null, r.value.lines),
    sumLines("quote", null),
    q`select *, to_char(valid_until, 'YYYY-MM-DD') as valid_day from quotes where id = currval(pg_get_serial_sequence('quotes', 'id'))`,
  ]);
  return { ok: true, value: toQuote(out[3][0]) };
}

/**
 * Replace a draft's customer, terms and lines. A quote that is no longer a
 * draft is refused (errors.status) and nothing changes: copy it instead.
 */
export async function saveQuote(db: Db, id: string, f: QuoteFields, by: string): Promise<Saved<Quote>> {
  if (!/^\d{1,18}$/.test(id)) return { ok: false, errors: { status: "No such quote." } };
  const r = await readQuote(db, f);
  if (!r.ok) return r;
  const h = r.value.head;
  const out = await db.transaction([
    // Lock the quote first, so two saves cannot interleave their lines.
    q`select status, exists (select 1 from invoices i where i.quote_id = quotes.id and i.status <> 'void') as invoiced
      from quotes where id = ${id}::bigint for update`,
    q`update quotes set email = ${h.email}, name = ${h.name}, phone = ${h.phone}, address = ${h.address}, currency = ${h.currency},
        valid_until = ${h.valid_until}::date, notes = ${h.notes}, terms = ${h.terms}, visit_id = ${h.visit_id}::bigint,
        updated_by = ${by}, updated_at = now()
      where id = ${id}::bigint and status = 'draft' and not exists (select 1 from invoices i where i.quote_id = quotes.id and i.status <> 'void')`,
    clearLines("quote", id),
    insertLines("quote", id, r.value.lines),
    sumLines("quote", id),
    q`select *, to_char(valid_until, 'YYYY-MM-DD') as valid_day from quotes where id = ${id}::bigint`,
  ]);
  const before = out[0][0];
  if (!before) return { ok: false, errors: { status: "No such quote." } };
  if (before.status !== "draft") return { ok: false, errors: { status: "This quote was sent, so it no longer changes. Copy it to a new quote." } };
  if (before.invoiced) return { ok: false, errors: { status: "This quote has a Pay button out, so it no longer changes: the customer would pay the old lines. Copy it to a new quote." } };
  return { ok: true, value: toQuote(out[5][0]) };
}

export async function quoteById(db: Db, id: string): Promise<(Quote & { lines: SavedLine[] }) | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [rows, lines] = await Promise.all([
    db.sql`select *, to_char(valid_until, 'YYYY-MM-DD') as valid_day from quotes where id = ${id}::bigint`,
    db.sql`select * from quote_lines where quote_id = ${id}::bigint order by position, id`,
  ]);
  return rows[0] ? { ...toQuote(rows[0]), lines: lines.map(toLine) } : null;
}

/** Quotes for one customer, or for one job, newest first. */
export async function quotesFor(db: Db, by: { email?: string | null; visitId?: string | null }): Promise<Quote[]> {
  const email = by.email ?? null, visit = by.visitId ?? null;
  const rows = await db.sql`
    select *, to_char(valid_until, 'YYYY-MM-DD') as valid_day from quotes
    where (${email}::citext is null or email = ${email}::citext) and (${visit}::bigint is null or visit_id = ${visit}::bigint)
    order by created_at desc, id desc limit 200`;
  return rows.map(toQuote);
}

export type QuoteRow = Quote & { k: string };
export type QuoteFilter = { q: string | null; status: QuoteStatus | null };

/**
 * The quotes list, newest first, keyset paged on (created_at, id). `status`
 * filters by what the list shows, so "expired" includes a draft or sent
 * quote past its date (shownStatus).
 */
export async function quotesPage(db: Db, f: QuoteFilter, after: { k: string; id: string } | null, size: number, today: string): Promise<QuoteRow[]> {
  const pat = likePattern(f.q);
  const k = after?.k ?? null, id = after?.id ?? null;
  const rows = await db.sql`
    select *, to_char(valid_until, 'YYYY-MM-DD') as valid_day, created_at::text as k from quotes
    where (${pat}::text is null or number ilike ${pat} or email::text ilike ${pat} or name ilike ${pat})
      and (${f.status}::text is null
           or (case when status in ('draft', 'sent') and valid_until < ${today}::date then 'expired' else status end) = ${f.status})
      and (${k}::timestamptz is null or (created_at, id) < (${k}::timestamptz, ${id}::bigint))
    order by created_at desc, id desc limit ${size + 1}`;
  return rows.map((r) => ({ ...toQuote(r), k: r.k }));
}

export type Moved = { ok: true; value: Quote } | { ok: false; reason: "not_found" | "status"; status?: QuoteStatus };

/** Move a quote to `to` only from a status in `from`; the check is in the update. */
async function move(db: Db, id: string, to: QuoteStatus, from: QuoteStatus[], by: string): Promise<Moved> {
  if (!/^\d{1,18}$/.test(id)) return { ok: false, reason: "not_found" };
  const decided = to === "accepted" || to === "declined";
  const rows = await db.sql`
    update quotes set status = ${to}, updated_by = ${by}, updated_at = now(),
      sent_at = case when ${to} = 'sent' then now() else sent_at end,
      decided_at = case when ${decided} then now() else decided_at end,
      decided_by = case when ${decided} then ${by}::citext else decided_by end
    where id = ${id}::bigint and status = any(${from}::text[])
    returning *, to_char(valid_until, 'YYYY-MM-DD') as valid_day`;
  if (rows[0]) return { ok: true, value: toQuote(rows[0]) };
  const [now] = await db.sql`select status from quotes where id = ${id}::bigint`;
  return now ? { ok: false, reason: "status", status: now.status } : { ok: false, reason: "not_found" };
}

/** Sent (again): a draft or an already sent quote. sent_at is the latest send. */
export const markSent = (db: Db, id: string, by: string) => move(db, id, "sent", ["draft", "sent"], by);

/** The customer's answer, recorded by a person (or the AI on the owner's word). */
export const decideQuote = (db: Db, id: string, answer: "accepted" | "declined", by: string) =>
  move(db, id, answer, ["draft", "sent", "expired"], by);

export const expireQuote = (db: Db, id: string, by: string) => move(db, id, "expired", ["draft", "sent"], by);

/** Link a quote to the job it is for, once: a quote that already has one keeps it. */
export async function setQuoteVisit(db: Db, id: string, visitId: string, by: string): Promise<boolean> {
  if (!/^\d{1,18}$/.test(id) || !/^\d{1,18}$/.test(visitId)) return false;
  const rows = await db.sql`
    update quotes set visit_id = ${visitId}::bigint, updated_by = ${by}, updated_at = now()
    where id = ${id}::bigint and visit_id is null returning id`;
  return rows.length > 0;
}

/** A new draft with the same customer, terms and lines (valid-until left blank), for a quote that no longer changes. */
export async function copyQuote(db: Db, id: string, by: string, source: string): Promise<Quote | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const rows = await db.sql`
    with n as (select nextval(pg_get_serial_sequence('quotes', 'id')) as n),
    made as (
      insert into quotes (id, number, email, name, phone, address, currency, subtotal_cents, tax_cents, total_cents,
                          notes, terms, visit_id, source, created_by, updated_by)
      select n.n, 'Q-' || lpad(n.n::text, 4, '0'), o.email, o.name, o.phone, o.address, o.currency, o.subtotal_cents, o.tax_cents,
             o.total_cents, o.notes, o.terms, o.visit_id, ${source}, ${by}, ${by}
      from quotes o, n where o.id = ${id}::bigint
      returning *),
    lines as (
      insert into quote_lines (quote_id, position, description, quantity, unit_cents, tax_rate_id, amount_cents, tax_cents)
      select made.id, l.position, l.description, l.quantity, l.unit_cents, l.tax_rate_id, l.amount_cents, l.tax_cents
      from made, quote_lines l where l.quote_id = ${id}::bigint)
    select *, to_char(valid_until, 'YYYY-MM-DD') as valid_day from made`;
  return rows[0] ? toQuote(rows[0]) : null;
}

/** What a list shows: a draft or sent quote past its valid-until date reads as expired. */
export function shownStatus(qt: Pick<Quote, "status" | "valid_until">, today: string): QuoteStatus {
  return (qt.status === "draft" || qt.status === "sent") && qt.valid_until && qt.valid_until < today ? "expired" : qt.status;
}

// Every read selects `*` and valid_until as text (valid_day): pg reads a `date` as local midnight.
export const toQuote = (r: Record<string, any>): Quote => ({
  id: String(r.id),
  number: r.number,
  email: r.email,
  name: r.name ?? null,
  phone: r.phone ?? null,
  address: r.address ?? null,
  status: r.status,
  currency: r.currency,
  subtotal_cents: String(r.subtotal_cents),
  tax_cents: String(r.tax_cents),
  total_cents: String(r.total_cents),
  valid_until: r.valid_day ?? null,
  notes: r.notes ?? null,
  terms: r.terms ?? null,
  sent_at: r.sent_at ? new Date(r.sent_at) : null,
  decided_at: r.decided_at ? new Date(r.decided_at) : null,
  decided_by: r.decided_by ?? null,
  visit_id: r.visit_id ?? null,
  source: r.source ?? null,
  created_by: r.created_by ?? null,
  updated_by: r.updated_by ?? null,
  created_at: new Date(r.created_at),
  updated_at: new Date(r.updated_at),
});
