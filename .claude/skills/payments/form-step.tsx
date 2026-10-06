// The `payment` step of a form (the forms skill's steps.ts): what the
// submission costs, then Stripe Checkout for it. The payment names the
// submission (ref_type 'submission'), and only the webhook marks it paid.
//
//   formRoutes(getDb, { source, page, steps: { payment: paymentStep(getDb, (c) => stripeFrom(envOf(c)), { source: "website" }) } })
//
// The price comes from forms (price.ts): the things bought, the step's fees,
// a booking's price. The step's tax_rate_id taxes every line. Coming back
// from a cancelled checkout shows the step again; once paid it says so.
import type { Context } from "hono";
import type { GetDb } from "../data/db";
import type { FormStep } from "../forms/steps";
import { startCheckout } from "./checkout";
import { formatMoney } from "./money";
import { StripeError, type Stripe } from "./stripe";
import { stripeTaxRate, taxRates } from "./tax";

export type PaymentStepOptions = {
  /** This app's slug, stored on the payment. */
  source: string;
  /** How long a checkout stays open; default 31 minutes (Stripe's least is 30), so a held time is not held long. */
  expiresInMinutes?: number;
};

const button =
  "inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-5 font-semibold text-accent-ink";

export function paymentStep(getDb: GetDb, stripeOf: (c: Context) => Stripe, opts: PaymentStepOptions): FormStep {
  const paid = async (c: Context, submissionId: string) => {
    const [row] = await getDb(c).sql<{ status: string; total: string; currency: string }>`
      select status, coalesce(total_cents, amount_cents)::text as total, currency from payments
      where ref_type = 'submission' and ref_id = ${submissionId} and status in ('paid', 'partially_refunded', 'refunded')
      order by created_at desc limit 1`;
    return row ?? null;
  };

  return {
    async render(c, ctx, shown) {
      const done = await paid(c, ctx.submission.id);
      if (done) {
        return (
          <div class="grid gap-4">
            <p>Paid {formatMoney(done.total, done.currency)}. Thank you.</p>
            <p><a href={ctx.next}>Continue</a></p>
          </div>
        );
      }
      const price = ctx.price;
      const taxed = !!ctx.field.tax_rate_id;
      return (
        <form method="post" action={ctx.action} class="grid gap-4">
          {ctx.hidden}
          {shown.errors?.payment ? <p role="alert" class="rounded-card border border-line-strong bg-panel p-4 font-semibold">{shown.errors.payment}</p> : null}
          {price ? (
            <table class="w-full border-collapse">
              <tbody>
                {price.lines.map((l) => (
                  <tr class="border-b border-line">
                    <td class="py-2">{l.quantity > 1 ? `${l.quantity} x ${l.label}` : l.label}</td>
                    <td class="py-2 text-right whitespace-nowrap">{formatMoney(l.quantity * l.unit_cents, price.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td class="py-2 font-semibold">{taxed ? "Total before tax" : "Total"}</td>
                  <td class="py-2 text-right font-semibold whitespace-nowrap">{formatMoney(price.subtotal_cents, price.currency)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p>There is nothing to pay.</p>
          )}
          {price && taxed ? <p class="text-label text-ink-2">Tax is added on the next page.</p> : null}
          <div>
            <button type="submit" class={button}>{price ? "Pay securely with Stripe" : "Continue"}</button>
          </div>
        </form>
      );
    },

    async take(c, ctx) {
      const price = ctx.price;
      if (!price || (await paid(c, ctx.submission.id))) return { ok: true };
      const db = getDb(c);
      const stripe = stripeOf(c);
      // One open checkout per submission: an earlier one (another tab, the back
      // button, a cancel and retry) is closed first, so two can never both be paid.
      // Stripe refuses to close one already paid; then the payment is on its way.
      const open = await db.sql<{ session: string }>`
        select stripe_checkout_session_id as session from payments
        where ref_type = 'submission' and ref_id = ${ctx.submission.id} and status in ('pending', 'failed')
          and stripe_checkout_session_id is not null`;
      for (const { session } of open) {
        try {
          await stripe("POST", `/v1/checkout/sessions/${session}/expire`, {}, { idempotencyKey: `expire-${session}` });
        } catch (e) {
          if (!(e instanceof StripeError)) throw e;
          const now = await stripe<{ status: string }>("GET", `/v1/checkout/sessions/${session}`).catch(() => null);
          if (now?.status !== "expired") {
            return { ok: false, errors: { payment: "A payment for this is already under way. Wait a minute, then reload this page." } };
          }
        }
      }
      try {
        let taxRate: string | null = null;
        if (ctx.field.tax_rate_id) {
          const rate = (await taxRates(db)).find((r) => r.id === ctx.field.tax_rate_id);
          if (rate) taxRate = await stripeTaxRate(db, stripe, rate, (await stripe<{ livemode: boolean }>("GET", "/v1/balance")).livemode);
          // forms save refuses an unknown rate; one gone since is charged untaxed, and said so in the log.
          else console.error(`forms: form ${ctx.form.key} names tax rate ${ctx.field.tax_rate_id}, which is not in tax_rates; this checkout is untaxed`);
        }
        const thanks = ctx.next + (ctx.next.includes("?") ? "&" : "?") + "paid=1";
        const { url } = await startCheckout(db, stripe, {
          kind: "full", refType: "submission", refId: ctx.submission.id,
          amountCents: price.subtotal_cents, currency: price.currency,
          description: `${ctx.form.title}: ${price.lines.map((l) => l.label).join(", ")}`.slice(0, 250),
          lines: price.lines.map((l) => ({ name: l.label, quantity: l.quantity, unitCents: l.unit_cents, taxRate })),
          email: ctx.submission.email, name: ctx.submission.name, source: opts.source,
          successUrl: thanks, cancelUrl: ctx.self,
          expiresAt: new Date(Date.now() + (opts.expiresInMinutes ?? 31) * 60_000),
        });
        return { ok: true, redirect: url };
      } catch (e) {
        if (e instanceof StripeError) {
          console.error(`forms: checkout for submission ${ctx.submission.id} failed: ${e.message}`);
          return { ok: false, errors: { payment: "Payment could not start just now. Nothing was charged. Try again in a moment." } };
        }
        throw e;
      }
    },
  };
}
