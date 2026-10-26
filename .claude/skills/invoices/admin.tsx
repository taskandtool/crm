// The team's side of quotes and invoices, private (teamOnly): the quotes list,
// a quote's page, the editor, the preview, sending through the owner's own
// sender, the customer's answer; invoices, drafted here and sent, paid out of
// band, voided or written off through Stripe; and the tax rates. Built on
// admin/; every form works without JavaScript, and a GET never sends,
// charges or changes anything: each of those is a POST from a page that says
// exactly what will happen.
//
//   app.route("/invoices", invoicesAdmin(getDb, { base: "/invoices", css: "/site.css", source: "crm", timeZone }));
//
// `send` and `print` are how a quote leaves: `send` defaults to the owner's
// connected sender (data/send.ts); `print` makes the PDF and exists only on
// the machine (reports/print.ts). Without it, the email carries the lines.
// With `proposal` (the CRM's), a quote is the app's own page at a link the
// customer reads and accepts, and the email carries that link instead.
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
import { buttonClass, controlClass, fieldClass, primaryClass, Select, StatusBadge, type StatusOption } from "../admin/status";
import { businessOf } from "../data/business";
import type { GetDb } from "../data/db";
import { envOf } from "../data/env";
import { emailsCustomers, sendEmail, type Email, type Sent } from "../data/send";
import { formatMoney, toMinor } from "../payments/money";
import { stripeConnected, stripeFrom, type Stripe } from "../payments/stripe";
import { invoiceHtml, isDay, quoteHtml, quoteMessage, sendQuote, taxSummary, todayIn } from "./document";
import { createTaxRate, percentText, setTaxRateActive, taxRates, type TaxRate } from "../payments/tax";
import { amountInput, type Errors, type SavedLine } from "./lines";
import { CustomerFields, formLines, LineItems, linesOf, OneOrRepeats } from "./form";
import {
  cannotSend, copyQuote, createQuote, decideQuote, expireQuote, isEditable, markSent, QUOTE_STATUS_LABELS, quoteById, quotesPage, saveQuote, SHOWN_QUOTE_STATUSES, shownStatus,
  type Quote, type QuoteRow, type ShownQuoteStatus,
} from "./quotes";
import {
  attachableDrafts, attachInvoice, createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, invoicesPage, INVOICE_STATUSES, INVOICE_STATUS_LABELS, invoiceTotals, pastDue, saveInvoice,
  type Invoice, type InvoiceRow, type InvoiceStatus,
} from "./invoices";
import { cardName, defaultCard } from "./cards";
import { RECURRING_MESSAGES, recurringRoutes } from "./recurring-admin";
import { recurringList, scheduleText, shortDay } from "./recurring";
import { chargeInvoice, emailPaymentPage, markUncollectible, paidSoFar, PAYMENT_METHODS, recordPayment, sendInvoice, voidInvoice } from "./stripe";

type Ctx = Context<{ Variables: TeamVars }>;
export type { Frame } from "../admin/layout";
/** What went out, and to whom. */
export type SentDoc = { kind: "quote" | "invoice"; id: string; email: string };
type QuoteWithLines = Quote & { lines: SavedLine[] };

/**
 * A quote as the app's own page (the CRM's proposal), which the customer
 * reads and accepts at a link. Each hook may throw only for a real fault.
 */
export type ProposalHooks = {
  /** The quote as its customer reads it: Preview, and the PDF when it goes without a link. */
  document: (c: Ctx, qt: QuoteWithLines) => Promise<string>;
  /** After the team made or saved a quote here: the app keeps its page current. */
  saved: (c: Ctx, qt: Quote) => Promise<void>;
  /** The app's part of the quote's page: its sections, its link, who opened it, the signature. */
  panel: (c: Ctx, qt: QuoteWithLines) => Promise<Child>;
  /** Whether the quote can go as a link now: null, or why not, in a sentence. */
  linkReady: (c: Ctx, qt: Quote) => Promise<string | null>;
  /**
   * A new link for the quote, shown once. It works, and any earlier one stops
   * working, only once `keep` runs: after the email carrying it went, so a
   * send that fails leaves the link the customer has.
   */
  mintLink: (c: Ctx, qt: Quote) => Promise<{ url: string; keep: () => Promise<void> }>;
  /** The email carrying the link went out now. */
  emailed: (c: Ctx, qt: Quote) => Promise<void>;
  /** What accepting it does, in a sentence, shown before Mark accepted; null when nothing. */
  onAccept: (c: Ctx, qt: Quote) => Promise<string | null>;
  /** Anything to know before it goes (parts still showing sample words), in a sentence; null when nothing. */
  warning: (c: Ctx, qt: Quote) => Promise<string | null>;
};

export type InvoicesAdminOptions = {
  base: string;
  css: string;
  /** This app's slug, stored on what it makes. */
  source: string;
  /** The business's zone: "today" for valid-until dates. */
  timeZone: string;
  /** The clock "today" is read from: the real one unless a test pins it. */
  now?: () => Date;
  /** A new quote's currency; default usd. */
  currency?: string;
  /** Standing terms a new quote starts with ("Payment due within 14 days of the work."). */
  terms?: string | null;
  /** What the business calls a quote: "Quote" (default), "Proposal" or "Estimate". */
  word?: string;
  /** Quotes as the app's own pages at a link (ProposalHooks). */
  proposal?: ProposalHooks;
  nav?: NavItem[];
  /** The quotes pages' own tabs, when quotes are a section apart from invoices (the CRM's); default `nav`. */
  quoteNav?: NavItem[];
  /** Where Tax rates sits, its way back; default the invoices list (the CRM's: its Settings). */
  settings?: { href: string; label: string };
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
  /** After a person marks a quote accepted or declined here: the CRM wins the deal it is for, and does what accepting it says. Throwing shows nothing; the answer stands. */
  afterDecide?: (c: Ctx, qt: Quote) => Promise<void>;
  /** Days a new invoice gives to pay; default 30. */
  daysUntilDue?: number;
  /** The Stripe caller; default stripeFrom(envOf(c)), the owner's connected account. */
  stripe?: (c: Ctx) => Stripe;
  /** A customer's record in the app by email (a recurring invoice's Bill to links to it); null when there is none. */
  customerHref?: (c: Ctx, email: string) => Promise<string | null>;
};

const INVOICE_OPTIONS: StatusOption[] = INVOICE_STATUSES.map((s) => ({
  value: s,
  label: INVOICE_STATUS_LABELS[s],
  tone: s === "paid" ? "accent" : s === "open" ? "strong" : s === "draft" ? "neutral" : "muted",
}));
/** What `links` gives a document's Details. */
export type DocLinks = { customer?: string | null; more?: { label: string; value: Child }[] };

/** Who a document is for, as Details lists them: the name (a link to their record, when the app has one), email, phone. */
function Party({ doc, href }: { doc: { name: string | null; email: string; phone: string | null }; href?: string | null }) {
  const first = doc.name ?? doc.email;
  return (
    <>
      {href ? <a href={href}>{first}</a> : first}
      {doc.name ? <span class="block truncate" title={doc.email}>{doc.email}</span> : null}
      {doc.phone ? <span class="block">{doc.phone}</span> : null}
    </>
  );
}

/** An open invoice past its due date shows as Past due ("due"), as the list's filter names it. */
export const SHOWN_INVOICE: StatusOption[] = [...INVOICE_OPTIONS, { value: "due", label: "Past due", tone: "late" }];

/** What is owed, how much of it is late, and what came in this month: each a link to the invoices behind it. */
function Totals({ totals, currency, base }: { totals: Awaited<ReturnType<typeof invoiceTotals>>; currency: string; base: string }) {
  const whole = (cents: string) => formatMoney(cents, currency).replace(/\.00$/, "");
  const count = (n: number) => (n === 1 ? "1 invoice" : `${n} invoices`);
  // As the CRM's Home figures (Tailwind's stats block): one card, its cells sharing 1px rules; the label, the figure, a line of context.
  const figure = (href: string, value: string, label: string, sub: string, late = false) => (
    <a href={href} class="group flex min-w-0 flex-col bg-surface px-3 py-3 no-underline hover:bg-canvas sm:px-5 sm:py-4">
      <span class="truncate text-label font-medium text-ink-2 group-hover:text-ink">{label}</span>
      <span class="mt-1 break-words font-semibold tabular-nums text-ink sm:text-title">{value}</span>
      <span class={"mt-1 hidden text-label sm:block " + (late ? "font-medium text-late" : "text-ink-3")}>{sub}</span>
    </a>
  );
  // One row on a phone too, as Stripe's own figures, so the list starts on the first screen.
  return (
    <div class="mb-5 grid grid-cols-3 gap-px overflow-hidden rounded-card bg-line shadow-card ring-1 ring-line">
      {figure(listUrl(base, { status: "open" }), whole(totals.open.cents), "Outstanding", count(totals.open.count))}
      {figure(listUrl(base, { status: "due" }), whole(totals.due.cents), "Past due", totals.due.count ? count(totals.due.count) : "None late", totals.due.count > 0)}
      {figure(listUrl(base, { status: "paid" }), whole(totals.paid.cents), "Paid this month", "Online and recorded by hand")}
    </div>
  );
}

/** A record's foot: when it was made and by whom. Its actions are in the header. */
function RecordFoot({ made, by, timeZone }: { made: Date; by: string | null; timeZone: string }) {
  return (
    <p class="mt-6 border-t border-line pt-3 text-label text-ink-3">Added <When at={made} timeZone={timeZone} />{by ? ` by ${by}` : ""}</p>
  );
}
/** One choice in a page's More menu. */
const menuItem = "block rounded-control px-2.5 py-1.5 font-medium text-ink no-underline hover:bg-panel";
const menuButton = menuItem + " w-full text-left";

/** A page's other actions behind More, beside its one next step, as Jobber's More actions. Nothing when there are none. */
function More({ items }: { items: Child[] }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <details data-menu class="relative">
      <summary class={buttonClass + " cursor-pointer list-none"}>More</summary>
      <div class="absolute right-0 z-10 mt-1 flex w-48 flex-col rounded-control bg-surface p-1 shadow-lift ring-1 ring-line">{shown}</div>
    </details>
  );
}

/** An invoice from an accepted quote. `seen`: a second click finds the invoice the first one made, and makes nothing. */
function InvoiceButton({ self, seen, label, cls }: { self: string; seen: number; label: string; cls: string }) {
  return (
    <form method="post" action={`${self}/invoice`}>
      <input type="hidden" name="seen" value={String(seen)} />
      <button class={cls}>{label}</button>
    </form>
  );
}

export const QUOTE_OPTIONS: StatusOption[] = SHOWN_QUOTE_STATUSES.map((s) => ({
  value: s,
  label: QUOTE_STATUS_LABELS[s],
  tone: s === "accepted" ? "accent" : s === "sent" || s === "viewed" ? "strong" : s === "draft" ? "neutral" : "muted",
}));

const MESSAGES: FlashMessages = {
  created: "Quote made. Preview it, then send it.",
  saved: "Saved.",
  sent: "Sent.",
  "sent-link": "Sent with its link. You will see here when they open it.",
  "sent-no-pdf": "Sent, with the lines in the email: the PDF could not be made.",
  "marked-sent": "Marked as sent.",
  accepted: "Marked accepted.",
  declined: "Marked declined.",
  expired: "Marked expired.",
  copied: "A new draft, copied from the quote.",
  "not-now": "Not from its current status. Nothing changed.",
  "past-valid": "Not sent: its valid-until date has passed. Change or clear it, then send.",
  "invoice-created": "Invoice drafted. Check it, then send it with Stripe.",
  "invoice-attached": "Attached: it is sent to pay when they say yes.",
  "invoice-detached": "Taken off the quote. It stays a draft.",
  "invoice-sent": "Sent. Stripe emailed the invoice from your Stripe account.",
  "invoice-charged": "Charged. It turns paid here when Stripe confirms, usually within seconds.",
  "page-emailed": "Stripe emailed them the payment page.",
  "charge-refused": "The card was refused. The invoice is open: email them the payment page, or try the card again later.",
  discarded: "Discarded. It stays on record as void.",
  "payment-recorded": "Payment recorded.",
  "payment-recorded-all": "Payment recorded. Nothing is left to pay: the invoice turns paid here when Stripe confirms, usually within seconds.",
  "asked-void": "Stripe is voiding it. It turns void here when Stripe confirms.",
  "asked-uncollectible": "Stripe has it written off. It changes here when Stripe confirms.",
  invoiced: "That invoice is made already: here it is.",
  "nothing-left": "Everything on it is invoiced already.",
  "rate-added": "Tax rate added.",
  "rate-saved": "Saved.",
  gone: "That is no longer there.",
  ...RECURRING_MESSAGES,
};



type FormValues = {
  email: string; name: string; phone: string; address: string; currency: string; valid_until: string; notes: string; terms: string;
  days_until_due: string; visit_id: string; deal_id: string; lines: { description: string; quantity: string; unit: string; tax_rate_id: string }[];
  /** A new invoice's quote: it goes on it, sent when they say yes. */
  quote_id?: string;
};

function readForm(body: Record<string, unknown>): FormValues {
  return {
    email: str(body.email), name: str(body.name), phone: str(body.phone), address: str(body.address), currency: str(body.currency),
    valid_until: str(body.valid_until), notes: str(body.notes), terms: str(body.terms), days_until_due: str(body.days_until_due),
    visit_id: str(body.visit_id), deal_id: str(body.deal_id), lines: formLines(body), quote_id: str(body.quote_id),
  };
}


export function invoicesAdmin(getDb: GetDb, opts: InvoicesAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const qbase = `${base}/quotes`;
  const size = opts.pageSize ?? 50;
  const links = opts.nav ?? [
    { href: qbase, label: `${opts.word ?? "Quote"}s` },
    { href: base, label: "Invoices" },
    { href: `${base}/recurring`, label: "Recurring" },
  ];
  const stripeOf = opts.stripe ?? ((c: Ctx) => stripeFrom(envOf(c)));
  // The business's name, at the top of every quote and in its email: the project's, as set now (data/business.ts).
  const today = () => todayIn(opts.timeZone, opts.now?.());
  const docOf = async (c: Ctx) => ({ business: (await businessOf(getDb(c))).name ?? "", timeZone: opts.timeZone, word: opts.word, now: opts.now?.() });
  const send = opts.send ?? ((c: Ctx, mail: Email) => sendEmail(envOf(c), mail));
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  const invoicePages = sectionPages({ Frame: opts.Frame, css: opts.css, label: opts.quoteNav ? "Invoices" : "Quotes and invoices", links, messages: MESSAGES });
  const quotePages = opts.quoteNav ? sectionPages({ Frame: opts.Frame, css: opts.css, label: `${opts.word ?? "Quote"}s`, links: opts.quoteNav, messages: MESSAGES }) : invoicePages;
  // A quote's page under the quotes' tabs, everything else under the invoices'.
  const framed: typeof invoicePages = (c, current, ...rest) => (current.startsWith(qbase) ? quotePages : invoicePages)(c, current, ...rest);
  const back = (c: Ctx, path: string, code: string) => c.redirect(withFlash(path, code), 303);
  // What sending needs: the owner's Stripe for invoices, their email for quotes.
  // A caller passed in (a test, another app) counts as there; null (Stripe not reachable just now) is not a no.
  const stripeReady = async (c: Ctx) => (opts.stripe ? true : (await stripeConnected(envOf(c))) !== false);
  const emailReady = (c: Ctx) => !!opts.send || emailsCustomers(envOf(c));
  const needStripe = (
    <SetupNeeded title="Connect Stripe to send invoices" ask="Connect my Stripe account so I can send invoices.">
      Invoices are made in your own Stripe account, which emails them with a Pay button and tells this app when they are paid.
      Make sure Stripe is connected to this app in Task & Tool, on the app's Connections tab. You can write drafts now; sending waits for Stripe.
    </SetupNeeded>
  );
  const needEmail = (
    <SetupNeeded title="Connect your email to send quotes" ask="Connect my email so I can send quotes.">
      Quotes go out from your own email address, so connect Resend or Postmark to this app in Task &amp; Tool, on the app's Connections tab. Task &amp; Tool email reaches only your team.
      You can write and preview quotes now, or send the text yourself and mark them sent.
    </SetupNeeded>
  );
  const money = (cents: string | number, currency: string) => formatMoney(cents, currency);

  // ---- quotes --------------------------------------------------------------

  const W = opts.word ?? "Quote", w = W.toLowerCase();
  const spec: TableSpec<QuoteRow> = {
    id: "quotes",
    href: (r) => `${qbase}/${r.id}`,
    columns: [
      { label: W, cell: (r) => <span class="whitespace-nowrap">{r.number}</span> },
      { label: "Customer", cell: (r) => r.name ?? r.email },
      { label: "Total", cell: (r) => money(r.total_cents, r.currency), class: "text-right" },
      { label: "Status", cell: (r) => <StatusBadge value={shownStatus(r, today())} options={QUOTE_OPTIONS} /> },
      { label: "Created", cell: (r) => <When at={r.created_at} timeZone={opts.timeZone} />, class: "hidden sm:table-cell" },
    ],
  };

  app.get("/quotes", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100) || null;
    const asked = c.req.query("status");
    const status = SHOWN_QUOTE_STATUSES.includes(asked as ShownQuoteStatus) ? (asked as ShownQuoteStatus) : null;
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await quotesPage(getDb(c), { q, status }, after, size, today()), size);
    const params = { q, status };
    const self = listUrl(qbase, params);
    const more = (cur: string) => listUrl(qbase, { ...params, after: cur });
    if (isPartial(c) && after) return c.html(<TableRows spec={spec} rows={page} next={next} more={more} />);
    const results = (
      <div id="results">
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the start</a></p> : null}
        <DataTable spec={spec} caption={`${W}s, newest first`} rows={page} next={next} more={more}
          empty={q || status ? <NoMatches clear={qbase} /> : (
            <EmptyState title={`No ${w}s yet.`} action={<a href={`${qbase}/new`} class={primaryClass}>New {w}</a>}>
              A {w} is the price you send before the work. Once it is accepted, invoice it.
            </EmptyState>
          )} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    return framed(c, qbase, { title: `${W}s`, actions: <a href={`${qbase}/new`} class={primaryClass}>New {w}</a> }, (
      <>
        {emailReady(c) ? null : needEmail}
        <SearchBar action={qbase} target="#results" q={q} placeholder={`Search ${w}s`}
          filters={[{ name: "status", label: "Status", options: QUOTE_OPTIONS, value: status, any: "Any status" }]} />
        {results}
      </>
    ));
  });

  const editor = async (c: Ctx, p: { title: string; action: string; values: FormValues; errors: Errors; current: string }, status = 200) => {
    const rates = await taxRates(getDb(c));
    return framed(c, p.current, p.title, <DocForm kind="quote" action={p.action} v={p.values} errors={p.errors} rates={rates} cancel={p.current} submit={p.action === qbase ? `Create ${w}` : "Save"} taxPage={`${base}/tax-rates`} currency={opts.currency} />, status);
  };

  // The app keeps its page of the quote current; a failure is logged, the save stands.
  const saved = async (c: Ctx, qt: Quote) => {
    if (opts.proposal) await opts.proposal.saved(c, qt).catch((e) => console.error(`quote ${qt.id}: saved: ${e instanceof Error ? e.message : e}`));
  };

  // Prefilled from the query: a customer's page or an appointment hands over who, and the first line.
  app.get("/quotes/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const currency = (qy("currency") || opts.currency || "usd").toLowerCase();
    const values: FormValues = {
      email: qy("email"), name: qy("name"), phone: qy("phone"), address: qy("address"), currency,
      valid_until: "", notes: "", terms: opts.terms ?? "", days_until_due: "", visit_id: qy("event"), deal_id: qy("deal"),
      lines: qy("line") ? [{ description: qy("line"), quantity: "1", unit: qy("unit"), tax_rate_id: "" }] : [],
    };
    return editor(c, { title: `New ${w}`, action: qbase, values, errors: {}, current: qbase });
  });

  app.post("/quotes", async (c) => {
    const values = readForm(await c.req.parseBody({ all: true }));
    const r = await createQuote(getDb(c), values, c.get("user"), opts.source);
    if (!r.ok) return editor(c, { title: `New ${w}`, action: qbase, values, errors: r.errors, current: qbase }, 422);
    await saved(c, r.value);
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
    const shown = shownStatus(qt, today());
    const open = isEditable(qt);
    const linked = opts.links ? await opts.links(c, { kind: "quote", quote: qt }) : {};
    const invoices = (await invoicesFor(getDb(c), { quoteId: qt.id })).filter((i) => i.status !== "void");
    const recurring = (await recurringList(getDb(c), { quoteId: qt.id })).filter((r) => r.status !== "ended");
    // Until they answer, what is on it is what their yes sends (and starts); the customer's other drafts can go on it too.
    const waiting = open;
    const drafts = waiting ? await attachableDrafts(getDb(c), qt.email) : [];
    const panel = opts.proposal ? await opts.proposal.panel(c, qt) : null;
    return framed(c, qbase, {
      title: `${W} ${qt.number}`,
      back: { href: qbase, label: `${W}s` },
      sub: (
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge value={shown} options={QUOTE_OPTIONS} />
          <span>{qt.name ?? qt.email} · {money(qt.total_cents, qt.currency)}</span>
        </p>
      ),
      // As Jobber's quote and this app's invoice: one next step by status (send a draft; invoice an
      // accepted one, Jobber's Convert to Job), everything else under More.
      actions: (
        <>
          <More items={[
            open ? <a href={`${self}/edit`} class={menuItem}>Edit</a> : null,
            <a href={`${self}/document`} class={menuItem} target="_blank">Preview</a>,
            qt.status === "sent" || qt.status === "expired" ? <a href={`${self}/send`} class={menuItem}>Send again</a> : null,
            // Their answer, by reply or on the phone.
            open ? (opts.proposal
              ? <a href={`${self}/accept`} class={menuItem}>Mark accepted</a>
              : <form method="post" action={`${self}/decide`}><input type="hidden" name="answer" value="accepted" /><button class={menuButton}>Mark accepted</button></form>) : null,
            open ? <form method="post" action={`${self}/decide`}><input type="hidden" name="answer" value="declined" /><button class={menuButton}>Mark declined</button></form> : null,
            open && qt.status !== "expired" ? <form method="post" action={`${self}/expire`}><button class={menuButton}>Mark expired</button></form> : null,
            qt.status === "accepted" && invoices.length ? <InvoiceButton self={self} seen={invoices.length} label="Invoice the rest" cls={menuButton} /> : null,
            <form method="post" action={`${self}/copy`}><button class={menuButton}>Copy to a new {w}</button></form>,
          ]} />
          {qt.status === "draft" ? <a href={`${self}/send`} class={primaryClass}>Send</a>
            : qt.status === "accepted" && !invoices.length ? <InvoiceButton self={self} seen={0} label="New invoice" cls={primaryClass} /> : null}
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
            {panel}
          </div>
          <div class="flex flex-col gap-4">
            {waiting || invoices.length || recurring.length ? (
              <Section title={waiting ? "When they say yes" : "Invoices"}>
                {waiting ? <p class="mb-3 text-label text-ink-3">Each invoice here is sent to pay, and each recurring one starts.</p> : null}
                {invoices.map((i) => (
                  <div class="mb-2 flex flex-wrap items-center gap-2">
                    <a href={`${base}/${i.id}`}>{i.number ? `Invoice ${i.number}` : "Draft invoice"}</a>
                    <span class="text-ink-2">{money(i.total_cents, i.currency)}</span>
                    {i.number ? <StatusBadge value={i.status} options={INVOICE_OPTIONS} /> : null}
                    {waiting ? <form method="post" action={`${base}/${i.id}/detach`}><button class="text-label text-ink-2 underline">Detach</button></form> : null}
                  </div>
                ))}
                {recurring.map((r) => (
                  <p class="mb-2">
                    <a href={`${base}/recurring/${r.id}`}>{r.title}</a>
                    <span class="block text-label text-ink-2">{money(r.total_cents, r.currency)} {scheduleText(r)}</span>
                  </p>
                ))}
                {waiting ? (
                  <div class="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                    <a href={`${base}/new?quote=${qt.id}`} class={buttonClass + " self-start"}>New invoice</a>
                    {drafts.length ? (
                      <form method="post" action={`${self}/attach`} class="flex flex-wrap items-center gap-2">
                        <span class="w-full text-label text-ink-3">Or one of their drafts</span>
                        <Select name="invoice" aria-label="One of their drafts">
                          {drafts.map((d) => <option value={d.id}>Draft, {money(d.total_cents, d.currency)}, made {shortDay(todayIn(opts.timeZone, d.created_at))}</option>)}
                        </Select>
                        <button class={buttonClass}>Attach</button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </Section>
            ) : null}
            <Section title="Details">
              <FieldList fields={[
                { label: "Customer", value: <Party doc={qt} href={linked.customer} /> },
                { label: "Address", value: qt.address },
                { label: "Valid until", value: qt.valid_until ? <When at={`${qt.valid_until}T00:00:00Z`} timeZone="UTC" day /> : null },
                { label: "Sent", value: qt.sent_at ? <When at={qt.sent_at} timeZone={opts.timeZone} /> : null },
                { label: "Opened", value: qt.viewed_at ? <When at={qt.viewed_at} timeZone={opts.timeZone} /> : null },
                { label: QUOTE_STATUS_LABELS[qt.status], value: qt.decided_at ? <><When at={qt.decided_at} timeZone={opts.timeZone} />{qt.decided_by ? ` by ${qt.decided_by}` : ""}</> : null },
                ...(linked.more ?? []),
              ]} />
            </Section>
          </div>
        </div>
        <RecordFoot made={qt.created_at} by={qt.created_by} timeZone={opts.timeZone} />
      </>
    ));
  });

  app.get("/quotes/:id/edit", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    if (!isEditable(qt)) return c.redirect(`${qbase}/${qt.id}`, 302);
    const values: FormValues = {
      email: qt.email, name: qt.name ?? "", phone: qt.phone ?? "", address: qt.address ?? "", currency: qt.currency,
      valid_until: qt.valid_until ?? "", notes: qt.notes ?? "", terms: qt.terms ?? "", days_until_due: "", visit_id: qt.visit_id ?? "", deal_id: qt.deal_id ?? "",
      lines: linesOf(qt),
    };
    return editor(c, { title: `Edit ${w} ${qt.number}`, action: `${qbase}/${qt.id}`, values, errors: {}, current: `${qbase}/${qt.id}` });
  });

  app.post("/quotes/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const values = readForm(await c.req.parseBody({ all: true }));
    const r = await saveQuote(getDb(c), id, values, c.get("user"));
    if (!r.ok) {
      if (r.errors.status && !(await quoteById(getDb(c), id))) return c.notFound();
      return editor(c, { title: `Edit ${w}`, action: `${qbase}/${id}`, values, errors: r.errors, current: `${qbase}/${id}` }, 422);
    }
    await saved(c, r.value);
    return back(c, `${qbase}/${id}`, "saved");
  });

  // The document exactly as it is printed and sent: the app's own page when it has one.
  app.get("/quotes/:id/document", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    return c.html(opts.proposal ? await opts.proposal.document(c, qt) : quoteHtml(qt, await taxRates(getDb(c)), await docOf(c)));
  });

  // What will go to whom. Sending is the POST below; this page never sends.
  app.get("/quotes/:id/send", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    const self = `${qbase}/${qt.id}`;
    const no = cannotSend(qt, today());
    if (no) return back(c, self, no === "past" ? "past-valid" : "not-now");
    const rates = await taxRates(getDb(c));
    const noLink = opts.proposal ? await opts.proposal.linkReady(c, qt) : "";
    const withLink = noLink === null;
    const msg = quoteMessage(qt, rates, await docOf(c), withLink ? "(the link, made when you send)" : null);
    const problem = c.req.query("problem");
    const canEmail = emailReady(c);
    const warning = opts.proposal ? await opts.proposal.warning(c, qt) : null;
    return framed(c, qbase, { title: `Send ${w} ${qt.number}`, back: { href: self, label: `${W} ${qt.number}` } }, (
      <>
        {problem ? <p role="alert" class={"mb-4 " + alertClass}>{problem}</p> : null}
        {warning ? <p role="alert" class={"mb-4 " + alertClass}>{warning}</p> : null}
        {opts.proposal && !withLink ? (
          <p role="status" class="mb-4 max-w-prose rounded-card border border-line-strong bg-panel px-4 py-3">
            It goes without a link this time: {noLink} They reply to accept, and you mark it accepted.
          </p>
        ) : null}
        {canEmail ? null : needEmail}
        <Section title="The email">
          <FieldList fields={[
            { label: "To", value: <span class="break-all">{qt.email}</span> },
            { label: "Replies go to", value: <span class="break-all">{c.get("user")}</span> },
            { label: "Subject", value: msg.subject },
            { label: "Attached", value: withLink ? "Nothing: the link always shows the current one" : opts.print ? `${W} ${qt.number}.pdf, where this server can print it; the lines are in the email either way` : "Nothing: the lines are in the email" },
          ]} />
          <pre class="mt-3 whitespace-pre-wrap break-words rounded-card border border-line bg-canvas p-3 font-body text-copy">{msg.text}</pre>
          <a href={`${self}/document`} target="_blank" class={buttonClass + " mt-3"}>Preview the {w}</a>
          {withLink && qt.status === "sent" ? <p class="mt-3 text-label text-ink-3">Sending again makes a new link; the one sent before stops working.</p> : null}
          {canEmail ? (
            <form method="post" action={`${self}/send`} class="mt-3">
              <input type="hidden" name="how" value="email" />
              <button class={primaryClass}>Send to {qt.email}</button>
            </form>
          ) : null}
        </Section>
        {withLink ? (
          <Section title="Or give them the link yourself" class="mt-4">
            <p class="mb-2 text-label text-ink-3">For a text message or your own email. The link is shown once; New link makes another.</p>
            <form method="post" action={`${self}/send`}>
              <input type="hidden" name="how" value="link" />
              <button class={buttonClass}>Copy link</button>
            </form>
          </Section>
        ) : (
          <Section title="Sent it yourself?" class="mt-4">
            <p class="mb-2 text-label text-ink-3">If you emailed this text from your own mail, mark the {w} sent.</p>
            <form method="post" action={`${self}/sent`}><button class={buttonClass}>Mark as sent</button></form>
          </Section>
        )}
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
    const no = cannotSend(qt, today());
    if (no) return back(c, self, no === "past" ? "past-valid" : "not-now");
    const how = str((await c.req.parseBody()).how);
    const proposal = opts.proposal;
    const withLink = !!proposal && (await proposal.linkReady(c, qt)) === null;

    // The link, for them to pass on: shown once, and the quote counts as sent.
    if (how === "link") {
      if (!proposal || !withLink) return back(c, `${self}/send`, "not-now");
      // Made (it can fail, and then nothing changed), marked sent, then kept: a link works only for a quote that is out.
      let made: { url: string; keep: () => Promise<void> };
      try {
        made = await proposal.mintLink(c, qt);
      } catch (e) {
        return c.redirect(listUrl(`${self}/send`, { problem: `No link was made: ${e instanceof Error ? e.message : e}` }), 303);
      }
      const r = await markSent(getDb(c), qt.id, c.get("user"));
      if (!r.ok) return back(c, self, "not-now");
      await made.keep();
      const link = made.url;
      await sent(c, { kind: "quote", id: qt.id, email: qt.email });
      return framed(c, qbase, { title: `The link to ${w} ${qt.number}`, back: { href: self, label: `${W} ${qt.number}` } }, (
        <Section title="Copy it now">
          <p class="mb-3 max-w-prose">Anyone with this link can open the {w} and accept it, so send it only to {qt.name ?? qt.email}. It is shown once: New link on the {w}'s page makes another and this one stops working.</p>
          <input readonly value={link} aria-label="The link" class={controlClass + " w-full font-mono"} data-select-all />
          <p class="mt-3"><a href={self} class={buttonClass}>Done</a></p>
        </Section>
      ));
    }

    const made = withLink ? await proposal!.mintLink(c, qt) : null;
    const link = made?.url ?? null;
    const r = await sendQuote(getDb(c), qt, await taxRates(getDb(c)), await docOf(c), {
      link,
      html: proposal && !link ? await proposal.document(c, qt) : undefined,
      send: (mail) => send(c, mail),
      print: opts.print ? (html) => opts.print!(c, html) : undefined,
      replyTo: c.get("user"),
      by: c.get("user"),
    });
    if (r.printError) console.error(`quote ${qt.number}: the PDF failed: ${r.printError}`);
    if (r.sent.status !== "sent") {
      const problem = r.sent.status === "none"
        ? `Nothing was sent: ${r.sent.why}. ${link ? "Use Copy link instead, or connect your email." : "Copy the text below into your own email, then mark it sent."}`
        : `The email did not go: ${r.sent.error}`;
      return c.redirect(listUrl(`${self}/send`, { problem }), 303);
    }
    if (made) {
      await made.keep();
      await proposal!.emailed(c, qt).catch((e) => console.error(`quote ${qt.id}: emailed: ${e instanceof Error ? e.message : e}`));
    }
    await sent(c, { kind: "quote", id: qt.id, email: qt.email });
    return back(c, self, link ? "sent-link" : r.printError ? "sent-no-pdf" : "sent");
  });

  app.post("/quotes/:id/sent", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const r = await markSent(getDb(c), id, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (r.ok) await sent(c, { kind: "quote", id, email: r.value.email });
    return back(c, `${qbase}/${id}`, r.ok ? "marked-sent" : "not-now");
  });

  // Mark accepted, with the app's page: first what accepting it does (its first invoice, sent or not), then the POST.
  app.get("/quotes/:id/accept", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    const self = `${qbase}/${qt.id}`;
    if (!isEditable(qt)) return back(c, self, "not-now");
    const does = opts.proposal ? await opts.proposal.onAccept(c, qt) : null;
    return framed(c, qbase, { title: `Mark ${w} ${qt.number} accepted`, back: { href: self, label: `${W} ${qt.number}` } }, (
      <Section title="What happens" class="max-w-2xl">
        <p class="mb-2 max-w-prose">For a yes by reply or on the phone. The {w} no longer changes after this.</p>
        <p class="mb-4 max-w-prose">{does ?? "Nothing else: make its invoice from its page when you are ready."}</p>
        <form method="post" action={`${self}/decide`} class="flex items-center gap-4">
          <input type="hidden" name="answer" value="accepted" />
          <button class={primaryClass}>Mark accepted</button>
          <a href={self} class="text-label text-ink-2">Cancel</a>
        </form>
      </Section>
    ));
  });

  app.post("/quotes/:id/decide", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const answer = str((await c.req.parseBody()).answer);
    if (answer !== "accepted" && answer !== "declined") return back(c, `${qbase}/${id}`, "not-now");
    const r = await decideQuote(getDb(c), id, answer, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
    if (r.ok && opts.afterDecide) await opts.afterDecide(c, r.value).catch((e) => console.error(`quote ${id}: afterDecide: ${e instanceof Error ? e.message : e}`));
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
    if (copy) await saved(c, copy);
    return copy ? back(c, `${qbase}/${copy.id}/edit`, "copied") : c.notFound();
  });

  // One of the customer's drafts goes on the quote, or comes off it: their yes sends what is on it.
  app.post("/quotes/:id/attach", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    const ok = await attachInvoice(getDb(c), str((await c.req.parseBody()).invoice), qt.id, c.get("user"));
    if (ok) await saved(c, qt);
    return back(c, `${qbase}/${qt.id}`, ok ? "invoice-attached" : "not-now");
  });

  app.post("/:id{[0-9]+}/detach", async (c) => {
    const inv = await invoiceById(getDb(c), c.req.param("id"));
    if (!inv) return c.notFound();
    const quote = inv.quote_id ? await quoteById(getDb(c), inv.quote_id) : null;
    const ok = !!quote && (await attachInvoice(getDb(c), inv.id, null, c.get("user")));
    if (ok) await saved(c, quote!);
    return back(c, quote ? `${qbase}/${quote.id}` : `${base}/${inv.id}`, ok ? "invoice-detached" : "not-now");
  });

  // From an accepted quote: its lines the first time, then what is left to bill.
  app.post("/quotes/:id/invoice", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const raw = str((await c.req.parseBody()).seen);
    const seen = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
    const r = await invoiceFromQuote(getDb(c), id, c.get("user"), opts.source, opts.daysUntilDue ?? 30, { share: { kind: "rest" }, seen });
    if (r.ok) return back(c, `${base}/${r.value.id}`, "invoice-created");
    if (r.reason === "not_found") return c.notFound();
    if (r.reason === "invoiced") return back(c, `${base}/${r.invoiceId}`, "invoiced");
    return back(c, `${qbase}/${id}`, r.reason === "nothing_left" ? "nothing-left" : "not-now");
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
    const { page, next } = cut(await invoicesPage(getDb(c), { q, status, due }, after, size, today()), size);
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
    const totals = after ? null : await invoiceTotals(getDb(c), { today: today(), timeZone: opts.timeZone, currency });
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
    const isNew = p.action === base;
    return framed(c, base, p.title, (
      <>
        {isNew ? <OneOrRepeats base={base} repeats={false} query={new URL(c.req.url).search} /> : null}
        <DocForm kind="invoice" action={p.action} v={p.values} errors={p.errors} rates={rates} cancel={p.current} submit={isNew ? "Create invoice" : "Save"} taxPage={`${base}/tax-rates`} currency={opts.currency} />
      </>
    ), status);
  };

  // Blank, or prefilled from the query: a customer's page or an appointment hands over who, and the first line;
  // a quote waiting for its answer, its customer and lines, to make into what their yes sends (a deposit, all of it).
  app.get("/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const quote = idParam(qy("quote")) ? await quoteById(getDb(c), qy("quote")) : null;
    const on = quote && isEditable(quote) ? quote : null;
    const values: FormValues = on ? {
      email: on.email, name: on.name ?? "", phone: on.phone ?? "", address: on.address ?? "", currency: on.currency,
      valid_until: "", notes: "", terms: "", days_until_due: String(opts.daysUntilDue ?? 30), visit_id: on.visit_id ?? "", deal_id: "",
      lines: linesOf(on), quote_id: on.id,
    } : {
      email: qy("email"), name: qy("name"), phone: qy("phone"), address: qy("address"), currency: (qy("currency") || opts.currency || "usd").toLowerCase(),
      valid_until: "", notes: "", terms: "", days_until_due: String(opts.daysUntilDue ?? 30), visit_id: qy("event"), deal_id: "",
      lines: qy("line") ? [{ description: qy("line"), quantity: "1", unit: qy("unit"), tax_rate_id: "" }] : [],
    };
    return invoiceEditor(c, { title: on ? `New invoice for ${w} ${on.number}` : "New invoice", action: base, values, errors: {}, current: on ? `${qbase}/${on.id}` : base });
  });

  app.post("/", async (c) => {
    const values = readForm(await c.req.parseBody({ all: true }));
    const quote = idParam(values.quote_id ?? "") ? await quoteById(getDb(c), values.quote_id!) : null;
    const current = quote ? `${qbase}/${quote.id}` : base;
    if (quote && !isEditable(quote)) return invoiceEditor(c, { title: "New invoice", action: base, values: { ...values, quote_id: "" }, errors: { status: `${W} ${quote.number} was ${quote.status}, so this would not go with it. Create it again to make it on its own.` }, current: base }, 422);
    if (quote && quote.email.toLowerCase() !== values.email.trim().toLowerCase()) return invoiceEditor(c, { title: "New invoice", action: base, values, errors: { email: `${W} ${quote.number} is for ${quote.email}; an invoice on it is too.` }, current }, 422);
    const r = await createInvoice(getDb(c), values, c.get("user"), opts.source);
    if (!r.ok) return invoiceEditor(c, { title: "New invoice", action: base, values, errors: r.errors, current }, 422);
    if (quote && (await attachInvoice(getDb(c), r.value.id, quote.id, c.get("user")))) {
      await saved(c, quote);
      return back(c, `${qbase}/${quote.id}`, "invoice-attached");
    }
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
    return c.html(invoiceHtml(inv, await taxRates(getDb(c)), await docOf(c)));
  });

  app.get("/:id{[0-9]+}", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    const rates = await taxRates(getDb(c));
    const self = `${base}/${inv.id}`;
    const draft = inv.status === "draft" && !inv.stripe_invoice_id;
    const linked = opts.links ? await opts.links(c, { kind: "invoice", invoice: inv }) : {};
    const quote = inv.quote_id ? await quoteById(getDb(c), inv.quote_id) : null;
    // What was paid against it, as Jobber lists an invoice's payments above its balance.
    const paid = await getDb(c).sql<{ id: string; amount_cents: string; currency: string; paid_at: Date | null; created_at: Date; status: string; how: string }>`
      select id::text as id, coalesce(total_cents, amount_cents)::text as amount_cents, currency, paid_at, created_at, status,
             -- How it came, as Jobber's and HubSpot's payments say: the method recorded by hand ("Check · 1042"), else online.
             case when stripe_payment_record_id is not null then coalesce(substring(description from ': (.*)$'), 'By hand') else 'Online' end as how
      from payments where ref_type = 'invoice' and ref_id = ${inv.id}::text and status in ('paid', 'refunded', 'partially_refunded')
      order by coalesce(paid_at, created_at)`;
    const owes = inv.status === "open" || inv.status === "uncollectible";
    // The card on file a charge would use (the mirror; the charge page reads Stripe first).
    const card = inv.status === "draft" || inv.status === "open" ? await defaultCard(getDb(c), inv.email, inv.livemode ?? false) : null;
    const paidTotal = paid.reduce((n, p) => n + Number(p.amount_cents), 0);
    // Jobber's More actions: everything but the one next step, in one menu.
    const more = [
      draft ? <a href={`${self}/edit`} class={menuItem}>Edit</a> : null,
      // QuickBooks' Make recurring: the recurring form with its customer and lines (and its quote, while that waits).
      draft && !inv.recurring_id ? <a href={`${base}/recurring/new?invoice=${inv.id}`} class={menuItem}>Make it repeat</a> : null,
      !inv.pdf_url ? <a href={`${self}/document`} target="_blank" class={menuItem}>Preview</a> : null,
      inv.hosted_url && inv.status !== "void" ? <a href={inv.hosted_url} target="_blank" rel="noopener" class={menuItem}>Payment page</a> : null,
      inv.pdf_url ? <a href={inv.pdf_url} target="_blank" rel="noopener" class={menuItem}>PDF</a> : null,
      inv.status === "open" && inv.sent_at && card ? <a href={`${self}/charge`} class={menuItem}>Charge {cardName(card)}</a> : null,
      inv.status === "open" && inv.sent_at ? <a href={`${self}/email-page`} class={menuItem}>Email them the payment page</a> : null,
      inv.status === "open" ? <a href={`${self}/uncollectible`} class={menuItem}>Write off</a> : null,
      // Not once anything is paid on it: Stripe refuses, so Write off is the way.
      owes && !paidTotal ? <a href={`${self}/void`} class={menuItem}>Void</a> : null,
      draft ? <form method="post" action={`${self}/discard`}><button class={menuButton}>Delete draft</button></form> : null,
    ].filter(Boolean);
    return framed(c, base, {
      title: inv.number ? `Invoice ${inv.number}` : "Draft invoice",
      back: { href: base, label: "Invoices" },
      sub: (
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge value={pastDue(inv, today(), quote) ? "due" : inv.status} options={SHOWN_INVOICE} />
          <span>{inv.name ?? inv.email} · {money(inv.total_cents, inv.currency)}</span>
          {inv.livemode === false ? <span class="text-label text-ink-3">Stripe test mode: not real money</span> : null}
        </p>
      ),
      // As Jobber's invoice: one blue next step by status (send a draft; mark an open or past-due one paid,
      // its Collect payment), everything else under More.
      actions: (
        <>
          <More items={more} />
          {inv.status === "draft" || (inv.status === "open" && !inv.sent_at) ? <a href={`${self}/send`} class={primaryClass}>Send invoice</a>
            : owes ? <a href={`${self}/payment`} class={primaryClass}>Record payment</a> : null}
        </>
      ),
    }, (
      <>
        {inv.payment_failed_at && inv.status === "open" ? (
          <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
            A payment attempt failed <When at={inv.payment_failed_at} timeZone={opts.timeZone} />. The invoice is still open on their payment page.{" "}
            <a href={`${self}/email-page`}>Email them the payment page</a>{card ? <> or <a href={`${self}/charge`}>charge {cardName(card)} again</a></> : null}.
          </p>
        ) : null}
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Line items">
              <Lines qt={inv} rates={rates} />
            </Section>
            {paid.length || owes ? (
              <Section title="Payments">
                {paid.length ? (
                  <ul class="flex flex-col divide-y divide-line">
                    {paid.map((p) => (
                      <li class="flex items-center justify-between gap-3 py-2">
                        <span>
                          <When at={p.paid_at ?? p.created_at} timeZone={opts.timeZone} />
                          <span class="text-label text-ink-3"> · {p.how}{p.status !== "paid" ? ` · ${p.status.replace("_", " ")}` : ""}</span>
                        </span>
                        <span class="tabular-nums">{money(p.amount_cents, p.currency)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p class="text-ink-3">No payment yet.</p>}
                <p class="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3 font-semibold">
                  <span>Balance due</span>
                  <span class="tabular-nums">{money(owes ? Number(inv.total_cents) - paidTotal : 0, inv.currency)}</span>
                </p>
              </Section>
            ) : null}
            {inv.notes ? <Section title="Message to the customer"><p class="whitespace-pre-wrap break-words">{inv.notes}</p></Section> : null}
          </div>
          <div class="flex flex-col gap-4">
            <Section title="Details">
              <FieldList fields={[
                { label: "Bill to", value: <Party doc={inv} href={linked.customer} /> },
                inv.due_date ? { label: "Due", value: <When at={`${inv.due_date}T00:00:00Z`} timeZone="UTC" day /> } : { label: "Payment due", value: `${inv.days_until_due} ${inv.days_until_due === 1 ? "day" : "days"} after it is sent` },
                { label: "Sent", value: inv.sent_at ? <When at={inv.sent_at} timeZone={opts.timeZone} /> : null },
                { label: "Paid by", value: inv.sent_at && inv.collect === "charge" ? "Their card on file" : null },
                { label: "Paid", value: inv.paid_at ? <When at={inv.paid_at} timeZone={opts.timeZone} /> : null },
                {
                  label: W,
                  value: quote ? <><a href={`${qbase}/${quote.id}`}>{W} {quote.number}</a>{draft && isEditable(quote) ? <span class="block text-label text-ink-3">Sent to pay when they say yes</span> : null}</> : null,
                },
                { label: "Recurring", value: inv.recurring_id ? <a href={`${base}/recurring/${inv.recurring_id}`}>{inv.period_on ? `The one for ${shortDay(inv.period_on)}` : "Open it"}</a> : null },
                ...(linked.more ?? []),
              ]} />
            </Section>
          </div>
        </div>
        <RecordFoot made={inv.created_at} by={inv.created_by} timeZone={opts.timeZone} />
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
    // On a quote waiting for its answer, the quote says what it comes to.
    const quote = r.value.quote_id ? await quoteById(getDb(c), r.value.quote_id) : null;
    if (quote && isEditable(quote)) await saved(c, quote);
    return back(c, `${base}/${id}`, "saved");
  });

  app.post("/:id{[0-9]+}/discard", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const ok = await discardInvoice(getDb(c), id, c.get("user"));
    const quoteId = ok ? (await invoiceById(getDb(c), id))?.quote_id : null;
    const quote = quoteId ? await quoteById(getDb(c), quoteId) : null;
    if (quote && isEditable(quote)) await saved(c, quote);
    return back(c, `${base}/${id}`, ok ? "discarded" : "not-now");
  });

  // Each Stripe action: a page that says exactly what will happen, then its POST.
  type Act = { path: string; title: string; allowed: (i: Invoice, c: Ctx) => boolean | Promise<boolean>; say: (i: Invoice) => string; button: string;
    run: (c: Ctx, i: Invoice, body: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; message: string }>; done: string | ((body: Record<string, unknown>) => string) };
  const cardOf = (c: Ctx, i: Invoice) => defaultCard(getDb(c), i.email, i.livemode ?? false);
  const acts: Act[] = [
    {
      path: "send", title: "Send invoice", button: "Email it to pay", done: (b) => (str(b.collect) === "charge" ? "invoice-charged" : "invoice-sent"),
      allowed: (i) => i.status === "draft" || (i.status === "open" && !i.sent_at),
      say: (i) => `Stripe makes this invoice in your Stripe account and emails it to ${i.email}: ${money(i.total_cents, i.currency)}, due ${i.days_until_due} days after it is sent. They pay on Stripe's page. After this the invoice no longer changes here.`,
      run: async (c, i, b) => sendInvoice(getDb(c), stripeOf(c), i.id, c.get("user"), { collect: str(b.collect) === "charge" ? "charge" : "email", timeZone: opts.timeZone }),
    },
    {
      path: "charge", title: "Charge card", button: "Charge the card", done: "invoice-charged",
      allowed: async (i, c) => i.status === "open" && !!i.sent_at && !!(await cardOf(c, i)),
      say: (i) => `What is left on this invoice is charged now to the card ${i.name ?? i.email} saved. Charge a card only with their agreement to pay this way (a signed proposal that says so is that).`,
      run: (c, i) => chargeInvoice(getDb(c), stripeOf(c), i.id, c.get("user")),
    },
    {
      path: "email-page", title: "Email the payment page", button: "Email the payment page", done: "page-emailed",
      allowed: (i) => i.status === "open" && !!i.stripe_invoice_id,
      say: (i) => i.collect === "charge"
        ? `${i.email} is emailed from your own address this invoice's payment page, where they can pay with any card or confirm the charge their bank asked about. Stripe does not email the page of an invoice it charges.`
        : `Stripe emails ${i.email} this invoice's payment page, where they can pay with any card.`,
      run: async (c, i) => emailPaymentPage(getDb(c), stripeOf(c), i.id, { send: (mail) => send(c, mail), business: (await docOf(c)).business, replyTo: c.get("user") }),
    },
    {
      path: "void", title: "Void", button: "Void the invoice", done: "asked-void",
      // Stripe refuses to void an invoice with a payment on it (one recorded by hand, too); write it off instead.
      allowed: async (i, c) => (i.status === "open" || i.status === "uncollectible") && (await paidSoFar(getDb(c), i.id)) === 0,
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
      if (!(await act.allowed(inv, c))) return back(c, self, "not-now");
      const problem = c.req.query("problem");
      const ready = await stripeReady(c);
      // Send offers Charge only when they saved a card (the mirror; the charge reads Stripe first).
      const card = act.path === "send" ? await cardOf(c, inv) : null;
      return framed(c, base, { title: inv.number ? `${act.title}: invoice ${inv.number}` : `${act.title} to ${inv.name || inv.email}`, back: { href: self, label: inv.number ? `Invoice ${inv.number}` : "Draft invoice" } }, (
        <>
          {problem ? <p role="alert" class={"mb-4 " + alertClass}>{problem}</p> : null}
          {ready ? null : needStripe}
          <Section title="What happens" class="max-w-2xl">
            <p class="mb-4 max-w-prose">{act.say(inv)}</p>
            {act.path === "send" && card && ready ? (
              <p class="mb-4 max-w-prose">
                Or charge {cardName(card)}, the card they saved, now: no email to pay. Charge a card only with their agreement to pay this way; a signed proposal that says so is that.
              </p>
            ) : null}
            <form method="post" action={`${self}/${act.path}`} class="flex flex-wrap items-center gap-4">
              {ready ? <button class={primaryClass} name="collect" value="email">{act.button}</button> : null}
              {ready && act.path === "send" && card ? <button class={buttonClass} name="collect" value="charge">Charge {cardName(card)}</button> : null}
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
      if (!(await act.allowed(inv, c))) return back(c, self, "not-now");
      if (!(await stripeReady(c))) return c.redirect(`${self}/${act.path}`, 303);
      const body = await c.req.parseBody();
      const r = await act.run(c, inv, body);
      if (!r.ok) {
        // A refused charge sent the invoice all the same: its page says so and offers what next.
        if ("reason" in r && (r.reason === "declined" || r.reason === "action")) return back(c, self, "charge-refused");
        return c.redirect(listUrl(`${self}/${act.path}`, { problem: r.message }), 303);
      }
      if (act.path === "send") await sent(c, { kind: "invoice", id: inv.id, email: inv.email });
      return back(c, self, typeof act.done === "string" ? act.done : act.done(body));
    });
  }

  // ---- recurring invoices and saved cards (recurring-admin.tsx) ------------

  recurringRoutes(app, {
    getDb, base, timeZone: opts.timeZone, currency: (opts.currency ?? "usd").toLowerCase(), daysUntilDue: opts.daysUntilDue ?? 30, source: opts.source,
    framed, back, stripeOf, More, Lines, menuItem, menuButton, customerHref: opts.customerHref, word: W,
    quoteChanged: async (c, quoteId) => {
      const qt = opts.proposal ? await quoteById(getDb(c), quoteId) : null;
      if (qt) await opts.proposal!.saved(c, qt);
    },
  });

  // ---- tax rates -------------------------------------------------------------

  const ratesPage = async (c: Ctx, errors: Errors = {}, status = 200) => {
    const rates = await taxRates(getDb(c));
    const self = `${base}/tax-rates`;
    // A setting, as Jobber and Stripe keep tax rates: reached from a quote's or invoice's Tax choice, not a tab.
    return framed(c, self, { title: "Tax rates", back: opts.settings ?? { href: base, label: "Invoices" } }, (
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

  // ---- record a payment ------------------------------------------------------
  // Paid another way (cash, a check, a transfer), all or part, as Jobber's Collect payment and HubSpot's
  // Record payment: the amount (what is still owed, unless less came), how, when, and a reference.

  const paymentPage = async (c: Ctx, inv: Invoice, v: { amount: string; method: string; on: string; reference: string; key: string }, problem: string | null, status = 200) => {
    const self = `${base}/${inv.id}`;
    const left = Number(inv.total_cents) - (await paidSoFar(getDb(c), inv.id));
    const ready = await stripeReady(c);
    return framed(c, base, { title: inv.number ? `Record payment: invoice ${inv.number}` : "Record payment", back: { href: self, label: inv.number ? `Invoice ${inv.number}` : "Draft invoice" } }, (
      <>
        {problem ? <p role="alert" class={"mb-4 " + alertClass}>{problem}</p> : null}
        {ready ? null : needStripe}
        <Section title="The payment" class="max-w-2xl">
          <p class="mb-4 max-w-prose text-ink-2">
            {money(left, inv.currency)} is still owed of {money(inv.total_cents, inv.currency)}. Stripe keeps the payment on the invoice; no card is charged.
            Part of it leaves the rest owed on their payment page.
          </p>
          <form method="post" action={`${self}/payment`} class="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="key" value={v.key} />
            <label class={fieldClass}>Amount ({inv.currency.toUpperCase()})
              <input name="amount" required inputmode="decimal" value={v.amount} class={controlClass} />
            </label>
            <label class={fieldClass}>Method
              <select name="method" class={controlClass}>
                {PAYMENT_METHODS.map((m) => <option value={m} selected={m === v.method}>{m}</option>)}
              </select>
            </label>
            <label class={fieldClass}>Date paid
              <input name="on" type="date" required value={v.on} max={today()} class={controlClass} />
            </label>
            <label class={fieldClass}>Reference
              <input name="reference" maxlength={100} value={v.reference} placeholder="Check number" class={controlClass} />
            </label>
            <div class="flex items-center gap-4 sm:col-span-2">
              {ready ? <button class={primaryClass}>Record payment</button> : null}
              <a href={self} class="text-label text-ink-2">Cancel</a>
            </div>
          </form>
        </Section>
      </>
    ), status);
  };
  const owing = (i: Invoice) => i.status === "open" || i.status === "uncollectible";
  app.get("/:id{[0-9]+}/payment", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    if (!owing(inv)) return back(c, `${base}/${inv.id}`, "not-now");
    const left = Number(inv.total_cents) - (await paidSoFar(getDb(c), inv.id));
    return paymentPage(c, inv, { amount: amountInput(left, inv.currency), method: "Check", on: today(), reference: "", key: crypto.randomUUID() }, null);
  });
  app.post("/:id{[0-9]+}/payment", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    const self = `${base}/${inv.id}`;
    if (!owing(inv)) return back(c, self, "not-now");
    const body = await c.req.parseBody();
    const v = { amount: str(body.amount).trim(), method: str(body.method), on: str(body.on), reference: str(body.reference).trim().slice(0, 100), key: str(body.key) };
    const cents = toMinor(v.amount, inv.currency);
    const method = PAYMENT_METHODS.find((m) => m === v.method);
    const problem = cents === null || cents <= 0 ? "Enter the amount paid, like 120 or 120.50."
      : !method ? "Choose how it was paid."
      : !isDay(v.on) || v.on > today() ? "Enter the day it was paid, today or before." : null;
    if (problem) return paymentPage(c, inv, v, problem, 422);
    const r = await recordPayment(getDb(c), stripeOf(c), inv.id, { amountCents: cents!, method: method!, paidOn: v.on, reference: v.reference || null, key: v.key, timeZone: opts.timeZone }, c.get("user"), opts.now?.());
    // Stripe refused it: the form comes back with a new key, so a corrected amount is a new request to Stripe.
    if (!r.ok) return paymentPage(c, inv, r.reason === "stripe" ? { ...v, key: crypto.randomUUID() } : v, r.message, r.reason === "stripe" ? 502 : 422);
    return back(c, self, r.remaining === 0 ? "payment-recorded-all" : "payment-recorded");
  });

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


/**
 * A quote or invoice, new or being edited; `submit` says which: Create quote when it posts to the list (a new one), Save when to its own page.
 * `currency` is the app's own (crm.config.json's): a document in it asks nothing, as Stripe takes it from the account; one in another shows the field.
 */
function DocForm({ kind, action, v, errors, rates, cancel, submit, taxPage, currency }: { kind: "quote" | "invoice"; action: string; v: FormValues; errors: Errors; rates: TaxRate[]; cancel: string; submit: string; taxPage: string; currency?: string }) {
  const ownCurrency = !!currency && v.currency.toLowerCase() === currency.toLowerCase() && !errors.currency;
  const err = (k: string) => (errors[k] ? <span class="text-ink" id={`err-${k.replace(/\./g, "-")}`}>{errors[k]}</span> : null);
  const problems = Object.keys(errors).length;
  return (
    <form method="post" action={action} class="flex flex-col gap-4">
      {problems ? <p role="alert" class={alertClass}>Fix what is marked below. Nothing was saved.</p> : null}
      {errors.status ? <p role="alert" class={alertClass}>{errors.status}</p> : null}
      <input type="hidden" name="visit_id" value={v.visit_id} />
      {kind === "quote" ? <input type="hidden" name="deal_id" value={v.deal_id} /> : <input type="hidden" name="quote_id" value={v.quote_id ?? ""} />}
      <CustomerFields v={v} errors={errors} />
      <LineItems lines={v.lines} errors={errors} rates={rates} taxPage={taxPage} />
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
