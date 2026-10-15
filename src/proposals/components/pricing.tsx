// The centrepiece: the quote's lines, its tax, the total set large, and what
// happens when they sign. Everything here is the quote's own.
import { formatMoney } from "../../payments/money";
import { taxSummary } from "../../invoices/document";
import { Band, Heading, Inner } from "./kit";
import type { ProposalComponent } from "./types";

export const pricing: ProposalComponent = {
  key: "pricing", label: "Pricing", shows: "The quote's lines, tax and total, and what happens when they sign", on: true, always: true, sample: false,
  render: (d) => {
    const q = d.quote;
    const m = (c: string | number) => formatMoney(c, q.currency, d.locale);
    const taxes = taxSummary(q.lines, d.rates);
    return (
      <Band id="pricing" tone={d.ground("pricing")}>
        <Inner>
          <div class="grid gap-12 md:grid-cols-12">
            <div class="md:col-span-4">
              <Heading title="The price" />
            </div>
            <div class="md:col-span-8">
              <table class="w-full border-collapse text-body">
                <thead>
                  <tr class="border-b border-line-strong text-left text-eyebrow uppercase text-muted">
                    <th scope="col" class="pb-4 font-semibold">What</th>
                    <th scope="col" class="pb-4 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {q.lines.map((l) => (
                    <tr class="border-b border-line align-top">
                      <td class="py-5 pr-6">
                        <span class="text-title">{l.description}</span>
                        {l.quantity !== "1" ? <span class="mt-1 block text-small text-muted">{l.quantity} x {m(l.unit_cents)}</span> : null}
                      </td>
                      <td class="whitespace-nowrap py-5 text-right">{m(l.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl class="mt-6 flex flex-col gap-2 text-small">
                {taxes.length ? <div class="flex justify-between"><dt class="text-muted">Subtotal</dt><dd>{m(q.subtotal_cents)}</dd></div> : null}
                {taxes.map((t) => <div class="flex justify-between"><dt class="text-muted">{t.label}{t.inclusive ? " (included)" : ""}</dt><dd>{m(t.cents)}</dd></div>)}
              </dl>
              <div class="mt-8 flex items-end justify-between gap-6 border-t-2 border-ink pt-6">
                <span class="text-eyebrow uppercase">Total</span>
                <span class="font-display text-figure">{m(q.total_cents)}</span>
              </div>
              <p class="mt-8 rounded-box border border-line bg-canvas p-6 text-body">{d.afterSign}</p>
            </div>
          </div>
        </Inner>
      </Band>
    );
  },
};
