// Invoices: a draft here, then Stripe's. A draft is ours to edit until it is
// sent with Stripe (stripe.ts); from then on its status is Stripe's, moved only
// by the verified webhook and never backwards:
//
//   draft -> open -> paid | void | uncollectible
//   uncollectible -> paid | void                (Stripe allows both)
//   draft -> void                               (a draft never sent: discarded here)
//
// Nothing is deleted.
//
//   const r = await createInvoice(db, { email, currency: "usd", lines: [...] }, by, "crm");
//   const inv = await invoiceFromQuote(db, quoteId, by, "crm");   // an accepted quote's lines
//   const dep = await invoiceFromQuote(db, quoteId, by, "crm", 30, { share: { kind: "percent", percent: 50 } });
import { likePattern } from "../admin/query";
import { q, type Db } from "../data/db";
import { taxRates } from "../payments/tax";
import { clearLines, insertLines, keptRates, readLines, sumLines, toLine, type Errors, type Line, type Saved, type SavedLine } from "./lines";
import { readHead } from "./quotes";

export const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Written off",
};

export type Invoice = {
  id: string;
  quote_id: string | null;
  visit_id: string | null;
  email: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  status: InvoiceStatus;
  currency: string;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  days_until_due: number;
  due_date: string | null;
  notes: string | null;
  stripe_invoice_id: string | null;
  stripe_customer_id: string | null;
  number: string | null;
  hosted_url: string | null;
  pdf_url: string | null;
  livemode: boolean | null;
  match_key: string;
  sent_at: Date | null;
  paid_at: Date | null;
  payment_failed_at: Date | null;
  source: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type InvoiceFields = {
  email?: unknown;
  name?: unknown;
  phone?: unknown;
  address?: unknown;
  currency?: unknown;
  days_until_due?: unknown;
  notes?: unknown;
  visit_id?: unknown;
  lines?: unknown;
};

async function readInvoice(db: Db, f: InvoiceFields, id?: string) {
  const errors: Errors = {};
  const head = readHead({ ...f, valid_until: null, terms: null }, errors);
  const raw = typeof f.days_until_due === "string" ? f.days_until_due.trim() : f.days_until_due == null ? "" : String(f.days_until_due);
  const days = raw === "" ? 30 : Number(raw);
  if (!/^\d{1,3}$/.test(raw || "30") || days > 365) errors.days_until_due = "Enter the days to pay, 0 to 365.";
  const lines = readLines(f.lines, head.currency, await taxRates(db), id ? await keptRates(db, "invoice", id) : []);
  if (!lines.ok) Object.assign(errors, lines.errors);
  return Object.keys(errors).length || !lines.ok
    ? ({ ok: false, errors } as const)
    : ({ ok: true, value: { head, days, lines: lines.value as Line[] } } as const);
}

/** A new draft invoice with its lines (blank, or an appointment's: pass its visit_id and the lines). */
export async function createInvoice(db: Db, f: InvoiceFields, by: string, source: string): Promise<Saved<Invoice>> {
  const r = await readInvoice(db, f);
  if (!r.ok) return r;
  const { head: h, days } = r.value;
  const out = await db.transaction([
    q`insert into invoices (email, name, phone, address, currency, days_until_due, notes, visit_id, source, created_by, updated_by)
      values (${h.email}, ${h.name}, ${h.phone}, ${h.address}, ${h.currency}, ${days}, ${h.notes}, ${h.visit_id}::bigint, ${source}, ${by}, ${by})`,
    insertLines("invoice", null, r.value.lines),
    sumLines("invoice", null),
    q`select *, to_char(due_date, 'YYYY-MM-DD') as due_day from invoices where id = currval(pg_get_serial_sequence('invoices', 'id'))`,
  ]);
  return { ok: true, value: toInvoice(out[3][0]) };
}

/** Replace a draft's customer, terms and lines; refused (errors.status) once it went to Stripe. */
export async function saveInvoice(db: Db, id: string, f: InvoiceFields, by: string): Promise<Saved<Invoice>> {
  if (!/^\d{1,18}$/.test(id)) return { ok: false, errors: { status: "No such invoice." } };
  const r = await readInvoice(db, f, id);
  if (!r.ok) return r;
  const { head: h, days } = r.value;
  const out = await db.transaction([
    q`select status, stripe_invoice_id from invoices where id = ${id}::bigint for update`,
    q`update invoices set email = ${h.email}, name = ${h.name}, phone = ${h.phone}, address = ${h.address}, currency = ${h.currency},
        days_until_due = ${days}, notes = ${h.notes}, visit_id = ${h.visit_id}::bigint, updated_by = ${by}, updated_at = now()
      where id = ${id}::bigint and status = 'draft' and stripe_invoice_id is null`,
    clearLines("invoice", id),
    insertLines("invoice", id, r.value.lines),
    sumLines("invoice", id),
    q`select *, to_char(due_date, 'YYYY-MM-DD') as due_day from invoices where id = ${id}::bigint`,
  ]);
  const before = out[0][0];
  if (!before) return { ok: false, errors: { status: "No such invoice." } };
  if (before.status !== "draft" || before.stripe_invoice_id) return { ok: false, errors: { status: "This invoice went to Stripe, so it no longer changes here." } };
  return { ok: true, value: toInvoice(out[5][0]) };
}

export type FromQuote = { ok: true; value: Invoice } | { ok: false; reason: "not_found" | "not_accepted" | "invoiced" | "nothing_left"; invoiceId?: string };

/** How much of a quote an invoice bills: all its lines, a share of it (a deposit), or what no invoice has billed yet. */
export type Share = { kind: "all" } | { kind: "percent"; percent: number } | { kind: "rest" };

/**
 * A draft invoice from an accepted quote, in one transaction behind a lock
 * on the quote. Invoices belong to the customer, so a quote makes as many as
 * asked; `seen`, the invoices (not void) the asking page showed for the
 * quote, keeps a second click from making a second one: it then answers
 * `invoiced` with the newest.
 *
 * - `all` (the default): its customer, appointment, lines and totals.
 * - `percent`: one line per tax rate the quote uses, "Deposit (50%) for
 *   Q-0012", carrying the same share of each rate's lines, so the tax is the
 *   same share too.
 * - `rest`: what the quote's invoices (not void) have not billed yet, per tax
 *   rate, "Balance for Q-0012"; all its lines when none has.
 */
export async function invoiceFromQuote(db: Db, quoteId: string, by: string, source: string, days = 30, opts: { share?: Share; seen?: number } = {}): Promise<FromQuote> {
  if (!/^\d{1,18}$/.test(quoteId)) return { ok: false, reason: "not_found" };
  const share = opts.share ?? { kind: "all" };
  const pct = share.kind === "percent" ? Math.round(share.percent) : null;
  if (pct !== null && !(pct >= 1 && pct <= 100)) throw new Error(`a deposit is 1 to 100 percent, not ${share.kind === "percent" ? share.percent : ""}`);
  const seen = opts.seen ?? null;
  const out = await db.transaction([
    // Lock the quote: two clicks wait for each other, and the second sees the first's invoice.
    q`select status from quotes where id = ${quoteId}::bigint for update`,
    q`with qt as (
        select * from quotes
        where id = ${quoteId}::bigint and status = 'accepted'
          and (${seen}::int is null or (select count(*) from invoices i where i.quote_id = quotes.id and i.status <> 'void') = ${seen}::int)),
      billed as (
        select l.tax_rate_id, sum(l.amount_cents) as amount from invoice_lines l join invoices i on i.id = l.invoice_id
        where i.quote_id = ${quoteId}::bigint and i.status <> 'void' group by l.tax_rate_id),
      groups as (
        select l.tax_rate_id, sum(l.amount_cents) as amount, min(l.position) as first
        from quote_lines l where l.quote_id = ${quoteId}::bigint group by l.tax_rate_id),
      -- A share of each rate's lines: the deposit's percent, or what is left to bill.
      shares as (
        select g.tax_rate_id, g.first,
               case when ${pct}::int is not null then round(g.amount * ${pct}::int / 100.0)::bigint
                    else g.amount - coalesce(b.amount, 0) end as amount
        from groups g left join billed b on b.tax_rate_id is not distinct from g.tax_rate_id),
      whole as (select ${share.kind}::text = 'all' or (${share.kind}::text = 'rest' and not exists (select 1 from billed)) as yes),
      made as (
        insert into invoices (quote_id, visit_id, email, name, phone, address, currency, days_until_due, notes, source, created_by, updated_by)
        select qt.id, qt.visit_id, qt.email, qt.name, qt.phone, qt.address, qt.currency, ${days}, qt.notes, ${source}, ${by}, ${by}
        from qt, whole
        where whole.yes or exists (select 1 from shares where amount > 0)
        returning *),
      copied as (
        insert into invoice_lines (invoice_id, position, description, quantity, unit_cents, tax_rate_id, amount_cents, tax_cents)
        select made.id, l.position, l.description, l.quantity, l.unit_cents, l.tax_rate_id, l.amount_cents, l.tax_cents
        from made, whole, quote_lines l where whole.yes and l.quote_id = ${quoteId}::bigint
        returning id),
      parts as (
        insert into invoice_lines (invoice_id, position, description, quantity, unit_cents, tax_rate_id, amount_cents, tax_cents)
        select made.id, row_number() over (order by s.first),
               case when ${pct}::int is not null then 'Deposit (' || ${pct}::int || '%) for ' else 'Balance for ' end || qt.number
                 || case when (select count(*) from groups) > 1 then coalesce(' (' || t.name || ')', ' (no tax)') else '' end,
               1, s.amount, s.tax_rate_id, s.amount,
               coalesce(case when t.inclusive then s.amount - round(s.amount * 10000.0 / (10000 + t.percent_bp))
                             else round(s.amount * t.percent_bp / 10000.0) end, 0)::bigint
        from made, whole, qt, shares s left join tax_rates t on t.id = s.tax_rate_id
        where not whole.yes and s.amount > 0
        returning id)
      select made.id::text as id, (select count(*) from copied) + (select count(*) from parts) as lines from made`,
    // Its totals from its lines, as sumLines does; the invoice made in this transaction is the one created now().
    q`update invoices set subtotal_cents = s.subtotal, tax_cents = s.tax, total_cents = s.subtotal + s.exclusive, updated_at = now()
      from (select l.invoice_id, coalesce(sum(l.amount_cents), 0) as subtotal, coalesce(sum(l.tax_cents), 0) as tax,
                   coalesce(sum(l.tax_cents) filter (where not coalesce(t.inclusive, false)), 0) as exclusive
            from invoice_lines l left join tax_rates t on t.id = l.tax_rate_id group by l.invoice_id) s
      where invoices.quote_id = ${quoteId}::bigint and invoices.created_at = now() and invoices.status = 'draft' and s.invoice_id = invoices.id
      returning invoices.*, to_char(invoices.due_date, 'YYYY-MM-DD') as due_day`,
    // After the insert, so it sees an invoice another request made while this one waited for the lock.
    q`select max(id)::text as id, count(*)::int as n from invoices where quote_id = ${quoteId}::bigint and status <> 'void'`,
  ]);
  if (!out[0][0]) return { ok: false, reason: "not_found" };
  if (out[2][0]) return { ok: true, value: toInvoice(out[2][0]) };
  if (out[0][0].status !== "accepted") return { ok: false, reason: "not_accepted" };
  const now = out[3][0];
  if (seen !== null && now.n !== seen) return { ok: false, reason: "invoiced", invoiceId: now.id };
  return { ok: false, reason: "nothing_left" };
}

/** Discard a draft that never went to Stripe: it turns void and stays on record. */
export async function discardInvoice(db: Db, id: string, by: string): Promise<boolean> {
  if (!/^\d{1,18}$/.test(id)) return false;
  const rows = await db.sql`
    update invoices set status = 'void', updated_by = ${by}, updated_at = now()
    where id = ${id}::bigint and status = 'draft' and stripe_invoice_id is null returning id`;
  return rows.length > 0;
}

export async function invoiceById(db: Db, id: string): Promise<(Invoice & { lines: SavedLine[] }) | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [rows, lines] = await Promise.all([
    db.sql`select *, to_char(due_date, 'YYYY-MM-DD') as due_day from invoices where id = ${id}::bigint`,
    db.sql`select * from invoice_lines where invoice_id = ${id}::bigint order by position, id`,
  ]);
  return rows[0] ? { ...toInvoice(rows[0]), lines: lines.map(toLine) } : null;
}

/** Past due as the invoices list counts it: open, its due day gone, and its quote (if any) accepted. */
export const pastDue = (inv: Invoice, today: string, quote: { status: string } | null): boolean =>
  inv.status === "open" && !!inv.due_date && inv.due_date < today && (!inv.quote_id || quote?.status === "accepted");

/** Invoices for one customer, one appointment or one quote, newest first. */
export async function invoicesFor(db: Db, by: { email?: string | null; visitId?: string | null; quoteId?: string | null }): Promise<Invoice[]> {
  const email = by.email ?? null, visit = by.visitId ?? null, quote = by.quoteId ?? null;
  const rows = await db.sql`
    select *, to_char(due_date, 'YYYY-MM-DD') as due_day from invoices
    where (${email}::citext is null or email = ${email}::citext)
      and (${visit}::bigint is null or visit_id = ${visit}::bigint)
      and (${quote}::bigint is null or quote_id = ${quote}::bigint)
    order by created_at desc, id desc limit 200`;
  return rows.map(toInvoice);
}

export type InvoiceRow = Invoice & { k: string; past_due: boolean };
export type InvoiceFilter = { q: string | null; status: InvoiceStatus | null; due: boolean };

/** The invoices list, newest first, keyset paged on (created_at, id). `due` is open and past its due date. */
export async function invoicesPage(db: Db, f: InvoiceFilter, after: { k: string; id: string } | null, size: number, today: string): Promise<InvoiceRow[]> {
  const pat = likePattern(f.q);
  const k = after?.k ?? null, id = after?.id ?? null;
  const rows = await db.sql`
    select * from (
      select *, to_char(due_date, 'YYYY-MM-DD') as due_day, created_at::text as k,
             (status = 'open' and due_date < ${today}::date
              and (quote_id is null or exists (select 1 from quotes q where q.id = invoices.quote_id and q.status = 'accepted'))) as past_due
      from invoices
      where (${pat}::text is null or number ilike ${pat} or email::text ilike ${pat} or name ilike ${pat})
        and (${f.status}::text is null or status = ${f.status})
        and (${k}::timestamptz is null or (created_at, id) < (${k}::timestamptz, ${id}::bigint))) i
    where not ${f.due} or past_due
    order by created_at desc, id desc limit ${size + 1}`;
  return rows.map((r) => ({ ...toInvoice(r), k: r.k, past_due: r.past_due === true }));
}

/**
 * What a customer owes now: what is left on open invoices (the total, less a
 * part paid by hand), live mode only, one total per currency.
 */
export async function owed(db: Db, email: string): Promise<{ currency: string; cents: string; count: number }[]> {
  const rows = await db.sql`
    select currency, sum(total_cents - coalesce((select sum(coalesce(p.total_cents, p.amount_cents)) from payments p
             where p.ref_type = 'invoice' and p.ref_id = invoices.id::text and p.status in ('paid', 'refunded', 'partially_refunded')), 0))::text as cents,
           count(*)::int as count from invoices
    where email = ${email}::citext and status = 'open' and livemode is true
      -- A quote's invoice is owed once its quote is accepted.
      and (quote_id is null or exists (select 1 from quotes q where q.id = invoices.quote_id and q.status = 'accepted'))
    group by currency order by currency`;
  return rows.map((r) => ({ currency: r.currency, cents: r.cents, count: Number(r.count) }));
}

/**
 * The money at a glance, in one currency, live mode only: what is owed
 * (what is left on open ones), the part of it past due, and what was paid on
 * invoices this calendar month in `timeZone`. A quote's invoice is owed once
 * its quote is accepted.
 */
export async function invoiceTotals(db: Db, opts: { today: string; timeZone: string; currency: string }) {
  const [r] = await db.sql`
    with owed as (
      -- What is left on each: the total, less a part paid by hand.
      select total_cents - coalesce((select sum(coalesce(p.total_cents, p.amount_cents)) from payments p
               where p.ref_type = 'invoice' and p.ref_id = invoices.id::text and p.status in ('paid', 'refunded', 'partially_refunded')), 0) as total_cents,
             due_date from invoices
      where status = 'open' and livemode is true and currency = ${opts.currency}
        and (quote_id is null or exists (select 1 from quotes q where q.id = invoices.quote_id and q.status = 'accepted')))
    select
      (select coalesce(sum(total_cents), 0)::text from owed) as open_cents,
      (select count(*)::int from owed) as open_count,
      (select coalesce(sum(total_cents), 0)::text from owed where due_date < ${opts.today}::date) as due_cents,
      (select count(*)::int from owed where due_date < ${opts.today}::date) as due_count,
      -- Every payment on an invoice this month, online or by hand, part or all.
      (select coalesce(sum(coalesce(p.total_cents, p.amount_cents)), 0)::text from payments p
        where p.ref_type = 'invoice' and p.status in ('paid', 'refunded', 'partially_refunded') and p.livemode is true and p.currency = ${opts.currency}
          and p.paid_at >= (date_trunc('month', ${opts.today}::date)::timestamp at time zone ${opts.timeZone})) as paid_cents`;
  return {
    open: { cents: r.open_cents as string, count: Number(r.open_count) },
    due: { cents: r.due_cents as string, count: Number(r.due_count) },
    paid: { cents: r.paid_cents as string },
  };
}

// Every read selects `*` and due_date as text (due_day): pg reads a `date` as local midnight.
export const toInvoice = (r: Record<string, any>): Invoice => ({
  id: String(r.id),
  quote_id: r.quote_id == null ? null : String(r.quote_id),
  visit_id: r.visit_id == null ? null : String(r.visit_id),
  email: r.email,
  name: r.name ?? null,
  phone: r.phone ?? null,
  address: r.address ?? null,
  status: r.status,
  currency: r.currency,
  subtotal_cents: String(r.subtotal_cents),
  tax_cents: String(r.tax_cents),
  total_cents: String(r.total_cents),
  days_until_due: Number(r.days_until_due),
  due_date: r.due_day ?? null,
  notes: r.notes ?? null,
  stripe_invoice_id: r.stripe_invoice_id ?? null,
  stripe_customer_id: r.stripe_customer_id ?? null,
  number: r.number ?? null,
  hosted_url: r.hosted_url ?? null,
  pdf_url: r.pdf_url ?? null,
  livemode: r.livemode ?? null,
  match_key: r.match_key,
  sent_at: r.sent_at ? new Date(r.sent_at) : null,
  paid_at: r.paid_at ? new Date(r.paid_at) : null,
  payment_failed_at: r.payment_failed_at ? new Date(r.payment_failed_at) : null,
  source: r.source ?? null,
  created_by: r.created_by ?? null,
  updated_by: r.updated_by ?? null,
  created_at: new Date(r.created_at),
  updated_at: new Date(r.updated_at),
});
