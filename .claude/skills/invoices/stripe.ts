// An invoice in the owner's Stripe account: made, finalized and emailed by
// Stripe, paid on Stripe's hosted page. Every call goes through
// payments/stripe.ts (the gateway in dev, the bound key in production) with
// an Idempotency-Key from the invoice's random match_key, so a retry never
// makes a second invoice or a second line.
//
//   const r = await sendInvoice(db, stripeFrom(envOf(c)), id, user);
//   await markPaidOutOfBand(db, stripe, id);   // cash or a check; `paid` arrives by the webhook
//
// The owner asking for it in chat (or saying yes to its preview), or a
// team member's click, sends, voids or marks paid. Past draft, the status here changes only from the webhook
// (webhook.ts): these calls ask Stripe and wait for its event.
import type { Db } from "../data/db";
import { StripeError, type Stripe } from "../payments/stripe";
import { formatMoney } from "../payments/money";
import { stripeTaxRate, taxRates } from "../payments/tax";
import { discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, toInvoice, type Invoice } from "./invoices";

export type StripeResult = { ok: true; invoice: Invoice } | { ok: false; reason: "not_found" | "status" | "empty" | "stripe"; message: string };

const fail = (reason: "not_found" | "status" | "empty" | "stripe", message: string): StripeResult => ({ ok: false, reason, message });

/**
 * Send a draft with Stripe: find or make the customer, make the tax rates its
 * lines use, make the invoice and its items, finalize it, and have Stripe
 * email it. Each step can be repeated: a failed send is sent again by asking
 * again. The number, the hosted page and the PDF are stored from Stripe's
 * answer, and the invoice is open.
 */
export async function sendInvoice(db: Db, stripe: Stripe, id: string, by: string, opts: { email?: boolean } = {}): Promise<StripeResult> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  // An open one not yet emailed: a send that stopped after Stripe finalized it.
  if (inv.status !== "draft" && !(inv.status === "open" && !inv.sent_at)) return fail("status", `This invoice is ${inv.status}; only a draft is sent.`);
  if (!inv.lines.length || Number(inv.total_cents) <= 0) return fail("empty", "An invoice needs lines that come to more than zero.");
  const key = inv.match_key;
  try {
    const { livemode } = await stripe<{ livemode: boolean }>("GET", "/v1/balance");

    // The customer, one per email per mode, made once.
    let [cus] = await db.sql<{ stripe_customer_id: string }>`
      select stripe_customer_id from stripe_customers where email = ${inv.email}::citext and livemode = ${livemode}`;
    if (!cus) {
      const made = await stripe<{ id: string }>("POST", "/v1/customers", {
        email: inv.email, name: inv.name ?? undefined, phone: inv.phone ?? undefined, metadata: { source: "taskandtool" },
      }, { idempotencyKey: `customer-${key}` });
      await db.sql`insert into stripe_customers (email, livemode, stripe_customer_id) values (${inv.email}, ${livemode}, ${made.id}) on conflict do nothing`;
      [cus] = await db.sql<{ stripe_customer_id: string }>`
        select stripe_customer_id from stripe_customers where email = ${inv.email}::citext and livemode = ${livemode}`;
    }
    const customer = cus.stripe_customer_id;

    // Each tax rate the lines use, in this mode.
    const used = new Set(inv.lines.map((l) => l.tax_rate_id).filter((x): x is string => !!x));
    const stripeRate = new Map<string, string>();
    for (const rate of (await taxRates(db)).filter((r) => used.has(r.id))) stripeRate.set(rate.id, await stripeTaxRate(db, stripe, rate, livemode));

    // The invoice, its id stored at once: from here the draft no longer changes.
    let sid = inv.stripe_invoice_id;
    if (!sid) {
      const made = await stripe<{ id: string }>("POST", "/v1/invoices", {
        customer, currency: inv.currency, collection_method: "send_invoice", days_until_due: inv.days_until_due, auto_advance: false,
        pending_invoice_items_behavior: "exclude", description: inv.notes ?? undefined,
        metadata: { invoice_id: inv.id, invoice_key: key },
      }, { idempotencyKey: `invoice-${key}` });
      const [stored] = await db.sql<{ stripe_invoice_id: string }>`
        update invoices set stripe_invoice_id = coalesce(stripe_invoice_id, ${made.id}), stripe_customer_id = ${customer},
               livemode = ${livemode}, updated_by = ${by}, updated_at = now()
        where id = ${inv.id}::bigint and status in ('draft', 'open') returning stripe_invoice_id`;
      if (!stored) return fail("status", "This invoice changed while it was being sent. Look at it again.");
      sid = stored.stripe_invoice_id;
    }

    // Its lines, unless they are already there; then the subtotal must be ours, or nothing is finalized.
    let si = await stripe<StripeInvoice>("GET", `/v1/invoices/${sid}`);
    if (si.status === "draft" && si.subtotal !== Number(inv.subtotal_cents)) {
      for (const l of inv.lines) {
        const each = l.quantity === "1" ? "" : ` (${l.quantity} x ${formatMoney(l.unit_cents, inv.currency)})`;
        await stripe("POST", "/v1/invoiceitems", {
          customer, invoice: sid, currency: inv.currency, amount: Number(l.amount_cents), description: (l.description + each).slice(0, 500),
          tax_rates: l.tax_rate_id ? [stripeRate.get(l.tax_rate_id)!] : undefined,
        }, { idempotencyKey: `item-${key}-${l.position}` });
      }
      si = await stripe<StripeInvoice>("GET", `/v1/invoices/${sid}`);
      if (si.subtotal !== Number(inv.subtotal_cents)) {
        return fail("stripe", `The invoice in Stripe comes to ${formatMoney(si.subtotal, inv.currency)} before tax, not ${formatMoney(inv.subtotal_cents, inv.currency)}. Nothing was sent; delete the draft in Stripe and send again.`);
      }
    }
    if (si.status === "draft") si = await stripe<StripeInvoice>("POST", `/v1/invoices/${sid}/finalize`, { auto_advance: false }, { idempotencyKey: `finalize-${key}` });
    // A proposal's Pay button carries the page itself, so Stripe emails nothing (email: false).
    if (si.status === "open" && !inv.sent_at && opts.email !== false) si = await stripe<StripeInvoice>("POST", `/v1/invoices/${sid}/send`, {}, { idempotencyKey: `send-${key}` });

    const taxes = Array.isArray(si.total_taxes) ? si.total_taxes.reduce((n, t) => n + (t.amount ?? 0), 0) : null;
    const [row] = await db.sql`
      update invoices set
        status = case when status = 'draft' and ${si.status} = 'open' then 'open' else status end,
        number = coalesce(number, ${si.number ?? null}::text),
        hosted_url = coalesce(${si.hosted_invoice_url ?? null}::text, hosted_url),
        pdf_url = coalesce(${si.invoice_pdf ?? null}::text, pdf_url),
        due_date = coalesce(due_date, (${si.due_date ? new Date(si.due_date * 1000).toISOString() : null}::timestamptz at time zone 'UTC')::date),
        subtotal_cents = ${si.subtotal}, total_cents = ${si.total}, tax_cents = coalesce(${taxes}::bigint, tax_cents),
        sent_at = coalesce(sent_at, now()), updated_by = ${by}, updated_at = now()
      where id = ${inv.id}::bigint
      returning *, to_char(due_date, 'YYYY-MM-DD') as due_day`;
    return { ok: true, invoice: toInvoice(row) };
  } catch (e) {
    if (e instanceof StripeError) return fail("stripe", e.message);
    throw e;
  }
}

type StripeInvoice = {
  id: string; status: string; number?: string | null; hosted_invoice_url?: string | null; invoice_pdf?: string | null;
  due_date?: number | null; subtotal: number; total: number; total_taxes?: { amount?: number }[];
};

/**
 * A proposal's Pay button: the quote's invoice, made from its lines once and
 * finalized in Stripe without Stripe's own email, and the page that pays it.
 * Paying it accepts the quote (webhook.ts). Made when the owner asks, as sending.
 */
export async function payLinkForQuote(db: Db, stripe: Stripe, quoteId: string, by: string, source: string, days = 30): Promise<{ ok: true; url: string; invoice: Invoice } | { ok: false; message: string }> {
  const made = await invoiceFromQuote(db, quoteId, by, source, days, { beforeAnswer: true });
  const id = made.ok ? made.value.id : made.reason === "invoiced" ? made.invoiceId! : null;
  if (!id) return { ok: false, message: made.ok ? "" : made.reason === "not_found" ? "No such quote." : "Only a quote still waiting for its answer, or accepted, gets a Pay button." };
  const existing = await invoiceById(db, id);
  if (existing?.hosted_url && existing.status === "open") return { ok: true, url: existing.hosted_url, invoice: existing };
  const r = await sendInvoice(db, stripe, id, by, { email: false });
  if (!r.ok) return { ok: false, message: r.message };
  return r.invoice.hosted_url ? { ok: true, url: r.invoice.hosted_url, invoice: r.invoice } : { ok: false, message: "Stripe gave no payment page for the invoice." };
}

/**
 * A declined quote's Pay button stops working: its invoice is voided in
 * Stripe, or discarded when it never got there. Says what happened, for the
 * page or the script to show. `stripe` is called only when there is one to void.
 */
export async function closePayLink(db: Db, stripe: () => Stripe, quoteId: string, by: string): Promise<string | null> {
  const open = (await invoicesFor(db, { quoteId })).filter((i) => i.status === "draft" || i.status === "open");
  for (const inv of open) {
    if (!inv.stripe_invoice_id) {
      await discardInvoice(db, inv.id, by);
      continue;
    }
    const r = await voidInvoice(db, stripe(), inv.id);
    if (!r.ok) return `Its Pay button could not be voided in Stripe: ${r.message}. Void invoice ${inv.number ?? inv.id} there.`;
  }
  return open.length ? "Its Pay button is voided in Stripe." : null;
}

/** Ask Stripe for a change to a sent invoice; the status here follows when Stripe's event arrives. */
async function ask(db: Db, stripe: Stripe, id: string, allowed: Invoice["status"][], path: (sid: string) => string, keyPrefix: string): Promise<StripeResult> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  if (!inv.stripe_invoice_id) return fail("status", "This invoice was never sent with Stripe.");
  if (!allowed.includes(inv.status)) return fail("status", `This invoice is ${inv.status}.`);
  try {
    await stripe("POST", path(inv.stripe_invoice_id), keyPrefix === "pay" ? { paid_out_of_band: true } : {}, { idempotencyKey: `${keyPrefix}-${inv.match_key}` });
    return { ok: true, invoice: inv };
  } catch (e) {
    if (e instanceof StripeError) return fail("stripe", e.message);
    throw e;
  }
}

/** Paid in cash or by check: Stripe records it, and its invoice.paid marks the invoice paid here. */
export const markPaidOutOfBand = (db: Db, stripe: Stripe, id: string) =>
  ask(db, stripe, id, ["open", "uncollectible"], (sid) => `/v1/invoices/${sid}/pay`, "pay");

/** Void a sent invoice; its invoice.voided marks it void here. Never deleted. */
export const voidInvoice = (db: Db, stripe: Stripe, id: string) =>
  ask(db, stripe, id, ["open", "uncollectible"], (sid) => `/v1/invoices/${sid}/void`, "void");

/** Written off; its invoice.marked_uncollectible marks it here. It can still be paid or voided. */
export const markUncollectible = (db: Db, stripe: Stripe, id: string) =>
  ask(db, stripe, id, ["open"], (sid) => `/v1/invoices/${sid}/mark_uncollectible`, "uncollectible");
