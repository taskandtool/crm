// A quote or an invoice as the customer sees it: a standalone HTML document (the preview,
// and what reports/print.ts turns into the PDF) and the email that carries
// it. Both read the stored lines and totals; nothing is recomputed here but
// the per-rate tax summary, which adds stored line taxes.
//
//   const html = quoteHtml(quote, rates, { business: "Acme Plumbing" });
//   const { subject, text } = quoteMessage(quote, rates, { business: "Acme Plumbing" });
//   const withLink = quoteMessage(quote, rates, { business: "Acme Plumbing", word: "Proposal" }, "https://…/q/…");
import type { Db } from "../data/db";
import type { Email, Sent } from "../data/send";
import { formatMoney } from "../payments/money";
import { percentText, type TaxRate } from "../payments/tax";
import type { SavedLine } from "./lines";
import type { Invoice } from "./invoices";
import { markSent, type Quote } from "./quotes";

/**
 * The business's name, and its zone: the quote's date is the day it is there.
 * `word` is what the business calls a quote ("Quote", "Proposal", "Estimate").
 */
export type DocOptions = { business: string; timeZone?: string; locale?: string; word?: string };

/** "2026-11-30" as "November 30, 2026"; the date is a calendar day, read in UTC. */
export function dayText(day: string | null, locale = "en-US"): string {
  if (!day) return "";
  const d = new Date(day + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "long" }).format(d);
}

/** Today in the business's zone, as YYYY-MM-DD. */
export function todayIn(zone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A YYYY-MM-DD calendar day `n` days on. */
/** A real day as YYYY-MM-DD ("2026-02-30" is not one). */
export const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
export const addDays = (day: string, n: number): string => new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

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

/**
 * The email that sends a quote. With its `link` (the page the customer reads
 * and accepts), a short note that points there; without, every line in the
 * body, so it stands without the PDF.
 */
export function quoteMessage(qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions, link?: string | null): { subject: string; text: string } {
  const m = (c: string | number) => formatMoney(c, qt.currency, o.locale);
  const word = o.word ?? "Quote";
  const subject = `${word} ${qt.number}${o.business ? ` from ${o.business}` : ""}`;
  if (link) {
    const short = [
      `Hello${qt.name ? " " + qt.name : ""},`,
      "",
      `Here is our ${word.toLowerCase()} ${qt.number} for ${m(qt.total_cents)}.`,
      "",
      `Review and accept your ${word.toLowerCase()}: ${link}`,
      ...(qt.valid_until ? ["", `It is open until ${dayText(qt.valid_until, o.locale)}.`] : []),
      ...(qt.notes ? ["", qt.notes] : []),
      "",
      "Reply to this email with any questions.",
      ...(o.business ? ["", o.business] : []),
    ];
    return { subject, text: short.join("\n") };
  }
  const lines = qt.lines.map((l) => `  ${l.description}: ${qty(l)}${m(l.unit_cents)} = ${m(l.amount_cents)}`);
  const taxes = taxSummary(qt.lines, rates).map((t) => `  ${t.label}${t.inclusive ? " (included)" : ""}: ${m(t.cents)}`);
  const body = [
    `Hello${qt.name ? " " + qt.name : ""},`,
    "",
    `Here is our ${word.toLowerCase()} ${qt.number} for ${m(qt.total_cents)}.`,
    "",
    ...lines,
    "",
    ...(taxes.length ? [`  Subtotal: ${m(qt.subtotal_cents)}`, ...taxes] : []),
    `  Total: ${m(qt.total_cents)}`,
    ...(qt.valid_until ? ["", `Valid until ${dayText(qt.valid_until, o.locale)}.`] : []),
    ...(qt.notes ? ["", qt.notes] : []),
    ...(qt.terms ? ["", qt.terms] : []),
    "",
    "To accept, reply to this email.",
    ...(o.business ? ["", o.business] : []),
  ];
  return { subject, text: body.join("\n") };
}

// Print styles: plain greys on white, sized for A4 and Letter alike.
const STYLE = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: rgb(24 24 27); background: rgb(244 244 245); }
  main { max-width: 800px; margin: 24px auto; padding: 40px; background: white; border: 1px solid rgb(228 228 231); border-radius: 12px; }
  .note { max-width: 800px; margin: 24px auto 0; padding: 10px 14px; border-radius: 8px; background: rgb(239 246 255); color: rgb(30 64 175); font-size: 13px; }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; padding-bottom: 24px; border-bottom: 1px solid rgb(228 228 231); }
  .biz { font-size: 20px; font-weight: 700; margin: 0; }
  .kind { text-align: right; }
  .kind .label { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: rgb(113 113 122); }
  .kind .number { font-size: 20px; font-weight: 700; }
  .parties { display: flex; justify-content: space-between; gap: 24px; padding: 24px 0; }
  .parties h2 { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: rgb(113 113 122); margin: 0 0 6px; }
  .to { white-space: pre-line; }
  dl { display: grid; grid-template-columns: auto auto; gap: 4px 16px; margin: 0; text-align: right; }
  dt { color: rgb(113 113 122); }
  dd { margin: 0; font-weight: 500; }
  .due { font-size: 18px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: rgb(113 113 122); background: rgb(250 250 250); border-bottom: 1px solid rgb(228 228 231); padding: 8px; }
  td { padding: 10px 8px; border-bottom: 1px solid rgb(228 228 231); vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 300px; margin-top: 16px; }
  .totals td { border: 0; padding: 4px 8px; }
  .total td { font-size: 16px; font-weight: 700; border-top: 1px solid rgb(161 161 170); padding-top: 8px; }
  .pay { margin-top: 24px; text-align: right; }
  .pay a, .pay span { display: inline-block; padding: 10px 18px; border-radius: 8px; background: rgb(37 99 235); color: white; font-weight: 600; text-decoration: none; }
  .pay span { opacity: .55; }
  .text { white-space: pre-wrap; margin-top: 24px; }
  .muted { color: rgb(113 113 122); }
  @media print { body { background: white; } main { border: 0; margin: 0; padding: 0; } .note { display: none; } }
  @media (max-width: 600px) { main { margin: 0; padding: 20px; border-radius: 0; } header, .parties { flex-direction: column; } .kind, dl { text-align: left; } .totals { width: 100%; } }
`;

type Paper = {
  /** "Invoice", or what the business calls a quote. */
  kind: string;
  number: string | null;
  to: string;
  facts: [string, string][];
  /** The figure the customer looks for: the total, or what is due. */
  headline: [string, string];
  currency: string;
  lines: SavedLine[];
  subtotal: string | number;
  total: string | number;
  rates: TaxRate[];
  o: DocOptions;
  /** A Pay button: its link, or the words for one Stripe adds on sending. */
  pay?: { href: string | null; text: string };
  notes?: string | null;
  terms?: string | null;
  /** Above the paper on screen, never printed: what this preview is. */
  note?: string;
};

/**
 * A quote or an invoice on one sheet, as Stripe's and Jobber's lay theirs
 * out: who it is from and what it is, who it is for beside its dates and
 * the amount, the lines, the totals (tax only when there is some), a Pay
 * button, then the message and terms.
 */
function Paper(p: Paper) {
  const m = (c: string | number) => formatMoney(c, p.currency, p.o.locale);
  const taxes = taxSummary(p.lines, p.rates);
  const name = `${p.kind}${p.number ? ` ${p.number}` : ""}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{p.o.business ? `${name}, ${p.o.business}` : name}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        {p.note ? <p class="note">{p.note}</p> : null}
        <main>
          <header>
            <p class="biz">{p.o.business || " "}</p>
            <div class="kind">
              <div class="label">{p.kind}</div>
              <div class="number">{p.number ?? "Draft"}</div>
            </div>
          </header>
          <section class="parties">
            <div>
              <h2>{p.kind === "Invoice" ? "Bill to" : "For"}</h2>
              <div class="to">{p.to}</div>
            </div>
            <dl>
              {p.facts.map(([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>)}
              <dt>{p.headline[0]}</dt><dd class="due">{p.headline[1]}</dd>
            </dl>
          </section>
          <table>
            <thead>
              <tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr>
            </thead>
            <tbody>
              {p.lines.map((l) => (
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
              {taxes.length ? <tr><td>Subtotal</td><td class="num">{m(p.subtotal)}</td></tr> : null}
              {taxes.map((t) => (
                <tr><td>{t.label}{t.inclusive ? " (included)" : ""}</td><td class="num">{m(t.cents)}</td></tr>
              ))}
              <tr class="total"><td>Total</td><td class="num">{m(p.total)}</td></tr>
            </tbody>
          </table>
          {p.pay ? <p class="pay">{p.pay.href ? <a href={p.pay.href}>{p.pay.text}</a> : <span>{p.pay.text}</span>}</p> : null}
          {p.notes ? <div class="text">{p.notes}</div> : null}
          {p.terms ? <div class="text muted">{p.terms}</div> : null}
        </main>
      </body>
    </html>
  );
}

export function QuoteDocument({ qt, rates, o }: { qt: Quote & { lines: SavedLine[] }; rates: TaxRate[]; o: DocOptions }) {
  return (
    <Paper kind={o.word ?? "Quote"} number={qt.number} to={[qt.name, qt.email, qt.phone, qt.address].filter(Boolean).join("\n")}
      facts={[["Date", dayText(todayIn(o.timeZone ?? "UTC", qt.sent_at ?? qt.created_at), o.locale)], ...(qt.valid_until ? [["Valid until", dayText(qt.valid_until, o.locale)] as [string, string]] : [])]}
      headline={["Total", formatMoney(qt.total_cents, qt.currency, o.locale)]}
      currency={qt.currency} lines={qt.lines} subtotal={qt.subtotal_cents} total={qt.total_cents} rates={rates} o={o}
      notes={qt.notes} terms={qt.terms} />
  );
}

/**
 * An invoice as its customer will read it. A draft is a preview: Stripe makes
 * and emails the real one in its own layout (the owner's Stripe branding),
 * with these lines, totals and message and its own Pay button.
 */
export function InvoiceDocument({ inv, rates, o }: { inv: Invoice & { lines: SavedLine[] }; rates: TaxRate[]; o: DocOptions }) {
  const sent = inv.sent_at ?? null;
  const day = todayIn(o.timeZone ?? "UTC", sent ?? new Date());
  const due = inv.due_date ?? addDays(day, inv.days_until_due);
  const paid = inv.status === "paid";
  // Only one that can still be paid shows what is due and a Pay button; a void or written-off one shows its total.
  const payable = inv.status === "draft" || inv.status === "open";
  return (
    <Paper kind="Invoice" number={inv.number} to={[inv.name, inv.email, inv.phone, inv.address].filter(Boolean).join("\n")}
      facts={[["Date", dayText(day, o.locale)], ["Due", dayText(due, o.locale)]]}
      headline={[paid ? "Paid" : payable ? "Amount due" : "Total", formatMoney(inv.total_cents, inv.currency, o.locale)]}
      currency={inv.currency} lines={inv.lines} subtotal={inv.subtotal_cents} total={inv.total_cents} rates={rates} o={o}
      pay={payable ? { href: inv.hosted_url, text: "Pay online" } : undefined} notes={inv.notes}
      note={sent ? undefined : "A preview. Stripe emails the invoice in its own layout, with your Stripe branding: these lines, totals and message, and a Pay online button that opens its payment page."} />
  );
}

/** The whole document as text, for the preview route and the printer. */
export const quoteHtml = (qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions): string =>
  "<!doctype html>" + (<QuoteDocument qt={qt} rates={rates} o={o} />).toString();

/** An invoice's preview as text. */
export const invoiceHtml = (inv: Invoice & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions): string =>
  "<!doctype html>" + (<InvoiceDocument inv={inv} rates={rates} o={o} />).toString();

export type SendQuote = {
  /** Delivers the email; never throws (data/send.ts's sendEmail). */
  send: (mail: Email) => Promise<Sent>;
  /** The PDF of the document's HTML, or null where nothing can print. */
  print?: (html: string) => Promise<Uint8Array | null>;
  /** The document to print, when the app has its own (the CRM's proposal); default quoteHtml. */
  html?: string;
  /** Where replies go: the team member sending it. */
  replyTo: string | null;
  by: string;
  /** The page the customer reads and accepts the quote at: the email points there and attaches nothing. */
  link?: string | null;
};

/**
 * Email a draft or sent quote, with its PDF where one can be printed (a
 * print that fails sends without it) unless it goes as a link, and mark it
 * sent only once the sender took it. Only for a quote the owner said yes to
 * sending.
 */
export async function sendQuote(db: Db, qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], o: DocOptions, how: SendQuote): Promise<{ sent: Sent; pdf: boolean; printError: string | null }> {
  if (qt.status !== "draft" && qt.status !== "sent") return { sent: { status: "none", why: `the quote is ${qt.status}` }, pdf: false, printError: null };
  const msg = quoteMessage(qt, rates, o, how.link);
  let pdf: Uint8Array | null = null;
  let printError: string | null = null;
  if (how.print && !how.link) {
    try {
      pdf = await how.print(how.html ?? quoteHtml(qt, rates, o));
    } catch (e) {
      printError = (e as Error).message;
    }
  }
  const sent = await how.send({
    to: [qt.email], subject: msg.subject, text: msg.text, replyTo: how.replyTo,
    attachments: pdf ? [{ filename: `${o.word ?? "Quote"} ${qt.number}.pdf`, content: pdf, contentType: "application/pdf" }] : undefined,
  });
  if (sent.status === "sent") await markSent(db, qt.id, how.by);
  return { sent, pdf: !!pdf, printError };
}
