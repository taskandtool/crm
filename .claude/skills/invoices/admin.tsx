// The team's side of quotes and invoices, private (teamOnly): the quotes list,
// a quote's page, the editor, the preview, sending through the owner's own
// sender, the customer's answer; invoices, drafted here and sent, paid out of
// band, voided or written off through Stripe; and the tax rates. Built on
// admin/; every form works without JavaScript, and a GET never sends,
// charges or changes anything: each of those is a POST from a page that says
// exactly what will happen.
//
//   app.route("/invoices", invoicesAdmin(getDb, { base: "/invoices", css: "/site.css", source: "crm", timeZone, business: "Acme" }));
//
// `send` and `print` are how a quote leaves: `send` defaults to the owner's
// connected sender (data/send.ts); `print` makes the PDF and exists only on
// the machine (reports/print.ts). Without it, the email carries the lines.
// An invoice leaves through `stripe` (payments/stripe.ts), and Stripe emails it.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { FieldList, Section } from "../admin/detail";
import { alertClass, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { cut, readCursor } from "../admin/keyset";
import { sectionPages, type Frame, type NavItem } from "../admin/layout";
import { DataTable, EmptyState, NoMatches, SearchBar, SetupNeeded, TableRows, When, type TableSpec } from "../admin/list";
import { idParam, isPartial, listUrl, str } from "../admin/query";
import { buttonClass, controlClass, FieldError, fieldClass, primaryClass, Select, StatusBadge, type StatusOption } from "../admin/status";
import type { GetDb } from "../data/db";
import { envOf } from "../data/env";
import { senderOf, sendEmail, type Email, type Sent } from "../data/send";
import { formatMoney } from "../payments/money";
import { stripeConnected, stripeFrom, type Stripe } from "../payments/stripe";
import { addDays, invoiceHtml, quoteHtml, quoteMessage, sendQuote, taxSummary, todayIn } from "./document";
import { createTaxRate, percentText, setTaxRateActive, taxRates, type TaxRate } from "../payments/tax";
import { amountInput, type Errors, type SavedLine } from "./lines";
import {
  copyQuote, createQuote, decideQuote, expireQuote, markSent, QUOTE_STATUSES, QUOTE_STATUS_LABELS, quoteById, quotesPage, saveQuote, shownStatus,
  type Quote, type QuoteRow, type QuoteStatus,
} from "./quotes";
import {
  createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, invoicesPage, INVOICE_STATUSES, INVOICE_STATUS_LABELS, invoiceTotals, pastDue, saveInvoice,
  type Invoice, type InvoiceRow, type InvoiceStatus,
} from "./invoices";
import { closePayLink, markPaidOutOfBand, markUncollectible, payLinkForQuote, sendInvoice, voidInvoice } from "./stripe";

type Ctx = Context<{ Variables: TeamVars }>;
export type { Frame } from "../admin/layout";
/** What went out, and to whom. */
export type SentDoc = { kind: "quote" | "invoice"; id: string; email: string };

export type InvoicesAdminOptions = {
  base: string;
  css: string;
  /** This app's slug, stored on what it makes. */
  source: string;
  /** The business's zone: "today" for valid-until dates. */
  timeZone: string;
  /** The business's name, at the top of every quote and in its email; "" leaves it off. */
  business: string;
  /** A new quote's currency; default usd. */
  currency?: string;
  /** Standing terms a new quote starts with ("Payment due within 14 days of the work."). */
  terms?: string | null;
  nav?: NavItem[];
  pageSize?: number;
  /** The app's own page frame (the CRM's layout and nav) instead of AdminLayout. */
  Frame?: Frame;
  /** How a quote is emailed; default the owner's connected sender. Never throws (a failure is a `failed` Sent). */
  send?: (c: Ctx, mail: Email) => Promise<Sent>;
  /** A PDF of the document's HTML, or null when this runtime cannot print (production). */
  print?: (c: Ctx, html: string) => Promise<Uint8Array | null>;
  /**
   * The app's own records in a quote's or an invoice's Details, as Stripe
   * shows them: the customer's name links to their record, and the lines
   * after it (the CRM's request and event). No card of its own,
   * so the customer shows once.
   */
  links?: (c: Ctx, doc: { kind: "quote"; quote: Quote } | { kind: "invoice"; invoice: Invoice }) => Promise<DocLinks>;
  /** After a quote or an invoice goes to its customer (sent, or marked sent): the CRM counts it as contact. Throwing shows nothing; the send stands. */
  afterSend?: (c: Ctx, doc: SentDoc) => Promise<void>;
  /** After a person marks a quote accepted or declined here: the CRM wins the deal it is for. Throwing shows nothing; the answer stands. */
  afterDecide?: (c: Ctx, qt: Quote) => Promise<void>;
  /** Days a new invoice gives to pay; default 30. */
  daysUntilDue?: number;
  /** The Stripe caller; default stripeFrom(envOf(c)), the owner's connected account. */
  stripe?: (c: Ctx) => Stripe;
};

const INVOICE_OPTIONS: StatusOption[] = INVOICE_STATUSES.map((s) => ({
  value: s,
  label: INVOICE_STATUS_LABELS[s],
  tone: s === "paid" ? "accent" : s === "open" ? "strong" : s === "draft" ? "neutral" : "muted",
}));
/** An open invoice past its due date shows as Past due ("due"), as the list's filter names it. */
/** What `links` gives a document's Details. */
export type DocLinks = { customer?: string | null; more?: { label: string; value: Child }[] };

/** Who a document is for, as Details lists them: the name (a link to their record, when the app has one), email, phone. */
function Party({ doc, href }: { doc: { name: string | null; email: string; phone: string | null }; href?: string | null }) {
  const first = doc.name ?? doc.email;
  return (
    <>
      {href ? <a href={href}>{first}</a> : first}
      {doc.name ? <><br /><span class="break-all">{doc.email}</span></> : null}
      {doc.phone ? <><br />{doc.phone}</> : null}
    </>
  );
}

export const SHOWN_INVOICE: StatusOption[] = [...INVOICE_OPTIONS, { value: "due", label: "Past due", tone: "late" }];

/** What is owed, how much of it is late, and what came in this month: each a link to the invoices behind it. */
function Totals({ totals, currency, base }: { totals: Awaited<ReturnType<typeof invoiceTotals>>; currency: string; base: string }) {
  const whole = (cents: string) => formatMoney(cents, currency).replace(/\.00$/, "");
  const count = (n: number) => (n === 1 ? "1 invoice" : `${n} invoices`);
  const figure = (href: string, value: string, label: string, sub: string) => (
    <a href={href} class="flex min-w-0 flex-col rounded-card border border-line bg-surface px-3 py-3 no-underline shadow-card hover:border-line-strong sm:px-4">
      <span class="break-words font-semibold text-ink sm:text-title">{value}</span>
      <span class="text-label text-ink-2">{label}</span>
      <span class="hidden text-label text-ink-3 sm:block">{sub}</span>
    </a>
  );
  // One row on a phone too, as Stripe's own figures, so the list starts on the first screen.
  return (
    <div class="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
      {figure(listUrl(base, { status: "open" }), whole(totals.open.cents), "Outstanding", count(totals.open.count))}
      {figure(listUrl(base, { status: "due" }), whole(totals.due.cents), "Past due", totals.due.count ? count(totals.due.count) : "None late")}
      {figure(listUrl(base, { status: "paid" }), whole(totals.paid.cents), "Paid this month", "Through Stripe and marked paid")}
    </div>
  );
}

/** A record's foot: when it was made and by whom, and its rare actions as quiet links. */
function RecordFoot({ made, by, timeZone, children }: { made: Date; by: string | null; timeZone: string; children?: Child }) {
  return (
    <div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-label text-ink-3">
      <p>Made <When at={made} timeZone={timeZone} />{by ? ` by ${by}` : ""}</p>
      {children}
    </div>
  );
}
/** A quiet action in a record's foot: a POST, or a link to a page that says what will happen. */
const footLink = "text-ink-2 underline decoration-line-strong underline-offset-2 hover:decoration-current";

export const QUOTE_OPTIONS: StatusOption[] = QUOTE_STATUSES.map((s) => ({
  value: s,
  label: QUOTE_STATUS_LABELS[s],
  tone: s === "accepted" ? "accent" : s === "sent" ? "strong" : s === "draft" ? "neutral" : "muted",
}));

const MESSAGES: FlashMessages = {
  created: "Quote made. Preview it, then send it.",
  saved: "Saved.",
  sent: "Sent.",
  "sent-no-pdf": "Sent, with the lines in the email: the PDF could not be made.",
  "marked-sent": "Marked as sent.",
  accepted: "Marked accepted.",
  declined: "Marked declined.",
  expired: "Marked expired.",
  copied: "A new draft, copied from the quote.",
  "not-now": "Not from its current status. Nothing changed.",
  "invoice-created": "Invoice drafted. Check it, then send it with Stripe.",
  "invoice-sent": "Sent. Stripe emailed the invoice from your Stripe account.",
  discarded: "Discarded. It stays on record as void.",
  "asked-paid": "Stripe has it as paid. The invoice turns paid here when Stripe confirms, usually within seconds.",
  "asked-void": "Stripe is voiding it. It turns void here when Stripe confirms.",
  "asked-uncollectible": "Stripe has it written off. It changes here when Stripe confirms.",
  invoiced: "This quote already has an invoice: here it is.",
  "rate-added": "Tax rate added.",
  "rate-saved": "Saved.",
  gone: "That is no longer there.",
};



/**
 * The form's repeated line fields as rows, by index. Tax is one choice for
 * the whole document (`tax`, as Jobber's): it goes on every line that has
 * something on it. "mixed" keeps each line's own (one the AI made per line).
 */
function formLines(body: Record<string, unknown>): { description: string; quantity: string; unit: string; tax_rate_id: string }[] {
  const all = (k: string) => {
    const v = body[k];
    return Array.isArray(v) ? v.map(str) : v === undefined ? [] : [str(v)];
  };
  const d = all("description"), q = all("quantity"), u = all("unit"), t = all("tax_rate_id");
  const tax = str(body.tax);
  return Array.from({ length: Math.min(Math.max(d.length, q.length, u.length), 200) }, (_, i) => ({
    description: d[i] ?? "", quantity: q[i] ?? "", unit: u[i] ?? "",
    tax_rate_id: tax === "mixed" ? (t[i] ?? "") : (d[i] ?? "").trim() || (u[i] ?? "").trim() ? tax : "",
  }));
}

/** The one tax a document's lines share: "" for none, a rate's id, or "mixed" when the lines differ. */
function docTax(lines: { tax_rate_id: string }[]): string {
  const ids = new Set(lines.map((l) => l.tax_rate_id));
  return ids.size > 1 ? "mixed" : ([...ids][0] ?? "");
}

type FormValues = {
  email: string; name: string; phone: string; address: string; currency: string; valid_until: string; notes: string; terms: string;
  days_until_due: string; visit_id: string; deal_id: string; lines: { description: string; quantity: string; unit: string; tax_rate_id: string }[];
};

function readForm(body: Record<string, unknown>): FormValues {
  return {
    email: str(body.email), name: str(body.name), phone: str(body.phone), address: str(body.address), currency: str(body.currency),
    valid_until: str(body.valid_until), notes: str(body.notes), terms: str(body.terms), days_until_due: str(body.days_until_due),
    visit_id: str(body.visit_id), deal_id: str(body.deal_id), lines: formLines(body),
  };
}

/** A document's lines as the form shows them. */
const linesOf = (d: { currency: string; lines: SavedLine[] }) =>
  d.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: amountInput(l.unit_cents, d.currency), tax_rate_id: l.tax_rate_id ?? "" }));

export function invoicesAdmin(getDb: GetDb, opts: InvoicesAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const qbase = `${base}/quotes`;
  const size = opts.pageSize ?? 50;
  const links = opts.nav ?? [
    { href: qbase, label: "Quotes" },
    { href: base, label: "Invoices" },
  ];
  const stripeOf = opts.stripe ?? ((c: Ctx) => stripeFrom(envOf(c)));
  const doc = { business: opts.business, timeZone: opts.timeZone };
  const send = opts.send ?? ((c: Ctx, mail: Email) => sendEmail(envOf(c), mail));
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  const framed = sectionPages({ Frame: opts.Frame, css: opts.css, label: "Quotes and invoices", links, messages: MESSAGES });
  const back = (c: Ctx, path: string, code: string) => c.redirect(withFlash(path, code), 303);
  // What sending needs: the owner's Stripe for invoices (and a quote's Pay button), their email for quotes.
  // A caller passed in (a test, another app) counts as there; null (Stripe not reachable just now) is not a no.
  const stripeReady = async (c: Ctx) => (opts.stripe ? true : (await stripeConnected(envOf(c))) !== false);
  const emailReady = (c: Ctx) => !!opts.send || typeof senderOf(envOf(c)) !== "string";
  const needStripe = (
    <SetupNeeded title="Connect Stripe to send invoices" ask="Connect my Stripe account so I can send invoices.">
      Invoices are made in your own Stripe account, which emails them with a Pay button and tells this app when they are paid.
      Make sure Stripe is connected to this app in Task & Tool, on the app's Connections tab. You can write drafts now; sending waits for Stripe.
    </SetupNeeded>
  );
  const needEmail = (
    <SetupNeeded title="Connect your email to send quotes" ask="Connect my email so I can send quotes.">
      Quotes go out from your own email address. Make sure an email sender is connected to this app in Task & Tool, on the app's Connections tab.
      You can write and preview quotes now, or send the text yourself and mark them sent.
    </SetupNeeded>
  );
  const money = (cents: string | number, currency: string) => formatMoney(cents, currency);

  // ---- quotes --------------------------------------------------------------

  const spec: TableSpec<QuoteRow> = {
    id: "quotes",
    href: (r) => `${qbase}/${r.id}`,
    columns: [
      { label: "Quote", cell: (r) => <span class="whitespace-nowrap">{r.number}</span> },
      { label: "Customer", cell: (r) => r.name ?? r.email },
      { label: "Total", cell: (r) => money(r.total_cents, r.currency), class: "text-right" },
      { label: "Status", cell: (r) => <StatusBadge value={shownStatus(r, todayIn(opts.timeZone))} options={QUOTE_OPTIONS} /> },
      { label: "Created", cell: (r) => <When at={r.created_at} timeZone={opts.timeZone} />, class: "hidden sm:table-cell" },
    ],
  };

  app.get("/quotes", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100) || null;
    const asked = c.req.query("status");
    const status = QUOTE_STATUSES.includes(asked as QuoteStatus) ? (asked as QuoteStatus) : null;
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await quotesPage(getDb(c), { q, status }, after, size, todayIn(opts.timeZone)), size);
    const params = { q, status };
    const self = listUrl(qbase, params);
    const more = (cur: string) => listUrl(qbase, { ...params, after: cur });
    if (isPartial(c) && after) return c.html(<TableRows spec={spec} rows={page} next={next} more={more} />);
    const results = (
      <div id="results">
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the start</a></p> : null}
        <DataTable spec={spec} caption="Quotes, newest first" rows={page} next={next} more={more}
          empty={q || status ? <NoMatches clear={qbase} /> : (
            <EmptyState title="No quotes yet." action={<a href={`${qbase}/new`} class={primaryClass}>New quote</a>}>
              A quote is the price you send before the work. Once it is accepted, invoice it.
            </EmptyState>
          )} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    return framed(c, qbase, { title: "Quotes", actions: <a href={`${qbase}/new`} class={primaryClass}>New quote</a> }, (
      <>
        {emailReady(c) ? null : needEmail}
        <SearchBar action={qbase} target="#results" q={q} placeholder="Search quotes"
          filters={[{ name: "status", label: "Status", options: QUOTE_OPTIONS, value: status, any: "Any status" }]} />
        {results}
      </>
    ));
  });

  const editor = async (c: Ctx, p: { title: string; action: string; values: FormValues; errors: Errors; current: string }, status = 200) => {
    const rates = await taxRates(getDb(c));
    return framed(c, p.current, p.title, <DocForm kind="quote" action={p.action} v={p.values} errors={p.errors} rates={rates} cancel={p.current} submit={p.action === qbase ? "Create quote" : "Save"} taxPage={`${base}/tax-rates`} currency={opts.currency} />, status);
  };

  // Prefilled from the query: a customer's page or an appointment hands over who, and the first line.
  app.get("/quotes/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const currency = (qy("currency") || opts.currency || "usd").toLowerCase();
    const values: FormValues = {
      email: qy("email"), name: qy("name"), phone: qy("phone"), address: qy("address"), currency,
      valid_until: addDays(todayIn(opts.timeZone), 30), notes: "", terms: opts.terms ?? "", days_until_due: "", visit_id: qy("event"), deal_id: qy("deal"),
      lines: qy("line") ? [{ description: qy("line"), quantity: "1", unit: qy("unit"), tax_rate_id: "" }] : [],
    };
    return editor(c, { title: "New quote", action: qbase, values, errors: {}, current: qbase });
  });

  app.post("/quotes", async (c) => {
    const values = readForm(await c.req.parseBody({ all: true }));
    const r = await createQuote(getDb(c), values, c.get("user"), opts.source);
    if (!r.ok) return editor(c, { title: "New quote", action: qbase, values, errors: r.errors, current: qbase }, 422);
    return back(c, `${qbase}/${r.value.id}`, "created");
  });

  const load = async (c: Ctx) => {
    const id = idParam(c.req.param("id"));
    return id ? quoteById(getDb(c), id) : null;
  };

  app.get("/quotes/:id", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    const rates = await taxRates(getDb(c));
    const self = `${qbase}/${qt.id}`;
    const shown = shownStatus(qt, todayIn(opts.timeZone));
    const open = qt.status === "draft" || qt.status === "sent" || qt.status === "expired";
    const linked = opts.links ? await opts.links(c, { kind: "quote", quote: qt }) : {};
    const invoices = (await invoicesFor(getDb(c), { quoteId: qt.id })).filter((i) => i.status !== "void");
    return framed(c, qbase, {
      title: `Quote ${qt.number}`,
      back: { href: qbase, label: "Quotes" },
      sub: (
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge value={shown} options={QUOTE_OPTIONS} />
          <span>{qt.name ?? qt.email} · {money(qt.total_cents, qt.currency)}</span>
        </p>
      ),
      actions: (
        <>
          {qt.status === "draft" ? <a href={`${self}/edit`} class={buttonClass}>Edit</a> : null}
          <a href={`${self}/document`} class={buttonClass} target="_blank">Preview</a>
          {qt.status === "draft" || qt.status === "sent" ? (
            <a href={`${self}/send`} class={primaryClass}>{qt.status === "sent" ? "Send again" : "Send"}</a>
          ) : null}
        </>
      ),
    }, (
      <>
        {c.req.query("problem") ? <p role="alert" class={"mb-4 " + alertClass}>{c.req.query("problem")}</p> : null}
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Line items">
              <Lines qt={qt} rates={rates} />
            </Section>
            {qt.notes || qt.terms ? (
              <Section title="Notes and terms">
                {qt.notes ? <p class="whitespace-pre-wrap break-words">{qt.notes}</p> : null}
                {qt.terms ? <p class="mt-2 whitespace-pre-wrap break-words text-ink-2">{qt.terms}</p> : null}
              </Section>
            ) : null}
          </div>
          <div class="flex flex-col gap-4">
            {open ? (
              <Section title="Their answer">
                <p class="mb-3 text-label text-ink-3">When they say yes or no, by reply or on the phone.</p>
                <div class="flex flex-wrap gap-2">
                  <form method="post" action={`${self}/decide`}><input type="hidden" name="answer" value="accepted" /><button class={buttonClass}>Mark accepted</button></form>
                  <form method="post" action={`${self}/decide`}><input type="hidden" name="answer" value="declined" /><button class={buttonClass}>Mark declined</button></form>
                  {qt.status !== "expired" ? <form method="post" action={`${self}/expire`}><button class={buttonClass}>Mark expired</button></form> : null}
                </div>
              </Section>
            ) : null}
            {qt.status === "accepted" ? (
              <Section title="Invoice">
                {invoices.length ? (
                  invoices.map((i) => <p class="flex flex-wrap items-center gap-2"><a href={`${base}/${i.id}`}>{i.number ? `Invoice ${i.number}` : "Draft invoice"}</a>{i.number ? <StatusBadge value={i.status} options={INVOICE_OPTIONS} /> : null}</p>)
                ) : (
                  <form method="post" action={`${self}/invoice`}><button class={primaryClass}>Make the invoice</button></form>
                )}
              </Section>
            ) : null}
            <Section title="Details">
              <FieldList fields={[
                { label: "Customer", value: <Party doc={qt} href={linked.customer} /> },
                { label: "Address", value: qt.address },
                { label: "Valid until", value: qt.valid_until ? <When at={`${qt.valid_until}T00:00:00Z`} timeZone="UTC" day /> : null },
                { label: "Sent", value: qt.sent_at ? <When at={qt.sent_at} timeZone={opts.timeZone} /> : null },
                { label: QUOTE_STATUS_LABELS[qt.status], value: qt.decided_at ? <><When at={qt.decided_at} timeZone={opts.timeZone} />{qt.decided_by ? ` by ${qt.decided_by}` : ""}</> : null },
                ...(linked.more ?? []),
              ]} />
            </Section>
          </div>
        </div>
        <RecordFoot made={qt.created_at} by={qt.created_by} timeZone={opts.timeZone}>
          <form method="post" action={`${self}/copy`}><button class={footLink}>Copy to a new quote</button></form>
        </RecordFoot>
      </>
    ));
  });

  app.get("/quotes/:id/edit", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    if (qt.status !== "draft") return c.redirect(`${qbase}/${qt.id}`, 302);
    const values: FormValues = {
      email: qt.email, name: qt.name ?? "", phone: qt.phone ?? "", address: qt.address ?? "", currency: qt.currency,
      valid_until: qt.valid_until ?? "", notes: qt.notes ?? "", terms: qt.terms ?? "", days_until_due: "", visit_id: qt.visit_id ?? "", deal_id: qt.deal_id ?? "",
      lines: linesOf(qt),
    };
    return editor(c, { title: `Edit quote ${qt.number}`, action: `${qbase}/${qt.id}`, values, errors: {}, current: `${qbase}/${qt.id}` });
  });

  app.post("/quotes/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const values = readForm(await c.req.parseBody({ all: true }));
    const r = await saveQuote(getDb(c), id, values, c.get("user"));
    if (!r.ok) {
      if (r.errors.status && !(await quoteById(getDb(c), id))) return c.notFound();
      return editor(c, { title: "Edit quote", action: `${qbase}/${id}`, values, errors: r.errors, current: `${qbase}/${id}` }, 422);
    }
    return back(c, `${qbase}/${id}`, "saved");
  });

  // The document exactly as it is printed and sent.
  app.get("/quotes/:id/document", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    return c.html(quoteHtml(qt, await taxRates(getDb(c)), doc));
  });

  // What will go to whom. Sending is the POST below; this page never sends.
  app.get("/quotes/:id/send", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    const self = `${qbase}/${qt.id}`;
    if (qt.status !== "draft" && qt.status !== "sent") return c.redirect(self, 302);
    // A Pay button already made (a send that failed after it): the text to copy carries it.
    const payUrl = (await invoicesFor(getDb(c), { quoteId: qt.id })).find((i) => i.status === "open" && i.hosted_url)?.hosted_url ?? null;
    const msg = quoteMessage(qt, await taxRates(getDb(c)), doc, payUrl);
    const problem = c.req.query("problem");
    const [canEmail, canPay] = [emailReady(c), await stripeReady(c)];
    return framed(c, qbase, { title: `Send quote ${qt.number}`, back: { href: self, label: `Quote ${qt.number}` } }, (
      <>
        {problem ? <p role="alert" class={"mb-4 " + alertClass}>{problem}</p> : null}
        {canEmail ? null : needEmail}
        <Section title="The email">
          <FieldList fields={[
            { label: "To", value: <span class="break-all">{qt.email}</span> },
            { label: "Replies go to", value: <span class="break-all">{c.get("user")}</span> },
            { label: "Subject", value: msg.subject },
            { label: "Attached", value: opts.print ? `Quote ${qt.number}.pdf, where this server can print it; the lines are in the email either way` : "Nothing: the lines are in the email" },
          ]} />
          <pre class="mt-3 whitespace-pre-wrap break-words rounded-card border border-line bg-canvas p-3 font-body text-copy">{msg.text}</pre>
          <a href={`${self}/document`} target="_blank" class={buttonClass + " mt-3"}>Preview the quote</a>
          {canEmail ? (
            <form method="post" action={`${self}/send`} class="mt-3 flex flex-col gap-3">
              {canPay ? (
                <label class="flex items-start gap-2">
                  <input type="checkbox" name="pay" value="1" class="mt-1" checked={!!payUrl} />
                  <span>Add a Pay button: Stripe makes the invoice for these lines, the email links to its payment page, and paying it accepts the quote.</span>
                </label>
              ) : null}
              <div><button class={primaryClass}>Send to {qt.email}</button></div>
            </form>
          ) : null}
        </Section>
        <Section title="Sent it yourself?" class="mt-4">
          <p class="mb-2 text-label text-ink-3">If you emailed this text from your own mail, mark the quote sent.</p>
          <form method="post" action={`${self}/sent`}><button class={buttonClass}>Mark as sent</button></form>
        </Section>
      </>
    ));
  });

  // The app's afterSend, when it has one; a failure is logged, never the person's problem.
  const sent = async (c: Ctx, doc: SentDoc) => {
    if (opts.afterSend) await opts.afterSend(c, doc).catch((e) => console.error(`${doc.kind} ${doc.id}: afterSend: ${e instanceof Error ? e.message : e}`));
  };

  app.post("/quotes/:id/send", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    const self = `${qbase}/${qt.id}`;
    if (qt.status !== "draft" && qt.status !== "sent") return back(c, self, "not-now");
    let payUrl: string | null = null;
    if (str((await c.req.parseBody()).pay) === "1") {
      const link = await payLinkForQuote(getDb(c), stripeOf(c), qt.id, c.get("user"), opts.source, opts.daysUntilDue ?? 30);
      if (!link.ok) return c.redirect(listUrl(`${self}/send`, { problem: `Nothing was sent: the Pay button could not be made. ${link.message}` }), 303);
      payUrl = link.url;
    }
    const r = await sendQuote(getDb(c), qt, await taxRates(getDb(c)), doc, {
      payUrl,
      send: (mail) => send(c, mail),
      print: opts.print ? (html) => opts.print!(c, html) : undefined,
      replyTo: c.get("user"),
      by: c.get("user"),
    });
    if (r.printError) console.error(`quote ${qt.number}: the PDF failed: ${r.printError}`);
    if (r.sent.status !== "sent") {
      const problem = r.sent.status === "none"
        ? `Nothing was sent: ${r.sent.why}. Copy the text below into your own email, then mark it sent.`
        : `The email did not go: ${r.sent.error}`;
      return c.redirect(listUrl(`${self}/send`, { problem }), 303);
    }
    await sent(c, { kind: "quote", id: qt.id, email: qt.email });
    return back(c, self, r.printError ? "sent-no-pdf" : "sent");
  });

  app.post("/quotes/:id/sent", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const r = await markSent(getDb(c), id, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (r.ok) await sent(c, { kind: "quote", id, email: r.value.email });
    return back(c, `${qbase}/${id}`, r.ok ? "marked-sent" : "not-now");
  });

  app.post("/quotes/:id/decide", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const answer = str((await c.req.parseBody()).answer);
    if (answer !== "accepted" && answer !== "declined") return back(c, `${qbase}/${id}`, "not-now");
    const r = await decideQuote(getDb(c), id, answer, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (r.ok && opts.afterDecide) await opts.afterDecide(c, r.value).catch((e) => console.error(`quote ${id}: afterDecide: ${e instanceof Error ? e.message : e}`));
    if (r.ok && answer === "declined") {
      const note = await closePayLink(getDb(c), () => stripeOf(c), id, c.get("user"));
      if (note?.startsWith("Its Pay button could not")) return c.redirect(listUrl(`${qbase}/${id}`, { saved: "declined", problem: note }), 303);
    }
    return back(c, `${qbase}/${id}`, r.ok ? answer : "not-now");
  });

  app.post("/quotes/:id/expire", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const r = await expireQuote(getDb(c), id, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
    return back(c, `${qbase}/${id}`, r.ok ? "expired" : "not-now");
  });

  app.post("/quotes/:id/copy", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const copy = await copyQuote(getDb(c), id, c.get("user"), opts.source);
    return copy ? back(c, `${qbase}/${copy.id}/edit`, "copied") : c.notFound();
  });

  // From an accepted quote: its lines, once.
  app.post("/quotes/:id/invoice", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const r = await invoiceFromQuote(getDb(c), id, c.get("user"), opts.source, opts.daysUntilDue ?? 30);
    if (r.ok) return back(c, `${base}/${r.value.id}`, "invoice-created");
    if (r.reason === "not_found") return c.notFound();
    if (r.reason === "invoiced") return back(c, `${base}/${r.invoiceId}`, "invoiced");
    return back(c, `${qbase}/${id}`, "not-now");
  });

  // ---- invoices --------------------------------------------------------------

  const ispec: TableSpec<InvoiceRow> = {
    id: "invoices",
    href: (r) => `${base}/${r.id}`,
    columns: [
      { label: "Invoice", cell: (r) => <span class="whitespace-nowrap">{r.number ?? <span class="text-ink-3">Not sent</span>}</span> },
      { label: "Customer", cell: (r) => r.name ?? r.email },
      { label: "Total", cell: (r) => money(r.total_cents, r.currency), class: "text-right" },
      { label: "Status", cell: (r) => <><StatusBadge value={r.past_due ? "due" : r.status} options={SHOWN_INVOICE} />{r.livemode === false ? <span class="ml-1 text-label text-ink-3">test</span> : null}</> },
      // When it was paid once it is; when it is due while it is open; nothing for a draft or a void.
      { label: "Due", cell: (r) => (r.status === "paid" && r.paid_at ? <>Paid <When at={r.paid_at} timeZone={opts.timeZone} day /></> : r.status === "open" && r.due_date ? <When at={`${r.due_date}T00:00:00Z`} timeZone="UTC" day /> : ""), class: "hidden sm:table-cell" },
    ],
  };

  app.get("/", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100) || null;
    const asked = c.req.query("status");
    const due = asked === "due";
    const status = INVOICE_STATUSES.includes(asked as InvoiceStatus) ? (asked as InvoiceStatus) : null;
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await invoicesPage(getDb(c), { q, status, due }, after, size, todayIn(opts.timeZone)), size);
    const params = { q, status: due ? "due" : status };
    const self = listUrl(base, params);
    const more = (cur: string) => listUrl(base, { ...params, after: cur });
    if (isPartial(c) && after) return c.html(<TableRows spec={ispec} rows={page} next={next} more={more} />);
    const results = (
      <div id="results">
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the start</a></p> : null}
        <DataTable spec={ispec} caption="Invoices, newest first" rows={page} next={next} more={more}
          empty={q || asked ? <NoMatches clear={base} /> : (
            <EmptyState title="No invoices yet." action={<a href={`${base}/new`} class={primaryClass}>New invoice</a>}>
              Send one for finished work, or from an accepted quote. Your customer pays it online.
            </EmptyState>
          )} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const currency = (opts.currency ?? "usd").toLowerCase();
    const totals = after ? null : await invoiceTotals(getDb(c), { today: todayIn(opts.timeZone), timeZone: opts.timeZone, currency });
    return framed(c, base, { title: "Invoices", actions: <a href={`${base}/new`} class={primaryClass}>New invoice</a> }, (
      <>
        {(await stripeReady(c)) ? null : needStripe}
        {totals ? <Totals totals={totals} currency={currency} base={base} /> : null}
        <SearchBar action={base} target="#results" q={q} placeholder="Search invoices"
          filters={[{ name: "status", label: "Status", options: SHOWN_INVOICE, value: params.status, any: "Any status" }]} />
        {results}
      </>
    ));
  });

  const invoiceEditor = async (c: Ctx, p: { title: string; action: string; values: FormValues; errors: Errors; current: string }, status = 200) => {
    const rates = await taxRates(getDb(c));
    return framed(c, base, p.title, <DocForm kind="invoice" action={p.action} v={p.values} errors={p.errors} rates={rates} cancel={p.current} submit={p.action === base ? "Create invoice" : "Save"} taxPage={`${base}/tax-rates`} currency={opts.currency} />, status);
  };

  // Blank, or prefilled from the query: a customer's page or an appointment hands over who, and the first line.
  app.get("/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const values: FormValues = {
      email: qy("email"), name: qy("name"), phone: qy("phone"), address: qy("address"), currency: (qy("currency") || opts.currency || "usd").toLowerCase(),
      valid_until: "", notes: "", terms: "", days_until_due: String(opts.daysUntilDue ?? 30), visit_id: qy("event"), deal_id: "",
      lines: qy("line") ? [{ description: qy("line"), quantity: "1", unit: qy("unit"), tax_rate_id: "" }] : [],
    };
    return invoiceEditor(c, { title: "New invoice", action: base, values, errors: {}, current: base });
  });

  app.post("/", async (c) => {
    const values = readForm(await c.req.parseBody({ all: true }));
    const r = await createInvoice(getDb(c), values, c.get("user"), opts.source);
    if (!r.ok) return invoiceEditor(c, { title: "New invoice", action: base, values, errors: r.errors, current: base }, 422);
    return back(c, `${base}/${r.value.id}`, "invoice-created");
  });

  const loadInvoice = async (c: Ctx) => {
    const id = idParam(c.req.param("id"));
    return id ? invoiceById(getDb(c), id) : null;
  };

  // The invoice as its customer will read it (InvoiceDocument): a preview until Stripe sends it.
  app.get("/:id{[0-9]+}/document", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    return c.html(invoiceHtml(inv, await taxRates(getDb(c)), doc));
  });

  app.get("/:id{[0-9]+}", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    const rates = await taxRates(getDb(c));
    const self = `${base}/${inv.id}`;
    const draft = inv.status === "draft" && !inv.stripe_invoice_id;
    const linked = opts.links ? await opts.links(c, { kind: "invoice", invoice: inv }) : {};
    const quote = inv.quote_id ? await quoteById(getDb(c), inv.quote_id) : null;
    return framed(c, base, {
      title: inv.number ? `Invoice ${inv.number}` : "Draft invoice",
      back: { href: base, label: "Invoices" },
      sub: (
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge value={pastDue(inv, todayIn(opts.timeZone), quote) ? "due" : inv.status} options={SHOWN_INVOICE} />
          <span>{inv.name ?? inv.email} · {money(inv.total_cents, inv.currency)}</span>
          {inv.livemode === false ? <span class="text-label text-ink-3">Stripe test mode: not real money</span> : null}
        </p>
      ),
      // The one thing to do next is the blue one: send a draft; an open one is paid on Stripe's page, or marked paid here.
      actions: (
        <>
          {draft ? <a href={`${self}/edit`} class={buttonClass}>Edit</a> : null}
          {/* Before Stripe has it, our preview; after, Stripe's own PDF below. */}
          {!inv.pdf_url ? <a href={`${self}/document`} target="_blank" class={buttonClass}>Preview</a> : null}
          {inv.status === "draft" || (inv.status === "open" && !inv.sent_at) ? <a href={`${self}/send`} class={primaryClass}>Send invoice</a> : null}
          {inv.hosted_url && inv.status !== "void" ? <a href={inv.hosted_url} target="_blank" rel="noopener" class={buttonClass}>Payment page</a> : null}
          {inv.pdf_url ? <a href={inv.pdf_url} target="_blank" rel="noopener" class={buttonClass}>PDF</a> : null}
          {inv.status === "open" || inv.status === "uncollectible" ? <a href={`${self}/paid`} class={buttonClass}>Mark paid</a> : null}
        </>
      ),
    }, (
      <>
        {inv.payment_failed_at && inv.status === "open" ? (
          <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
            A payment attempt failed <When at={inv.payment_failed_at} timeZone={opts.timeZone} />. The invoice is still open on their payment page.
          </p>
        ) : null}
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Line items">
              <Lines qt={inv} rates={rates} />
            </Section>
            {inv.notes ? <Section title="Message to the customer"><p class="whitespace-pre-wrap break-words">{inv.notes}</p></Section> : null}
          </div>
          <div class="flex flex-col gap-4">
            <Section title="Details">
              <FieldList fields={[
                { label: "Bill to", value: <Party doc={inv} href={linked.customer} /> },
                inv.due_date ? { label: "Due", value: <When at={`${inv.due_date}T00:00:00Z`} timeZone="UTC" day /> } : { label: "Payment due", value: `${inv.days_until_due} ${inv.days_until_due === 1 ? "day" : "days"} after it is sent` },
                { label: "Sent", value: inv.sent_at ? <When at={inv.sent_at} timeZone={opts.timeZone} /> : null },
                { label: "Paid", value: inv.paid_at ? <When at={inv.paid_at} timeZone={opts.timeZone} /> : null },
                { label: "Quote", value: quote ? <a href={`${qbase}/${quote.id}`}>Quote {quote.number}</a> : null },
                ...(linked.more ?? []),
              ]} />
            </Section>
          </div>
        </div>
        <RecordFoot made={inv.created_at} by={inv.created_by} timeZone={opts.timeZone}>
          {draft ? (
            <form method="post" action={`${self}/discard`}><button class={footLink}>Delete draft</button></form>
          ) : null}
          {inv.status === "open" ? <a href={`${self}/uncollectible`} class={footLink}>Write off</a> : null}
          {inv.status === "open" || inv.status === "uncollectible" ? <a href={`${self}/void`} class={footLink}>Void</a> : null}
        </RecordFoot>
      </>
    ));
  });

  app.get("/:id{[0-9]+}/edit", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    if (inv.status !== "draft" || inv.stripe_invoice_id) return c.redirect(`${base}/${inv.id}`, 302);
    const values: FormValues = {
      email: inv.email, name: inv.name ?? "", phone: inv.phone ?? "", address: inv.address ?? "", currency: inv.currency,
      valid_until: "", notes: inv.notes ?? "", terms: "", days_until_due: String(inv.days_until_due), visit_id: inv.visit_id ?? "", deal_id: "", lines: linesOf(inv),
    };
    return invoiceEditor(c, { title: "Edit draft invoice", action: `${base}/${inv.id}`, values, errors: {}, current: `${base}/${inv.id}` });
  });

  app.post("/:id{[0-9]+}", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const values = readForm(await c.req.parseBody({ all: true }));
    const r = await saveInvoice(getDb(c), id, values, c.get("user"));
    if (!r.ok) {
      if (r.errors.status && !(await invoiceById(getDb(c), id))) return c.notFound();
      return invoiceEditor(c, { title: "Edit draft invoice", action: `${base}/${id}`, values, errors: r.errors, current: `${base}/${id}` }, 422);
    }
    return back(c, `${base}/${id}`, "saved");
  });

  app.post("/:id{[0-9]+}/discard", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    return back(c, `${base}/${id}`, (await discardInvoice(getDb(c), id, c.get("user"))) ? "discarded" : "not-now");
  });

  // Each Stripe action: a page that says exactly what will happen, then its POST.
  type Act = { path: string; title: string; allowed: (i: Invoice) => boolean; say: (i: Invoice) => string; button: string;
    run: (c: Ctx, i: Invoice) => Promise<{ ok: true } | { ok: false; message: string }>; done: string };
  const acts: Act[] = [
    {
      path: "send", title: "Send invoice", button: "Send invoice", done: "invoice-sent",
      allowed: (i) => i.status === "draft" || (i.status === "open" && !i.sent_at),
      say: (i) => `Stripe makes this invoice in your Stripe account and emails it to ${i.email}: ${money(i.total_cents, i.currency)}, due ${i.days_until_due} days after it is sent. They pay on Stripe's page. After this the invoice no longer changes here.`,
      run: async (c, i) => sendInvoice(getDb(c), stripeOf(c), i.id, c.get("user")),
    },
    {
      path: "paid", title: "Mark paid", button: "Mark paid", done: "asked-paid",
      allowed: (i) => i.status === "open" || i.status === "uncollectible",
      say: (i) => `For ${money(i.total_cents, i.currency)} paid another way, in cash or by check. Stripe records it as paid outside Stripe; no card is charged. It cannot be undone.`,
      run: (c, i) => markPaidOutOfBand(getDb(c), stripeOf(c), i.id),
    },
    {
      path: "void", title: "Void", button: "Void the invoice", done: "asked-void",
      allowed: (i) => i.status === "open" || i.status === "uncollectible",
      say: (i) => `${i.email} will no longer be able to pay it. It stays on record as void. It cannot be undone.`,
      run: (c, i) => voidInvoice(getDb(c), stripeOf(c), i.id),
    },
    {
      path: "uncollectible", title: "Write off", button: "Write it off", done: "asked-uncollectible",
      allowed: (i) => i.status === "open",
      say: () => "Written off as not going to be paid. It can still be paid later, or voided.",
      run: (c, i) => markUncollectible(getDb(c), stripeOf(c), i.id),
    },
  ];
  for (const act of acts) {
    app.get(`/:id{[0-9]+}/${act.path}`, async (c) => {
      const inv = await loadInvoice(c);
      if (!inv) return c.notFound();
      const self = `${base}/${inv.id}`;
      if (!act.allowed(inv)) return back(c, self, "not-now");
      const problem = c.req.query("problem");
      const ready = await stripeReady(c);
      return framed(c, base, { title: inv.number ? `${act.title}: invoice ${inv.number}` : `${act.title} to ${inv.name || inv.email}`, back: { href: self, label: inv.number ? `Invoice ${inv.number}` : "Draft invoice" } }, (
        <>
          {problem ? <p role="alert" class={"mb-4 " + alertClass}>{problem}</p> : null}
          {ready ? null : needStripe}
          <Section title="What happens" class="max-w-2xl">
            <p class="mb-4 max-w-prose">{act.say(inv)}</p>
            <form method="post" action={`${self}/${act.path}`} class="flex items-center gap-4">
              {ready ? <button class={primaryClass}>{act.button}</button> : null}
              {act.path === "send" ? <a href={`${self}/document`} target="_blank" class={buttonClass}>Preview the invoice</a> : null}
              <a href={self} class="text-label text-ink-2">Cancel</a>
            </form>
          </Section>
        </>
      ));
    });
    app.post(`/:id{[0-9]+}/${act.path}`, async (c) => {
      const inv = await loadInvoice(c);
      if (!inv) return c.notFound();
      const self = `${base}/${inv.id}`;
      if (!act.allowed(inv)) return back(c, self, "not-now");
      if (!(await stripeReady(c))) return c.redirect(`${self}/${act.path}`, 303);
      const r = await act.run(c, inv);
      if (!r.ok) return c.redirect(listUrl(`${self}/${act.path}`, { problem: r.message }), 303);
      if (act.path === "send") await sent(c, { kind: "invoice", id: inv.id, email: inv.email });
      return back(c, self, act.done);
    });
  }

  // ---- tax rates -------------------------------------------------------------

  const ratesPage = async (c: Ctx, errors: Errors = {}, status = 200) => {
    const rates = await taxRates(getDb(c));
    const self = `${base}/tax-rates`;
    // A setting, as Jobber and Stripe keep tax rates: reached from a quote's or invoice's Tax choice, not a tab.
    return framed(c, self, { title: "Tax rates", back: { href: base, label: "Invoices" } }, (
      <>
        <p class="mb-4 max-w-prose text-ink-2">
          Quotes and invoices have no tax unless you choose one under their line items. Add the rates you charge here.
          A rate stays as it is once used; to change a percent, add a new rate and archive the old one.
        </p>
        {rates.length ? (
          <ul class="mb-6 flex flex-col gap-2">
            {rates.map((r) => (
              <li class="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface px-3 py-2">
                <span>
                  <span class="font-semibold">{r.name}</span> {percentText(r.percent_bp)}
                  <span class="text-label text-ink-2">{r.inclusive ? " · already in your prices" : " · added on top of your prices"}</span>
                  {r.active ? null : <span class="text-label text-ink-3"> · Archived</span>}
                </span>
                <form method="post" action={`${self}/${r.id}/active`}>
                  <input type="hidden" name="active" value={r.active ? "0" : "1"} />
                  <button class={buttonClass}>{r.active ? "Archive" : "Restore"}</button>
                </form>
              </li>
            ))}
          </ul>
        ) : <p class="mb-6 text-ink-3">No tax rates yet.</p>}
        <Section title="Add a tax rate">
          <form method="post" action={self} class="grid gap-3 sm:grid-cols-3">
            <label class={fieldClass}>Name<input name="name" required maxlength={100} placeholder="Sales tax" class={controlClass} />
              {errors.name ? <span class="text-ink">{errors.name}</span> : null}</label>
            <label class={fieldClass}>Percent<input name="percent" required inputmode="decimal" placeholder="8.25" class={controlClass} />
              {errors.percent ? <span class="text-ink">{errors.percent}</span> : null}</label>
            <label class="flex min-h-9 items-center gap-2 self-end text-ink-2"><input type="checkbox" name="inclusive" class="size-4" /> My prices already include it</label>
            <div class="sm:col-span-3"><button class={primaryClass}>Add tax rate</button></div>
          </form>
        </Section>
      </>
    ), status);
  };

  app.get("/tax-rates", (c) => ratesPage(c));
  app.post("/tax-rates", async (c) => {
    const body = await c.req.parseBody();
    const r = await createTaxRate(getDb(c), { name: body.name, percent: body.percent, inclusive: body.inclusive }, c.get("user"));
    return r.ok ? back(c, `${base}/tax-rates`, "rate-added") : ratesPage(c, r.errors, 422);
  });
  app.post("/tax-rates/:id/active", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    await setTaxRateActive(getDb(c), id, str((await c.req.parseBody()).active) === "1", c.get("user"));
    return back(c, `${base}/tax-rates`, "rate-saved");
  });

  return app;
}

/** A document's lines and totals, as stored. */
export function Lines({ qt, rates }: { qt: { currency: string; subtotal_cents: string; total_cents: string; lines: SavedLine[] }; rates: TaxRate[] }) {
  const m = (c: string | number) => formatMoney(c, qt.currency);
  const taxes = taxSummary(qt.lines, rates);
  const cell = "px-2 py-1 align-top";
  return (
    <div class="overflow-x-auto">
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b border-line-strong text-left text-label text-ink-3">
            <th scope="col" class={cell}>Description</th>
            <th scope="col" class={cell + " text-right"}>Qty</th>
            <th scope="col" class={cell + " text-right"}>Price</th>
            <th scope="col" class={cell + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {qt.lines.map((l) => (
            <tr class="border-b border-line">
              <td class={cell + " break-words"}>{l.description}</td>
              <td class={cell + " text-right"}>{l.quantity}</td>
              <td class={cell + " whitespace-nowrap text-right"}>{m(l.unit_cents)}</td>
              <td class={cell + " whitespace-nowrap text-right"}>{m(l.amount_cents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {taxes.length ? <tr><td colspan={3} class={cell + " text-right text-ink-2"}>Subtotal</td><td class={cell + " text-right"}>{m(qt.subtotal_cents)}</td></tr> : null}
          {taxes.map((t) => (
            <tr><td colspan={3} class={cell + " text-right text-ink-2"}>{t.label}{t.inclusive ? " (included)" : ""}</td><td class={cell + " text-right"}>{m(t.cents)}</td></tr>
          ))}
          <tr><td colspan={3} class={cell + " text-right font-semibold"}>Total</td><td class={cell + " whitespace-nowrap text-right font-semibold"}>{m(qt.total_cents)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

const BLANK_ROWS = 3;

/** A quote or invoice, new or being edited; `submit` says which: Create quote when it posts to the list (a new one), Save when to its own page. */
/** `currency` is the app's own (crm.config.json's): a document in it asks nothing, as Stripe takes it from the account; one in another shows the field. */
function DocForm({ kind, action, v, errors, rates, cancel, submit, taxPage, currency }: { kind: "quote" | "invoice"; action: string; v: FormValues; errors: Errors; rates: TaxRate[]; cancel: string; submit: string; taxPage: string; currency?: string }) {
  const ownCurrency = !!currency && v.currency.toLowerCase() === currency.toLowerCase() && !errors.currency;
  const err = (k: string) => (errors[k] ? <span class="text-ink" id={`err-${k.replace(/\./g, "-")}`}>{errors[k]}</span> : null);
  const offered = rates.filter((r) => r.active || v.lines.some((l) => l.tax_rate_id === r.id));
  const rows = [...v.lines, ...Array.from({ length: Math.max(BLANK_ROWS, 5 - v.lines.length) }, () => ({ description: "", quantity: "", unit: "", tax_rate_id: "" }))];
  const problems = Object.keys(errors).length;
  const tax = docTax(v.lines.filter((l) => l.description || l.unit));
  const mixed = tax === "mixed";
  const taxError = Object.entries(errors).find(([k]) => k.endsWith(".tax_rate_id"))?.[1];
  return (
    <form method="post" action={action} class="flex flex-col gap-4">
      {problems ? <p role="alert" class={alertClass}>Fix what is marked below. Nothing was saved.</p> : null}
      {errors.status ? <p role="alert" class={alertClass}>{errors.status}</p> : null}
      <input type="hidden" name="visit_id" value={v.visit_id} />
      {kind === "quote" ? <input type="hidden" name="deal_id" value={v.deal_id} /> : null}
      <Section title="Customer">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class={fieldClass}>Email<input name="email" type="email" required value={v.email} maxlength={254} class={controlClass} />{err("email")}</label>
          <label class={fieldClass}>Name<input name="name" value={v.name} maxlength={200} class={controlClass} />{err("name")}</label>
          <label class={fieldClass}>Phone<input name="phone" type="tel" value={v.phone} maxlength={50} class={controlClass} />{err("phone")}</label>
          <label class={fieldClass}>Address<input name="address" value={v.address} maxlength={500} autocomplete="off" class={controlClass} />{err("address")}</label>
        </div>
      </Section>
      <Section title="Line items">
        <p class="mb-3 text-label text-ink-3">Blank rows are left out. Save to get more rows.</p>
        {err("lines")}
        <div class="flex flex-col gap-3">
          {rows.map((l, i) => {
            // The column names show once, over the first row; each row's own are for a phone and a screen reader.
            const name = (text: string) => <span class={i ? "sm:sr-only" : ""}>{text}</span>;
            return (
            <fieldset class={"grid gap-2 sm:grid-cols-12 " + (i ? "border-t border-line pt-3 sm:border-0 sm:pt-0" : "")}>
              <legend class="sr-only">Line {i + 1}</legend>
              <label class={fieldClass + " sm:col-span-8"}>{name("Description")}<input name="description" value={l.description} maxlength={500} class={controlClass} />{err(`lines.${i}.description`)}</label>
              <label class={fieldClass + " sm:col-span-2"}>{name("Qty")}<input name="quantity" value={l.quantity} placeholder="1" inputmode="decimal" class={controlClass} />{err(`lines.${i}.quantity`)}</label>
              <label class={fieldClass + " sm:col-span-2"}>{name("Price")}<input name="unit" value={l.unit} inputmode="decimal" class={controlClass} />{err(`lines.${i}.unit`)}</label>
              {mixed ? <input type="hidden" name="tax_rate_id" value={l.tax_rate_id} /> : null}
            </fieldset>
            );
          })}
        </div>
        {/* One tax for the whole document, none unless chosen; rates are kept on their own page. */}
        <div class="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <label class={fieldClass}>Tax
            <Select name="tax" aria-describedby={taxError ? "tax-error" : undefined}>
              <option value="">No tax</option>
              {offered.map((r) => <option value={r.id} selected={r.id === tax}>{r.name} ({percentText(r.percent_bp)})</option>)}
              {mixed ? <option value="mixed" selected>Different on each line</option> : null}
            </Select>
          </label>
          <a href={taxPage} class="pb-2 text-label text-ink-2">Manage tax rates</a>
          <FieldError id="tax-error" text={taxError} />
        </div>
      </Section>
      <Section title={kind === "quote" ? "Terms" : "Payment"}>
        <div class="grid gap-3 sm:grid-cols-2">
          {ownCurrency ? <input type="hidden" name="currency" value={v.currency} /> : <label class={fieldClass}>Currency<input name="currency" value={v.currency} maxlength={3} class={controlClass} />{err("currency")}</label>}
          {kind === "quote" ? (
            <label class={fieldClass}>Valid until<input name="valid_until" type="date" value={v.valid_until} class={controlClass} />{err("valid_until")}</label>
          ) : (
            <label class={fieldClass}>Payment due in (days)<input name="days_until_due" inputmode="numeric" value={v.days_until_due} class={controlClass} />{err("days_until_due")}</label>
          )}
          <label class={fieldClass + " sm:col-span-2"}>Message to the customer<textarea name="notes" rows={3} maxlength={5000} class={controlClass}>{v.notes}</textarea>{err("notes")}</label>
          {kind === "quote" ? (
            <label class={fieldClass + " sm:col-span-2"}>Terms<textarea name="terms" rows={2} maxlength={5000} class={controlClass}>{v.terms}</textarea>{err("terms")}</label>
          ) : null}
        </div>
      </Section>
      <div class="flex flex-wrap items-center gap-3">
        <button class={primaryClass}>{submit}</button>
        <a href={cancel} class="text-label text-ink-2">Cancel</a>
      </div>
    </form>
  );
}
