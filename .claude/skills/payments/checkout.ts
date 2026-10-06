// Take a payment with Stripe Checkout: record it as pending, open a Checkout
// Session for it, and send the payer there with a 303.
//
//   app.post("/invoices/:id/pay", async (c) => {
//     const invoice = …;                                  // what it pays for, and its amount, from the database
//     const { url } = await startCheckout(getDb(c), stripeFrom(envOf(c)), {
//       kind: "invoice", refType: "invoice", refId: invoice.id,
//       amountCents: invoice.total_cents, currency: invoice.currency, description: `Invoice ${invoice.number}`,
//       email: invoice.email, name: invoice.name, source: "invoices",
//       successUrl: `${origin}/invoices/${invoice.id}`, cancelUrl: `${origin}/invoices/${invoice.id}`,
//     });
//     return c.redirect(url, 303);
//   });
//
// A booking's deposit starts it from bookingPages' afterBook (SKILL.md).
//
// The thanks page says the payment is being confirmed. It never marks
// anything paid: the success redirect can be opened by anyone and arrives
// before (or without) the payment settling. Status comes from the webhook.
import type { Db } from "../data/db";
import { normalizeEmail } from "../data/email";
import { currencyCode } from "./money";
import type { Stripe } from "./stripe";

export type PaymentKind = "deposit" | "full" | "invoice" | "other";

/** One line on Stripe's page: a quantity at a price in minor units, with the Stripe tax rate (tax.ts stripeTaxRate) when taxed. */
export type CheckoutLine = { name: string; quantity: number; unitCents: number; taxRate?: string | null };

export type CheckoutInput = {
  kind: PaymentKind;
  refType: string;
  refId: string;
  /** Minor units of `currency` (money.ts toMinor); with `lines`, their total before tax. */
  amountCents: number;
  /** Several lines (an order); without them, one line of `amountCents` named by `description`. */
  lines?: CheckoutLine[];
  currency: string;
  /** Shown to the payer on Stripe's page as the line item. */
  description: string;
  email?: string | null;
  name?: string | null;
  /** This app's slug. */
  source: string;
  successUrl: string;
  cancelUrl: string;
  /** Close the session sooner than Stripe's 24 hours (at least 30 minutes ahead), e.g. to free a held slot. */
  expiresAt?: Date;
  /** The team member starting it, when a person did. */
  updatedBy?: string | null;
};

export async function startCheckout(db: Db, stripe: Stripe, input: CheckoutInput): Promise<{ paymentId: string; url: string }> {
  const currency = currencyCode(input.currency);
  if (!currency) throw new Error(`not a currency code: ${input.currency}`);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("amountCents must be a positive integer in minor units");
  const lines = input.lines ?? [{ name: input.description, quantity: 1, unitCents: input.amountCents }];
  // The row's amount is what the webhook checks the paid session's subtotal against, so the lines must make it.
  if (lines.some((l) => !Number.isSafeInteger(l.quantity) || l.quantity <= 0 || !Number.isSafeInteger(l.unitCents) || l.unitCents < 0)
    || lines.reduce((n, l) => n + l.quantity * l.unitCents, 0) !== input.amountCents) {
    throw new Error("each line needs a whole quantity and a price in minor units, and together they make amountCents");
  }
  const email = input.email ? normalizeEmail(input.email) : null;
  // Random per row: it ties Stripe's events to this row and no other, even when
  // another project on the same Stripe account has a payment with the same id.
  const key = crypto.randomUUID();

  // The row first, so every session Stripe ever has points at a row here.
  const [row] = await db.sql<{ id: string }>`
    insert into payments (email, name, amount_cents, currency, kind, ref_type, ref_id, description, source, updated_by, match_key)
    values (${email}, ${input.name ?? null}, ${input.amountCents}, ${currency}, ${input.kind}, ${input.refType}, ${input.refId},
            ${input.description}, ${input.source}, ${input.updatedBy ?? null}, ${key})
    returning id::text`;
  const paymentId = row.id;
  const tag = { payment_id: paymentId, payment_key: key, ref_type: input.refType, ref_id: input.refId };

  let session: { id: string; url: string; livemode: boolean };
  try {
    session = await stripe(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "payment",
        client_reference_id: paymentId,
        customer_email: email ?? undefined,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: input.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : undefined,
        line_items: lines.map((l) => ({
          quantity: l.quantity,
          price_data: { currency, unit_amount: l.unitCents, product_data: { name: l.name.slice(0, 250) } },
          tax_rates: l.taxRate ? [l.taxRate] : undefined,
        })),
        metadata: tag,
        // Copied onto the charge, so refund and failure events find the row too.
        payment_intent_data: { metadata: tag, description: input.description },
      },
      // Idempotency keys are per Stripe account, so the row's random key, not its id.
      { idempotencyKey: `checkout-${key}` },
    );
  } catch (e) {
    await db.sql`update payments set status = 'cancelled', updated_at = now() where id = ${paymentId} and status = 'pending'`;
    throw e;
  }

  await db.sql`
    update payments set stripe_checkout_session_id = ${session.id}, livemode = ${session.livemode}, updated_at = now()
    where id = ${paymentId}`;
  return { paymentId, url: session.url };
}
