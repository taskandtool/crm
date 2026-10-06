// The Stripe webhook: the only thing that changes a payment's status.
//
//   import { stripeWebhook } from "./payments/webhook";
//   app.route("/", stripeWebhook(getDb, {}));    // reads STRIPE_WEBHOOK_SECRET (data/env.ts)
//
// On the machine Stripe reaches it through the app's inbound URL
// (`inbound_url("/hooks/stripe")`), which forwards path and body unchanged; an
// app served from its edge Worker takes it at its own public address.
//
// What it guarantees:
// - The signature is checked over the raw bytes, before any parsing.
// - An event is handled once: its id goes into stripe_events in the
//   same statement that applies it, so a redelivery (or the same event sent to
//   a second app's endpoint on the project) changes nothing.
// - A status never moves backwards. Stripe does not promise order, so a late
//   checkout.session.completed after charge.refunded leaves the row refunded.
import { Hono, type Context } from "hono";
import type { Db, GetDb } from "../data/db";
import { envVar } from "../data/env";
import { normalizeEmail } from "../data/email";
import { currencyCode } from "./money";

export type WebhookOptions = {
  /** The endpoint's signing secret; default the STRIPE_WEBHOOK_SECRET setting. */
  secret?: (c: Context) => string | undefined;
  /** Default "/hooks/stripe". */
  path?: string;
  /** Another skill's events, tried after this skill's own (the invoices skill's invoiceEvents). */
  more?: EventHandler[];
  /**
   * After an event leaves a payment paid (or partly refunded; one refunded
   * whole was not bought, so nothing follows from it): what else that means, such as a form that ends in payment being complete
   * and its booking confirmed (forms' completePaidSubmission, booking's
   * confirmFormBooking). Runs on every delivery of such an event, a retry and
   * another app's included, so it must be safe to run again; it throws to
   * answer 500, and Stripe delivers again.
   */
  afterPaid?: (c: Context, paymentId: string) => Promise<void>;
};

/**
 * Events another skill handles, on the same endpoint and the same rules:
 * `apply` records the event in stripe_events in the same transaction that
 * applies it, so it happens once, and moves statuses only forward. It throws
 * to answer 500, so Stripe delivers it again.
 */
export type EventHandler = {
  handles: (event: StripeEvent) => boolean;
  apply: (db: Db, event: StripeEvent) => Promise<void>;
};

export function stripeWebhook(getDb: GetDb, opts: WebhookOptions = {}): Hono {
  const app = new Hono();
  app.post(opts.path ?? "/hooks/stripe", async (c) => {
    const secret = opts.secret ? opts.secret(c) : envVar(c, "STRIPE_WEBHOOK_SECRET");
    if (!secret) {
      // 500, not 400: Stripe retries for days, so nothing is lost once the secret is set.
      console.error("stripe webhook: STRIPE_WEBHOOK_SECRET is not set");
      return c.text("not configured", 500);
    }
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!(await verifyStripeSignature(raw, c.req.header("stripe-signature"), secret))) return c.text("bad signature", 400);

    let event: StripeEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.text("bad payload", 400);
    }
    const change = planEvent(event);
    if (change) {
      const r = await applyEvent(getDb(c), event, change);
      // A paid session that left its row unpaid: its amount or currency is not the row's.
      if (r.fresh && r.paymentId && change.to === "paid" && ["pending", "failed", "cancelled"].includes(r.status ?? "")) {
        console.error(`stripe webhook: ${event.id} paid a different amount or currency than payment ${r.paymentId}; left ${r.status}`);
      }
      if (opts.afterPaid) {
        // A delivery seen before (a retry after afterPaid failed, or the same
        // event at another app's endpoint) runs it again from the recorded row.
        const [row] = r.paymentId
          ? [{ id: r.paymentId, status: r.status }]
          : await getDb(c).sql<{ id: string; status: string }>`
              select p.id::text as id, p.status from stripe_events e join payments p on p.id = e.payment_id where e.id = ${event.id}`;
        if (row && ["paid", "partially_refunded"].includes(row.status ?? "")) await opts.afterPaid(c, row.id);
      }
    } else {
      const other = opts.more?.find((h) => h.handles(event));
      if (other) await other.apply(getDb(c), event);
    }
    return c.json({ received: true });
  });
  return app;
}

// ── Signature ────────────────────────────────────────────────────────────────

/**
 * Stripe-Signature is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, each v1 the
 * HMAC-SHA256 of `${t}.${raw body}` under the signing secret (several while a
 * secret is being rolled). Old timestamps are refused so a captured event
 * cannot be replayed later.
 */
export async function verifyStripeSignature(
  raw: Uint8Array | string,
  header: string | null | undefined,
  secret: string,
  { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  if (!header || !secret) return false;
  let t: string | null = null;
  const sigs: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") {
      const bytes = fromHex(v);
      if (bytes) sigs.push(bytes);
    }
  }
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;

  const enc = new TextEncoder();
  const body = typeof raw === "string" ? enc.encode(raw) : raw;
  const prefix = enc.encode(t + ".");
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // subtle.verify compares in constant time.
  for (const sig of sigs) if (await crypto.subtle.verify("HMAC", key, sig as BufferSource, signed as BufferSource)) return true;
  return false;
}

function fromHex(s: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── Events ───────────────────────────────────────────────────────────────────

export type StripeEvent = { id: string; type: string; created?: number; data: { object: any } };

type Status = "pending" | "paid" | "failed" | "refunded" | "partially_refunded" | "cancelled";

/** What one event does to its payment row: move to `to` only from a status in `from`. */
export type Change = {
  to: Status;
  from: Status[];
  sessionId: string | null;
  intentId: string | null;
  /** metadata.payment_id, trusted only with payment_key and the refs (see applyEvent). */
  paymentId: string | null;
  key: string | null;
  refType: string | null;
  refId: string | null;
  email: string | null;
  /** Total refunded so far (charge.amount_refunded); only ever rises. */
  refunded: number | null;
  /** When the refunded charge was made (charge.created): a refund proves the money was taken. */
  chargedAt: Date | null;
  /** A paid session's subtotal and currency; the row moves to paid only when they are its own. */
  amount: number | null;
  /** A session's total, tax included: recorded as the row's total_cents once paid. */
  total: number | null;
  currency: string | null;
};

const id = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && "id" in v ? String((v as any).id) : null);
const digits = (v: unknown): string | null => (typeof v === "string" && /^\d{1,18}$/.test(v) ? v : null);

/** The change an event asks for, or null for an event this skill does not handle. */
export function planEvent(event: StripeEvent): Change | null {
  const o = event.data?.object ?? {};
  const meta = o.metadata ?? {};
  const base = {
    sessionId: null as string | null,
    intentId: null as string | null,
    paymentId: digits(meta.payment_id),
    key: typeof meta.payment_key === "string" ? meta.payment_key : null,
    refType: typeof meta.ref_type === "string" ? meta.ref_type : null,
    refId: typeof meta.ref_id === "string" ? meta.ref_id : null,
    email: null as string | null,
    refunded: null as number | null,
    chargedAt: null as Date | null,
    amount: null as number | null,
    total: null as number | null,
    currency: null as string | null,
  };
  const session = () => ({
    ...base,
    sessionId: id(o.id),
    intentId: id(o.payment_intent),
    // Not client_reference_id: a Payment Link takes it from its URL, so anyone can set it.
    email: normalizeEmail(o.customer_details?.email),
    // Subtotal, before tax and discounts: what startCheckout asked for.
    amount: Number.isSafeInteger(o.amount_subtotal) ? (o.amount_subtotal as number) : null,
    total: Number.isSafeInteger(o.amount_total) ? (o.amount_total as number) : null,
    currency: currencyCode(o.currency),
  });

  switch (event.type) {
    case "checkout.session.completed":
      // "unpaid" is a delayed method (a bank debit): it settles later, by an async event.
      // Paid wins over cancelled: money that arrived for a row startCheckout gave up on is still money.
      return o.payment_status === "paid"
        ? { ...session(), to: "paid", from: ["pending", "failed", "cancelled"] }
        : { ...session(), to: "pending", from: ["pending"] };
    case "checkout.session.async_payment_succeeded":
      return { ...session(), to: "paid", from: ["pending", "failed", "cancelled"] };
    case "checkout.session.async_payment_failed":
      return { ...session(), to: "failed", from: ["pending"] };
    case "checkout.session.expired":
      return { ...session(), to: "cancelled", from: ["pending", "failed"] };
    case "payment_intent.payment_failed":
      // One declined card; the payer may still pay in the same session, and `paid` may follow.
      return { ...base, intentId: id(o.id), to: "failed", from: ["pending"] };
    case "charge.refunded": {
      const refunded = Number(o.amount_refunded);
      if (!Number.isSafeInteger(refunded)) return null;
      const chargedAt = Number.isSafeInteger(o.created) ? new Date(o.created * 1000) : null;
      const charge = { ...base, intentId: id(o.payment_intent), refunded, chargedAt };
      return o.refunded === true
        ? { ...charge, to: "refunded", from: ["pending", "paid", "failed", "partially_refunded"] }
        : { ...charge, to: "partially_refunded", from: ["pending", "paid", "failed", "partially_refunded"] };
    }
    default:
      return null;
  }
}

/**
 * Record the event and apply its change in one statement, so the two commit
 * together or not at all (a failure answers 500 and Stripe redelivers).
 *
 * The row is found by its Stripe ids. Before those are linked (a decline or a
 * refund can arrive before checkout.session.completed) it is found by the
 * metadata startCheckout set: payment_id, payment_key and the refs, and only
 * while the row has no different Stripe id of the same kind. payment_key is
 * random per row, so a payment with the same id in another project on the
 * same Stripe account, or a Checkout made elsewhere, never matches.
 *
 * The status moves only from a status in `from` (checked on the locked row,
 * so concurrent events cannot interleave wrongly); the Stripe ids, the email
 * and paid_at only fill blanks, whatever the order (a refund fills paid_at
 * from the charge's time when the payment event is late or lost). `status` is the row's
 * status afterwards, null when no row matched.
 */
export async function applyEvent(
  db: Db,
  event: StripeEvent,
  ch: Change,
): Promise<{ fresh: boolean; paymentId: string | null; status: string | null }> {
  const at = event.created ? new Date(event.created * 1000) : new Date();
  const [r] = await db.sql<{ fresh: boolean; payment_id: string | null; status: string | null }>`
    with target as (
      select m.id from payments m
      where (${ch.sessionId}::text is not null and m.stripe_checkout_session_id = ${ch.sessionId}::text)
         or (${ch.intentId}::text is not null and m.stripe_payment_intent_id = ${ch.intentId}::text)
         or (m.id = ${ch.paymentId}::bigint
             and m.match_key is not distinct from ${ch.key}::text
             and m.ref_type is not distinct from ${ch.refType}::text
             and m.ref_id is not distinct from ${ch.refId}::text
             and (${ch.sessionId}::text is null or m.stripe_checkout_session_id is null)
             and (${ch.intentId}::text is null or m.stripe_payment_intent_id is null))
      order by coalesce(m.stripe_checkout_session_id = ${ch.sessionId}::text
                        or m.stripe_payment_intent_id = ${ch.intentId}::text, false) desc
      limit 1
    ),
    ev as (
      insert into stripe_events (id, type, payment_id)
      values (${event.id}, ${event.type}, (select id from target))
      on conflict (id) do nothing
      returning payment_id
    ),
    upd as (
      update payments p set
        status = case when p.status = any(${ch.from}::text[])
                        and (${ch.refunded}::bigint is null or ${ch.refunded}::bigint > p.refunded_cents or ${ch.to} <> p.status)
                        and (${ch.to} <> 'paid' or ((${ch.amount}::bigint is null or p.amount_cents = ${ch.amount}::bigint)
                                                    and (${ch.currency}::text is null or p.currency = ${ch.currency}::text)))
                      then ${ch.to} else p.status end,
        refunded_cents = case when p.status = any(${ch.from}::text[])
                        then greatest(p.refunded_cents, coalesce(${ch.refunded}::bigint, 0)) else p.refunded_cents end,
        stripe_checkout_session_id = coalesce(p.stripe_checkout_session_id, ${ch.sessionId}::text),
        -- The total only when this event pays the row: an expired or mismatched session says nothing about what was paid.
        total_cents = case when ${ch.to} = 'paid' and p.status = any(${ch.from}::text[])
                            and (${ch.amount}::bigint is null or p.amount_cents = ${ch.amount}::bigint)
                            and (${ch.currency}::text is null or p.currency = ${ch.currency}::text)
                           then coalesce(p.total_cents, ${ch.total}::bigint) else p.total_cents end,
        stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, ${ch.intentId}::text),
        email = coalesce(p.email, ${ch.email}::citext),
        paid_at = case when ${ch.to} = 'paid'
                        and (${ch.amount}::bigint is null or p.amount_cents = ${ch.amount}::bigint)
                        and (${ch.currency}::text is null or p.currency = ${ch.currency}::text)
                       then coalesce(p.paid_at, ${at}::timestamptz)
                       -- A refund that arrives before (or without) the payment event still proves it was paid.
                       when ${ch.to} in ('refunded', 'partially_refunded')
                       then coalesce(p.paid_at, ${ch.chargedAt}::timestamptz, now())
                       else p.paid_at end,
        updated_at = now()
      from ev
      where p.id = ev.payment_id
      returning p.id, p.status
    )
    select exists (select 1 from ev) as fresh, (select id::text from upd) as payment_id, (select status from upd) as status`;
  return { fresh: r.fresh, paymentId: r.payment_id, status: r.status };
}
