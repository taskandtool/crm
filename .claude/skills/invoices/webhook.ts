// Stripe's invoice events, on the payments skill's endpoint: the only thing
// that moves an invoice past open.
//
//   app.route("/", stripeWebhook(getDb, { more: [invoiceEvents] }));
//
// The payments webhook checks the signature; this records each event once and
// applies it in the same transaction, behind a lock on the invoice, with every
// status move named by the statuses it may come from:
//
//   invoice.finalized              draft -> open; number, hosted page, PDF
//   invoice.paid                   draft | open | uncollectible -> paid; the payments row; its quote accepted
//   invoice_payment.paid           the payments row, with its payment intent (refunds need it)
//   invoice.payment_failed         noted; the invoice stays open
//   invoice.voided                 draft | open | uncollectible -> void
//   invoice.marked_uncollectible   open -> uncollectible
//   invoice.deleted                draft -> void (a Stripe draft deleted before it was sent)
//
// An invoice is found by its Stripe id, or, before that is stored, by the
// metadata the send set (invoice_id with invoice_key, random per invoice), so
// another project's invoices on the same Stripe account never match. Events
// for invoices that are not this project's are recorded and change nothing.
import { q, type Db } from "../data/db";
import { normalizeEmail } from "../data/email";
import type { EventHandler, StripeEvent } from "../payments/webhook";

type Status = "draft" | "open" | "paid" | "void" | "uncollectible";
type Move = { to: Status; from: Status[] } | null;

const MOVES: Record<string, Move> = {
  "invoice.finalized": { to: "open", from: ["draft"] },
  "invoice.paid": { to: "paid", from: ["draft", "open", "uncollectible"] },
  "invoice.voided": { to: "void", from: ["draft", "open", "uncollectible"] },
  "invoice.marked_uncollectible": { to: "uncollectible", from: ["open"] },
  "invoice.deleted": { to: "void", from: ["draft"] },
  "invoice.payment_failed": null,
  "invoice_payment.paid": null,
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id) : null);
const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
const when = (v: unknown): string | null => (Number.isSafeInteger(v) ? new Date((v as number) * 1000).toISOString() : null);

/** What one event says about its invoice, read from Stripe's object; null for an event this skill does not handle. */
export function planInvoiceEvent(event: StripeEvent) {
  if (!(event.type in MOVES)) return null;
  const o = event.data?.object ?? {};
  const isPayment = event.type === "invoice_payment.paid";
  const meta = (!isPayment && o.metadata) || {};
  const taxes = Array.isArray(o.total_taxes) ? o.total_taxes.reduce((n: number, t: { amount?: unknown }) => n + (int(t?.amount) ?? 0), 0) : int(o.tax);
  // Before 2025's API versions an invoice names its payment intent; since, an invoice_payment does.
  const intent = isPayment
    ? (o.payment?.type === "payment_intent" ? str(o.payment.payment_intent) : null)
    : str(o.payment_intent) ?? str(o.payments?.data?.find((p: any) => p?.payment?.type === "payment_intent")?.payment?.payment_intent);
  return {
    move: MOVES[event.type],
    stripeId: isPayment ? str(o.invoice) : str(o.id),
    invoiceId: typeof meta.invoice_id === "string" && /^\d{1,18}$/.test(meta.invoice_id) ? meta.invoice_id : null,
    key: typeof meta.invoice_key === "string" ? meta.invoice_key : null,
    customer: isPayment ? null : str(o.customer),
    number: isPayment ? null : str(o.number),
    hosted: isPayment ? null : str(o.hosted_invoice_url),
    pdf: isPayment ? null : str(o.invoice_pdf),
    due: isPayment ? null : when(o.due_date),
    livemode: typeof o.livemode === "boolean" ? o.livemode : null,
    subtotal: isPayment ? null : int(o.subtotal),
    tax: isPayment ? null : taxes,
    total: isPayment ? null : int(o.total),
    // A payment: invoice.paid always makes the row (an out-of-band payment has no intent); invoice_payment.paid only when paid.
    pays: event.type === "invoice.paid" || (isPayment && o.status === "paid"),
    amountPaid: int(o.amount_paid),
    paidAt: when(o.status_transitions?.paid_at) ?? when(event.created),
    intent,
    email: isPayment ? null : normalizeEmail(o.customer_email),
    failed: event.type === "invoice.payment_failed",
  };
}

export type InvoiceChange = NonNullable<ReturnType<typeof planInvoiceEvent>>;

/** Record the event and apply it, once, in one transaction. Returns the invoice's id and status after, or nulls. */
export async function applyInvoiceEvent(db: Db, event: StripeEvent, ch: InvoiceChange): Promise<{ fresh: boolean; invoiceId: string | null; status: string | null }> {
  const at = event.created ? new Date(event.created * 1000).toISOString() : new Date().toISOString();
  const to = ch.move?.to ?? null, from = ch.move?.from ?? [];
  const find = q`
    select id from invoices
    where (${ch.stripeId}::text is not null and stripe_invoice_id = ${ch.stripeId}::text)
       or (id = ${ch.invoiceId}::bigint and match_key = ${ch.key}::text and stripe_invoice_id is null)
    order by stripe_invoice_id is null limit 1 for update`;
  const [, [r]] = await db.transaction([
    // The lock: two events for one invoice apply one after the other.
    find,
    q`with target as (
        select id from invoices
        where (${ch.stripeId}::text is not null and stripe_invoice_id = ${ch.stripeId}::text)
           or (id = ${ch.invoiceId}::bigint and match_key = ${ch.key}::text and stripe_invoice_id is null)
        order by stripe_invoice_id is null limit 1),
      ev as (
        insert into stripe_events (id, type) values (${event.id}, ${event.type})
        on conflict (id) do nothing returning id),
      inv as (
        update invoices i set
          status = case when ${to}::text is not null and i.status = any(${from}::text[]) then ${to}::text else i.status end,
          stripe_invoice_id = coalesce(i.stripe_invoice_id, ${ch.stripeId}::text),
          stripe_customer_id = coalesce(i.stripe_customer_id, ${ch.customer}::text),
          number = coalesce(i.number, ${ch.number}::text),
          hosted_url = coalesce(${ch.hosted}::text, i.hosted_url),
          pdf_url = coalesce(${ch.pdf}::text, i.pdf_url),
          due_date = coalesce(i.due_date, (${ch.due}::timestamptz at time zone 'UTC')::date),
          livemode = coalesce(i.livemode, ${ch.livemode}::boolean),
          subtotal_cents = coalesce(${ch.subtotal}::bigint, i.subtotal_cents),
          tax_cents = coalesce(${ch.tax}::bigint, i.tax_cents),
          total_cents = coalesce(${ch.total}::bigint, i.total_cents),
          paid_at = case when ${to}::text = 'paid' and i.status = any(${from}::text[]) then coalesce(i.paid_at, ${ch.paidAt}::timestamptz) else i.paid_at end,
          payment_failed_at = case when ${ch.failed} then greatest(i.payment_failed_at, ${at}::timestamptz) else i.payment_failed_at end,
          updated_at = now()
        from target, ev where i.id = target.id
        returning i.*),
      pay as (
        insert into payments (email, name, amount_cents, total_cents, currency, status, kind, ref_type, ref_id, description,
                              stripe_payment_intent_id, livemode, source, paid_at, match_key)
        select coalesce(inv.email, ${ch.email}::citext), inv.name, coalesce(${ch.amountPaid}::bigint, inv.total_cents),
               coalesce(${ch.amountPaid}::bigint, inv.total_cents), inv.currency, 'paid', 'invoice',
               'invoice', inv.id::text, 'Invoice ' || coalesce(inv.number, inv.id::text), ${ch.intent}::text, inv.livemode, inv.source,
               coalesce(${ch.paidAt}::timestamptz, now()), inv.match_key
        from inv
        where ${ch.pays}
          and not exists (select 1 from payments p where p.ref_type = 'invoice' and p.ref_id = inv.id::text and p.kind = 'invoice')
        on conflict (stripe_payment_intent_id) do nothing
        returning id),
      accepted as (
        -- A proposal paid through its Pay button: the quote is accepted by the payment.
        update quotes qt set status = 'accepted', decided_at = coalesce(qt.decided_at, now()), decided_by = coalesce(qt.decided_by, 'paid online'),
               updated_at = now()
        from inv
        where ${ch.move?.to === "paid"} and inv.status = 'paid' and qt.id = inv.quote_id and qt.status in ('draft', 'sent', 'expired')
        returning qt.id),
      fill as (
        update payments p set stripe_payment_intent_id = ${ch.intent}::text, updated_at = now()
        from inv
        where ${ch.intent}::text is not null and p.ref_type = 'invoice' and p.ref_id = inv.id::text and p.kind = 'invoice'
          and p.stripe_payment_intent_id is null
          and not exists (select 1 from payments x where x.stripe_payment_intent_id = ${ch.intent}::text)
        returning p.id)
      select exists (select 1 from ev) as fresh, (select id::text from inv) as invoice_id, (select status from inv) as status,
             (select count(*) from pay) + (select count(*) from fill) as payments`,
  ]);
  return { fresh: r.fresh, invoiceId: r.invoice_id, status: r.status };
}

/** For the payments webhook's `more`. */
export const invoiceEvents: EventHandler = {
  handles: (event) => event.type in MOVES,
  apply: async (db, event) => {
    const ch = planInvoiceEvent(event);
    if (ch) await applyInvoiceEvent(db, event, ch);
  },
};
