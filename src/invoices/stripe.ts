// An invoice in the owner's Stripe account: made, finalized and emailed by
// Stripe, paid on Stripe's hosted page. Every call goes through
// payments/stripe.ts (the gateway in dev, the bound key in production) with
// an Idempotency-Key from the invoice's random match_key, so a retry never
// makes a second invoice or a second line.
//
//   const r = await sendInvoice(db, stripeFrom(envOf(c)), id, user, { timeZone });
//   const r = await sendInvoice(db, stripe, id, user, { collect: "charge", timeZone });   // the card on file
//   await emailPaymentPage(db, stripe, id);                                                // a charge that failed: they pay it themselves
//   await recordPayment(db, stripe, id, { amountCents: 4000, method: "Check", paidOn: "2026-10-15", reference: "101", key, today }, user);
//
// The owner asking for it in chat (or saying yes to its preview), or a
// team member's click, sends, voids or marks paid. Past draft, the status here changes only from the webhook
// (webhook.ts): these calls ask Stripe and wait for its event.
import type { Db } from "../data/db";
import type { Email, Sent } from "../data/send";
import { StripeError, type Stripe } from "../payments/stripe";
import { formatMoney } from "../payments/money";
import { stripeTaxRate, taxRates } from "../payments/tax";
import { chargeCard, cardName } from "./cards";
import { addDays, todayIn } from "./document";
import { invoiceById, toInvoice, type Invoice } from "./invoices";

/** `no_card`: Charge with no card on file. `declined`: the card was refused. `action`: the customer must confirm the charge (3D Secure). */
type Reason = "not_found" | "status" | "empty" | "amount" | "stripe" | "no_card" | "declined" | "action";
export type StripeResult = { ok: true; invoice: Invoice } | { ok: false; reason: Reason; message: string };

const fail = (reason: Reason, message: string): StripeResult => ({ ok: false, reason, message });

export type SendOptions = {
  /** Email it to be paid (the default), or charge the card on file. A send that stopped part way finishes as it began. */
  collect?: "email" | "charge";
  /** The business's zone: the due date is counted from the day it is sent there, not at UTC. */
  timeZone?: string;
};

/**
 * Send a draft with Stripe: find or make the customer, make the tax rates its
 * lines use, make the invoice and its items, finalize it, and have Stripe
 * email it, or charge the customer's card on file (`collect: "charge"`).
 * Each step can be repeated: a failed send is sent again by asking again.
 * The number, the hosted page and the PDF are stored from Stripe's answer,
 * and the invoice is open; paid arrives only from the webhook. A charge
 * refused (`declined`, or `action` when the customer must confirm it) leaves
 * it open with `payment_failed_at`, and its hosted page still takes payment.
 */
export async function sendInvoice(db: Db, stripe: Stripe, id: string, by: string, opts: SendOptions = {}): Promise<StripeResult> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  // An open one not yet sent: a send that stopped after Stripe finalized it.
  if (inv.status !== "draft" && !(inv.status === "open" && !inv.sent_at)) return fail("status", `This invoice is ${inv.status}; only a draft is sent.`);
  if (!inv.lines.length || Number(inv.total_cents) <= 0) return fail("empty", "An invoice needs lines that come to more than zero.");
  const key = inv.match_key;
  // How it is collected is fixed once it is in Stripe.
  const collect = inv.stripe_invoice_id ? inv.collect : (opts.collect ?? "email");
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

    // The card, read fresh from Stripe: nothing is made in Stripe for a charge with none.
    const card = collect === "charge" ? await chargeCard(db, stripe, inv.email, livemode) : null;
    if (collect === "charge" && !card) return fail("no_card", `${inv.name ?? inv.email} has no card on file. A card is saved when they pay an invoice on Stripe's page.`);

    // Each tax rate the lines use, in this mode.
    const used = new Set(inv.lines.map((l) => l.tax_rate_id).filter((x): x is string => !!x));
    const stripeRate = new Map<string, string>();
    for (const rate of (await taxRates(db)).filter((r) => used.has(r.id))) stripeRate.set(rate.id, await stripeTaxRate(db, stripe, rate, livemode));

    // The invoice, its id stored at once: from here the draft no longer changes.
    let sid = inv.stripe_invoice_id;
    if (!sid) {
      const made = await stripe<{ id: string }>("POST", "/v1/invoices", {
        customer, currency: inv.currency, auto_advance: false,
        ...(collect === "charge" ? { collection_method: "charge_automatically" } : { collection_method: "send_invoice", days_until_due: inv.days_until_due }),
        pending_invoice_items_behavior: "exclude", description: inv.notes ?? undefined,
        metadata: { invoice_id: inv.id, invoice_key: key },
      }, { idempotencyKey: `invoice-${key}` });
      const [stored] = await db.sql<{ stripe_invoice_id: string }>`
        update invoices set stripe_invoice_id = coalesce(stripe_invoice_id, ${made.id}), stripe_customer_id = ${customer},
               livemode = ${livemode}, collect = ${collect}, updated_by = ${by}, updated_at = now()
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
    // A charged one keeps Stripe's own retries (auto_advance), and is paid at once below rather than whenever Stripe would.
    if (si.status === "draft") si = await stripe<StripeInvoice>("POST", `/v1/invoices/${sid}/finalize`, { auto_advance: collect === "charge" }, { idempotencyKey: `finalize-${key}` });
    let refused: StripeError | null = null;
    if (si.status === "open" && !inv.sent_at && collect === "email") si = await stripe<StripeInvoice>("POST", `/v1/invoices/${sid}/send`, {}, { idempotencyKey: `send-${key}` });
    if (si.status === "open" && !inv.sent_at && collect === "charge") ({ si, refused } = await pay(stripe, sid, card!.id, inv));

    // Due counts from the day it went, in the business's zone (Stripe's due_date is a UTC instant).
    const due = collect === "email" ? (opts.timeZone ? addDays(todayIn(opts.timeZone), inv.days_until_due) : utcDay(si.due_date)) : null;
    const taxes = Array.isArray(si.total_taxes) ? si.total_taxes.reduce((n, t) => n + (t.amount ?? 0), 0) : null;
    const [row] = await db.sql`
      update invoices set
        status = case when status = 'draft' and ${si.status} = 'open' then 'open' else status end,
        number = coalesce(number, ${si.number ?? null}::text),
        hosted_url = coalesce(${si.hosted_invoice_url ?? null}::text, hosted_url),
        pdf_url = coalesce(${si.invoice_pdf ?? null}::text, pdf_url),
        due_date = case when sent_at is null and ${due}::date is not null then ${due}::date else due_date end,
        subtotal_cents = ${si.subtotal}, total_cents = ${si.total}, tax_cents = coalesce(${taxes}::bigint, tax_cents),
        payment_failed_at = case when ${!!refused} then now() else payment_failed_at end,
        sent_at = coalesce(sent_at, now()), updated_by = ${by}, updated_at = now()
      where id = ${inv.id}::bigint
      returning *, to_char(due_date, 'YYYY-MM-DD') as due_day, to_char(period_on, 'YYYY-MM-DD') as period_day`;
    if (refused) return refusedResult(refused, cardName(card!), inv);
    return { ok: true, invoice: toInvoice(row) };
  } catch (e) {
    if (e instanceof StripeError) return fail("stripe", e.message);
    throw e;
  }
}

/**
 * Pay an open invoice with this card now. The card's refusal is an answer
 * (`refused`); anything else is thrown. Each attempt has its own key (a retry
 * after a refusal, or with another card, is a new try), while the same
 * attempt repeated is one charge.
 */
async function pay(stripe: Stripe, sid: string, card: string, inv: Pick<Invoice, "match_key" | "payment_failed_at">): Promise<{ si: StripeInvoice; refused: StripeError | null }> {
  const attempt = inv.payment_failed_at ? inv.payment_failed_at.getTime() : 0;
  try {
    return { si: await stripe<StripeInvoice>("POST", `/v1/invoices/${sid}/pay`, { payment_method: card }, { idempotencyKey: `pay-${inv.match_key}-${card}-${attempt}` }), refused: null };
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    // Stripe paid it itself in the meantime (auto_advance): nothing to do.
    const paid = e.code === "invoice_already_paid" || /already paid/i.test(e.message);
    if (!paid && !(e.type === "card_error" || REFUSALS.has(e.code ?? ""))) throw e;
    return { si: await stripe<StripeInvoice>("GET", `/v1/invoices/${sid}`), refused: paid ? null : e };
  }
}

function refusedResult(e: StripeError, card: string, inv: Pick<Invoice, "name" | "email">): StripeResult {
  const action = e.code === "invoice_payment_intent_requires_action" || e.code === "authentication_required";
  return action
    ? fail("action", `${card} needs ${inv.name ?? inv.email} to confirm this charge. Email them the payment page to confirm it or pay another way.`)
    : fail("declined", `${card} was declined: ${e.message}`);
}

/**
 * Charge an open invoice to the customer's card on file now: one emailed
 * that they have not paid, or a charge to try again after a refusal. What is
 * left on it is charged; paid arrives from the webhook.
 */
export async function chargeInvoice(db: Db, stripe: Stripe, id: string, by: string): Promise<StripeResult> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  if (!inv.stripe_invoice_id || inv.livemode === null) return fail("status", "This invoice was never sent with Stripe.");
  if (inv.status !== "open") return fail("status", `This invoice is ${inv.status}.`);
  try {
    const card = await chargeCard(db, stripe, inv.email, inv.livemode);
    if (!card) return fail("no_card", `${inv.name ?? inv.email} has no card on file. A card is saved when they pay an invoice on Stripe's page.`);
    const { refused } = await pay(stripe, inv.stripe_invoice_id, card.id, inv);
    await db.sql`update invoices set payment_failed_at = case when ${!!refused} then now() else payment_failed_at end, updated_by = ${by}, updated_at = now()
      where id = ${inv.id}::bigint`;
    return refused ? refusedResult(refused, cardName(card), inv) : { ok: true, invoice: inv };
  } catch (e) {
    if (e instanceof StripeError) return fail("stripe", e.message);
    throw e;
  }
}

const REFUSALS = new Set(["card_declined", "expired_card", "incorrect_cvc", "insufficient_funds", "authentication_required", "invoice_payment_intent_requires_action"]);
const utcDay = (t: number | null | undefined): string | null => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);

type StripeInvoice = {
  id: string; status: string; number?: string | null; hosted_invoice_url?: string | null; invoice_pdf?: string | null;
  due_date?: number | null; subtotal: number; total: number; total_taxes?: { amount?: number }[];
};

/** Ask Stripe for a change to a sent invoice; the status here follows when Stripe's event arrives. */
async function ask(db: Db, stripe: Stripe, id: string, allowed: Invoice["status"][], path: (sid: string) => string, keyPrefix: string): Promise<StripeResult> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  if (!inv.stripe_invoice_id) return fail("status", "This invoice was never sent with Stripe.");
  if (!allowed.includes(inv.status)) return fail("status", `This invoice is ${inv.status}.`);
  try {
    await stripe("POST", path(inv.stripe_invoice_id), {}, { idempotencyKey: `${keyPrefix}-${inv.match_key}` });
    return { ok: true, invoice: inv };
  } catch (e) {
    if (e instanceof StripeError) return fail("stripe", e.message);
    throw e;
  }
}

/** How a payment recorded by hand was made, as Jobber's and HubSpot's Record payment ask. */
export const PAYMENT_METHODS = ["Cash", "Check", "Bank transfer", "Other"] as const;
/** Stripe's payment records arrived in 2025-10-29.clover; these calls name a version that has them, whatever the account's default. */
const RECORDS_VERSION = "2026-08-26.dahlia";

/** What has been paid on an invoice so far, in cents: payments by hand and online. */
export async function paidSoFar(db: Db, id: string): Promise<number> {
  const [r] = await db.sql<{ cents: string }>`
    select coalesce(sum(coalesce(total_cents, amount_cents)), 0)::text as cents from payments
    where ref_type = 'invoice' and ref_id = ${id}::text and status in ('paid', 'refunded', 'partially_refunded')`;
  return Number(r.cents);
}

export type RecordInput = {
  amountCents: number;
  method: (typeof PAYMENT_METHODS)[number];
  /** YYYY-MM-DD, not after today. */
  paidOn: string;
  /** A check number, a transfer's reference. */
  reference: string | null;
  /** Random, from the form: the same click twice records one payment. */
  key: string;
  /** Today in the business's zone: a payment paid today is stamped now; one on an earlier day at midday that day. */
  today: string;
};

/**
 * A payment taken another way (cash, a check, a transfer), all of what is
 * owed or part of it, as Jobber's and HubSpot's Record payment: Stripe keeps
 * it as a payment record attached to the invoice, which stays open with less
 * to pay until nothing is left (then Stripe's invoice.paid marks it paid
 * here). The payments row is made first, pending and marked as by hand
 * (its record id a placeholder until Stripe's), so Stripe's invoice.paid,
 * which can arrive before this call returns, never counts it as paid online.
 * It turns paid once Stripe has it, or failed; the same key again retries it.
 */
export async function recordPayment(db: Db, stripe: Stripe, id: string, p: RecordInput, by: string): Promise<StripeResult & { remaining?: number }> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  if (!inv.stripe_invoice_id || !inv.stripe_customer_id) return fail("status", "This invoice was never sent with Stripe.");
  if (inv.status !== "open" && inv.status !== "uncollectible") return fail("status", `This invoice is ${inv.status}.`);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(p.key)) return fail("status", "Open the page again and record it from there.");
  const [mine] = await db.sql<{ id: string; status: string }>`
    select id::text as id, status from payments where ref_type = 'invoice' and ref_id = ${inv.id}::text and match_key = ${p.key}`;
  if (mine?.status === "paid") return { ok: true, invoice: inv };
  const balance = Number(inv.total_cents) - (await paidSoFar(db, inv.id));
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) return fail("amount", "Enter the amount paid.");
  if (p.amountCents > balance) return fail("amount", `That is more than the ${formatMoney(balance, inv.currency)} still owed.`);
  const now = Math.floor(Date.now() / 1000);
  const when = p.paidOn >= p.today ? now : Math.min(Math.floor(Date.parse(`${p.paidOn}T12:00:00Z`) / 1000), now);
  const at = new Date(when * 1000);
  // "Check · 1042": how, then their reference.
  const what = [p.method, p.reference].filter(Boolean).join(" · ");
  const row = mine
    ? (await db.sql<{ id: string }>`update payments set status = 'pending', updated_at = now() where id = ${mine.id}::bigint returning id::text as id`)[0]
    : (await db.sql<{ id: string }>`
        insert into payments (email, name, amount_cents, total_cents, currency, status, kind, ref_type, ref_id, description, livemode, source,
                              match_key, stripe_payment_record_id, updated_by)
        values (${inv.email}, ${inv.name}, ${p.amountCents}, ${p.amountCents}, ${inv.currency}, 'pending', 'invoice', 'invoice', ${inv.id}::text,
                ${`Invoice ${inv.number ?? inv.id}: ${what}`}, ${inv.livemode}, ${inv.source}, ${p.key}, ${`pending-${p.key}`}, ${by})
        returning id::text as id`)[0];
  try {
    const record = await stripe<{ id: string }>("POST", "/v1/payment_records/report_payment", {
      amount_requested: { value: p.amountCents, currency: inv.currency },
      initiated_at: when,
      outcome: "guaranteed",
      guaranteed: { guaranteed_at: when },
      payment_method_details: { type: "custom", custom: { display_name: p.method } },
      processor_details: { type: "custom", custom: { payment_reference: p.reference ?? p.method } },
      customer_details: { customer: inv.stripe_customer_id },
      description: what,
      metadata: { invoice_id: inv.id, payment_key: p.key },
    }, { idempotencyKey: `record-${inv.match_key}-${p.key}`, version: RECORDS_VERSION });
    const after = await stripe<{ amount_remaining: number }>("POST", `/v1/invoices/${inv.stripe_invoice_id}/attach_payment`,
      { payment_record: record.id }, { idempotencyKey: `attach-${inv.match_key}-${p.key}`, version: RECORDS_VERSION });
    await db.sql`
      update payments set status = 'paid', paid_at = ${at.toISOString()}::timestamptz, stripe_payment_record_id = ${record.id}, updated_at = now()
      where id = ${row.id}::bigint`;
    return { ok: true, invoice: inv, remaining: after.amount_remaining };
  } catch (e) {
    await db.sql`update payments set status = 'failed', updated_at = now() where id = ${row.id}::bigint and status = 'pending'`;
    if (e instanceof StripeError) return fail("stripe", e.message);
    throw e;
  }
}

/** Void a sent invoice; its invoice.voided marks it void here. Never deleted. */
export const voidInvoice = (db: Db, stripe: Stripe, id: string) =>
  ask(db, stripe, id, ["open", "uncollectible"], (sid) => `/v1/invoices/${sid}/void`, "void");

/** Written off; its invoice.marked_uncollectible marks it here. It can still be paid or voided. */
export const markUncollectible = (db: Db, stripe: Stripe, id: string) =>
  ask(db, stripe, id, ["open"], (sid) => `/v1/invoices/${sid}/mark_uncollectible`, "uncollectible");

/** How the payment page goes when Stripe will not email it: the owner's own sender (data/send.ts), and the name to sign it with. */
export type PageMail = { send: (mail: Email) => Promise<Sent>; business: string; replyTo?: string | null };

/**
 * Email the customer an open invoice's payment page, where they pay another
 * way or confirm a charge their bank asked about. Stripe emails one it sent
 * to be paid; one it charges it will not email ("only when
 * collection_method=send_invoice"), so that page goes through the owner's
 * own sender (`mail`). With no sender, the answer names the page's link to
 * pass on by hand. Each press emails again.
 */
export async function emailPaymentPage(db: Db, stripe: Stripe, id: string, mail?: PageMail): Promise<StripeResult> {
  const inv = await invoiceById(db, id);
  if (!inv) return fail("not_found", "No such invoice.");
  if (!inv.stripe_invoice_id) return fail("status", "This invoice was never sent with Stripe.");
  if (inv.status !== "open" && inv.status !== "uncollectible") return fail("status", `This invoice is ${inv.status}.`);
  const byHand = inv.hosted_url ? ` Send them its payment page yourself: ${inv.hosted_url}` : "";
  if (inv.collect === "charge") {
    if (!mail || !inv.hosted_url) return fail("stripe", `Stripe does not email the page of an invoice it charges, and no email sender is connected.${byHand}`);
    const amount = formatMoney(Number(inv.total_cents) - (await paidSoFar(db, inv.id)), inv.currency);
    const from = mail.business ? ` from ${mail.business}` : "";
    const sent = await mail.send({
      to: [inv.email],
      subject: `Invoice ${inv.number ?? inv.id}${from}: your payment did not go through`,
      text: [
        `Hello${inv.name ? ` ${inv.name}` : ""},`,
        "",
        `We could not take the payment of ${amount} for invoice ${inv.number ?? inv.id} from your card. You can pay it, or confirm it if your bank asks, here:`,
        inv.hosted_url,
        ...(mail.business ? ["", mail.business] : []),
      ].join("\n"),
      replyTo: mail.replyTo ?? null,
    });
    if (sent.status === "sent") return { ok: true, invoice: inv };
    return fail("stripe", `${sent.status === "none" ? sent.why : sent.error}.${byHand}`);
  }
  try {
    await stripe("POST", `/v1/invoices/${inv.stripe_invoice_id}/send`, {}, { idempotencyKey: `page-${inv.match_key}-${Date.now()}` });
    return { ok: true, invoice: inv };
  } catch (e) {
    if (e instanceof StripeError) return fail("stripe", `${e.message}${byHand}`);
    throw e;
  }
}
