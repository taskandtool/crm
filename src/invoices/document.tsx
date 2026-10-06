// A quote as the customer sees it: a standalone HTML document (the preview,
// and what reports/print.ts turns into the PDF) and the email that carries
// it. Both read the stored lines and totals; nothing is recomputed here but
// the per-rate tax summary, which adds stored line taxes.
//
//   const html = quoteHtml(quote, rates, { business: "Acme Plumbing" });
//   const { subject, text } = quoteMessage(quote, rates, { business: "Acme Plumbing" });
import type { Db } from "../data/db";
import type { Email, Sent } from "../data/send";
import { formatMoney } from "../payments/money";
import { percentText, type TaxRate } from "../payments/tax";
import type { SavedLine } from "./lines";
import { markSent, type Quote } from "./quotes";

/** The business's name, and its zone: the quote's date is the day it is there. */
export type DocOptions = { business: string; timeZone?: string; locale?: string };

/** "2026-11-30" as "November 30, 2026"; the date is a calendar day, read in UTC. */
export function dayText(day: string | null, locale = "en-US"): string {
  if (!day) return "";
  const d = new Date(day + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "long" }).format(d);
}

/** Tax per rate, from the stored line taxes, in the order the rates first appear. */
export function taxSummary(lines: SavedLine[], rates: TaxRate[]): { label: string; cents: number; inclusive: boolean }[] {
  const out = new Map<string, { label: string; cents: number; inclusive: boolean }>();
  for (const l of lines) {
    if (!l.tax_rate_id) continue;
    const r = rates.find((x) => x.id === l.tax_rate_id);
    const row = out.get(l.tax_rate_id) ?? { label: r ? `${r.name} ${percentText(r.percent_bp)}` : "Tax", cents: 0, inclusive: r?.inclusive ?? false };
    row.cents += Number(l.tax_cents);
    out.set(l.tax_rate_id, row);
  }
  return [...out.values()];
}

const qty = (l: SavedLine) => (l.quantity === "1" ? "" : `${l.quantity} x `);

/** The email that sends a quote: every line in the body, so it stands without the PDF. */
export function quoteMessage(qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions, payUrl?: string | null): { subject: string; text: string } {
  const m = (c: string | number) => formatMoney(c, qt.currency, o.locale);
  const lines = qt.lines.map((l) => `  ${l.description}: ${qty(l)}${m(l.unit_cents)} = ${m(l.amount_cents)}`);
  const taxes = taxSummary(qt.lines, rates).map((t) => `  ${t.label}${t.inclusive ? " (included)" : ""}: ${m(t.cents)}`);
  const body = [
    `Hello${qt.name ? " " + qt.name : ""},`,
    "",
    `Here is our quote ${qt.number} for ${m(qt.total_cents)}.`,
    "",
    ...lines,
    "",
    ...(taxes.length ? [`  Subtotal: ${m(qt.subtotal_cents)}`, ...taxes] : []),
    `  Total: ${m(qt.total_cents)}`,
    ...(qt.valid_until ? ["", `Valid until ${dayText(qt.valid_until, o.locale)}.`] : []),
    ...(qt.notes ? ["", qt.notes] : []),
    ...(qt.terms ? ["", qt.terms] : []),
    "",
    ...(payUrl ? [`To accept and pay: ${payUrl}`, "", "Or reply to this email with any questions."] : ["To accept, reply to this email."]),
    ...(o.business ? ["", o.business] : []),
  ];
  return { subject: `Quote ${qt.number}${o.business ? ` from ${o.business}` : ""}`, text: body.join("\n") };
}

// Print styles: plain greys on white, sized for A4 and Letter alike.
const STYLE = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: rgb(20 20 20); background: white; }
  main { max-width: 760px; margin: 0 auto; padding: 24px; }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 32px; }
  h1 { font-size: 24px; margin: 0; }
  .muted { color: rgb(90 90 90); }
  .to { margin-bottom: 24px; white-space: pre-line; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 600; border-bottom: 1px solid rgb(120 120 120); padding: 6px 4px; }
  td { padding: 6px 4px; border-bottom: 1px solid rgb(220 220 220); vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 320px; margin-top: 12px; }
  .totals td { border: 0; padding: 3px 4px; }
  .total td { font-weight: 700; border-top: 1px solid rgb(120 120 120); padding-top: 6px; }
  .text { white-space: pre-wrap; margin-top: 24px; }
`;

export function QuoteDocument({ qt, rates, o, payUrl }: { qt: Quote & { lines: SavedLine[] }; rates: TaxRate[]; o: DocOptions; payUrl?: string | null }) {
  const m = (c: string | number) => formatMoney(c, qt.currency, o.locale);
  const taxes = taxSummary(qt.lines, rates);
  const to = [qt.name, qt.email, qt.phone, qt.address].filter(Boolean).join("\n");
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{o.business ? `Quote ${qt.number}, ${o.business}` : `Quote ${qt.number}`}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main>
          <header>
            <div>{o.business ? <h1>{o.business}</h1> : null}</div>
            <div class="num">
              <h1>Quote {qt.number}</h1>
              <div class="muted">{dayText(new Intl.DateTimeFormat("en-CA", { timeZone: o.timeZone ?? "UTC" }).format(qt.sent_at ?? qt.created_at), o.locale)}</div>
              {qt.valid_until ? <div class="muted">Valid until {dayText(qt.valid_until, o.locale)}</div> : null}
            </div>
          </header>
          <div class="to">{to}</div>
          <table>
            <thead>
              <tr><th>Description</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Amount</th></tr>
            </thead>
            <tbody>
              {qt.lines.map((l) => (
                <tr>
                  <td>{l.description}</td>
                  <td class="num">{l.quantity}</td>
                  <td class="num">{m(l.unit_cents)}</td>
                  <td class="num">{m(l.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table class="totals">
            <tbody>
              {taxes.length ? <tr><td>Subtotal</td><td class="num">{m(qt.subtotal_cents)}</td></tr> : null}
              {taxes.map((t) => (
                <tr><td>{t.label}{t.inclusive ? " (included)" : ""}</td><td class="num">{m(t.cents)}</td></tr>
              ))}
              <tr class="total"><td>Total</td><td class="num">{m(qt.total_cents)}</td></tr>
            </tbody>
          </table>
          {payUrl ? <p class="text"><a href={payUrl}>Accept and pay online</a></p> : null}
          {qt.notes ? <div class="text">{qt.notes}</div> : null}
          {qt.terms ? <div class="text muted">{qt.terms}</div> : null}
        </main>
      </body>
    </html>
  );
}

/** The whole document as text, for the preview route and the printer. */
export const quoteHtml = (qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions, payUrl?: string | null): string =>
  "<!doctype html>" + (<QuoteDocument qt={qt} rates={rates} o={o} payUrl={payUrl} />).toString();

export type SendQuote = {
  /** Delivers the email; never throws (data/send.ts's sendEmail). */
  send: (mail: Email) => Promise<Sent>;
  /** The PDF of the document's HTML, or null where nothing can print. */
  print?: (html: string) => Promise<Uint8Array | null>;
  /** Where replies go: the team member sending it. */
  replyTo: string | null;
  by: string;
  /** A proposal's Pay button: the invoice's payment page (stripe.ts payLinkForQuote). */
  payUrl?: string | null;
};

/**
 * Email a draft or sent quote, with its PDF where one can be printed (a
 * print that fails sends without it), and mark it sent only once the sender
 * took it. Only for a quote the owner said yes to sending.
 */
export async function sendQuote(db: Db, qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions, how: SendQuote): Promise<{ sent: Sent; pdf: boolean; printError: string | null }> {
  if (qt.status !== "draft" && qt.status !== "sent") return { sent: { status: "none", why: `the quote is ${qt.status}` }, pdf: false, printError: null };
  const msg = quoteMessage(qt, rates, o, how.payUrl);
  let pdf: Uint8Array | null = null;
  let printError: string | null = null;
  if (how.print) {
    try {
      pdf = await how.print(quoteHtml(qt, rates, o, how.payUrl));
    } catch (e) {
      printError = (e as Error).message;
    }
  }
  const sent = await how.send({
    to: [qt.email], subject: msg.subject, text: msg.text, replyTo: how.replyTo,
    attachments: pdf ? [{ filename: `Quote ${qt.number}.pdf`, content: pdf, contentType: "application/pdf" }] : undefined,
  });
  if (sent.status === "sent") await markSent(db, qt.id, how.by);
  return { sent, pdf: !!pdf, printError };
}
