// The one section that stands out: the lines, the tax, the total, and what
// happens when they sign, in words.
import { formatMoney } from "../../payments/money";
import { taxSummary } from "../../invoices/document";
import { Frame, Prose, type SectionProps } from "./parts";

export function Pricing({ d, c }: SectionProps) {
  const q = d.quote;
  const m = (cents: string | number) => formatMoney(cents, q.currency, d.locale);
  const taxes = taxSummary(q.lines, d.rates);
  const each = (qty: string, unit: number) => (qty === "1" ? "" : `${qty} x ${m(unit)}`);
  return (
    <Frame id="pricing" title={c.title}>
      {c.texts.intro ? <Prose src={c.texts.intro} class="mb-6 text-body text-muted" /> : null}
      <div class="rounded-box bg-panel p-5 sm:p-8">
        <table class="w-full border-collapse text-body tabular-nums">
          <thead class="sr-only">
            <tr><th scope="col">What</th><th scope="col">Amount</th></tr>
          </thead>
          <tbody>
            {q.lines.map((l) => (
              <tr class="border-b border-line align-top">
                <td class="py-3 pr-4">
                  {l.description}
                  {each(l.quantity, l.unit_cents) ? <span class="block text-small text-muted">{each(l.quantity, l.unit_cents)}</span> : null}
                </td>
                <td class="whitespace-nowrap py-3 text-right">{m(l.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot class="text-small">
            {taxes.length ? <tr><td class="pt-4 text-muted">Subtotal</td><td class="whitespace-nowrap pt-4 text-right">{m(q.subtotal_cents)}</td></tr> : null}
            {taxes.map((t) => (
              <tr><td class="pt-1 text-muted">{t.label}{t.inclusive ? " (included)" : ""}</td><td class="whitespace-nowrap pt-1 text-right">{m(t.cents)}</td></tr>
            ))}
            <tr>
              <td class="pt-5 text-body font-semibold">Total</td>
              <td class="whitespace-nowrap pt-5 text-right font-display text-total">{m(q.total_cents)}</td>
            </tr>
          </tfoot>
        </table>
        {d.afterSign ? <p class="mt-6 border-t border-line pt-5 text-small">{d.afterSign}</p> : null}
      </div>
    </Frame>
  );
}
