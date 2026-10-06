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
import { Flash, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { cut, readCursor } from "../admin/keyset";
import { AdminLayout, type NavItem } from "../admin/layout";
import { DataTable, SearchBar, TableRows, When, type TableSpec } from "../admin/list";
import { idParam, isPartial, listUrl, str } from "../admin/query";
import { buttonClass, controlClass, StatusBadge, type StatusOption } from "../admin/status";
import type { GetDb } from "../data/db";
import { envOf } from "../data/env";
import { sendEmail, type Email, type Sent } from "../data/send";
import { formatMoney } from "../payments/money";
import { stripeFrom, type Stripe } from "../payments/stripe";
import { dayText, quoteHtml, quoteMessage, sendQuote, taxSummary } from "./document";
import { createTaxRate, percentText, setTaxRateActive, taxRates, type TaxRate } from "../payments/tax";
import { amountInput, type Errors, type SavedLine } from "./lines";
import {
  copyQuote, createQuote, decideQuote, expireQuote, markSent, QUOTE_STATUSES, QUOTE_STATUS_LABELS, quoteById, quotesPage, saveQuote, shownStatus,
  type Quote, type QuoteRow, type QuoteStatus,
} from "./quotes";
import {
  createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, invoicesPage, INVOICE_STATUSES, INVOICE_STATUS_LABELS, saveInvoice,
  type Invoice, type InvoiceRow, type InvoiceStatus,
} from "./invoices";
import { closePayLink, markPaidOutOfBand, markUncollectible, payLinkForQuote, sendInvoice, voidInvoice } from "./stripe";

type Ctx = Context<{ Variables: TeamVars }>;
export type Frame = (p: { title: string; user: string; children: Child }) => Child;

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
  /** A new quote is valid this many days; default 30. */
  validDays?: number;
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
  /** More on a quote's page: the CRM's customer, its job, "Make it a job". */
  quoteExtra?: (c: Ctx, qt: Quote) => Child | Promise<Child>;
  /** More on an invoice's page: the CRM's customer and job. */
  invoiceExtra?: (c: Ctx, inv: Invoice) => Child | Promise<Child>;
  /** More at the top of the invoices list: the CRM's paid-by-month table. */
  invoicesTop?: (c: Ctx) => Child | Promise<Child>;
  /** Days a new invoice gives to pay; default 30. */
  daysUntilDue?: number;
  /** The Stripe caller; default stripeFrom(envOf(c)), the owner's connected account. */
  stripe?: (c: Ctx) => Stripe;
};

export const INVOICE_OPTIONS: StatusOption[] = INVOICE_STATUSES.map((s) => ({
  value: s,
  label: INVOICE_STATUS_LABELS[s],
  tone: s === "paid" ? "accent" : s === "open" ? "strong" : s === "draft" ? "neutral" : "muted",
}));

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

const fieldClass = "flex flex-col gap-1 text-label text-ink-2";
const primaryClass =
  "rounded-control border border-accent bg-accent px-3 py-1 text-label font-semibold text-accent-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Today in the business's zone, as YYYY-MM-DD. */
export function todayIn(zone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const addDays = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** The form's repeated line fields as rows, by index. */
function formLines(body: Record<string, unknown>): { description: string; quantity: string; unit: string; tax_rate_id: string }[] {
  const all = (k: string) => {
    const v = body[k];
    return Array.isArray(v) ? v.map(str) : v === undefined ? [] : [str(v)];
  };
  const d = all("description"), q = all("quantity"), u = all("unit"), t = all("tax_rate_id");
  return Array.from({ length: Math.min(Math.max(d.length, q.length, u.length), 200) }, (_, i) => ({
    description: d[i] ?? "", quantity: q[i] ?? "", unit: u[i] ?? "", tax_rate_id: t[i] ?? "",
  }));
}

type FormValues = {
  email: string; name: string; phone: string; address: string; currency: string; valid_until: string; notes: string; terms: string;
  days_until_due: string; visit_id: string; lines: { description: string; quantity: string; unit: string; tax_rate_id: string }[];
};

function readForm(body: Record<string, unknown>): FormValues {
  return {
    email: str(body.email), name: str(body.name), phone: str(body.phone), address: str(body.address), currency: str(body.currency),
    valid_until: str(body.valid_until), notes: str(body.notes), terms: str(body.terms), days_until_due: str(body.days_until_due),
    visit_id: str(body.visit_id), lines: formLines(body),
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
    { href: `${base}/tax-rates`, label: "Tax rates" },
  ];
  const stripeOf = opts.stripe ?? ((c: Ctx) => stripeFrom(envOf(c)));
  const doc = { business: opts.business, timeZone: opts.timeZone };
  const send = opts.send ?? ((c: Ctx, mail: Email) => sendEmail(envOf(c), mail));
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  const framed = (c: Ctx, current: string, title: string, body: Child, status = 200) => {
    const user = c.get("user");
    if (!opts.Frame) return c.html(<AdminLayout title={title} css={opts.css} nav={links} current={current} user={user}>{body}</AdminLayout>, status as 200);
    const sections = (
      <nav aria-label="Quotes and invoices" class="mb-4 flex flex-wrap gap-1 text-label">
        {links.map((n) => (
          <a href={n.href} aria-current={current === n.href ? "page" : undefined}
            class={"rounded-control px-2 py-1 no-underline " + (current === n.href ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>
            {n.label}
          </a>
        ))}
      </nav>
    );
    return c.html(<>{opts.Frame({ title, user, children: <>{sections}{body}</> })}</>, status as 200);
  };
  const back = (c: Ctx, path: string, code: string) => c.redirect(withFlash(path, code), 303);
  const money = (cents: string | number, currency: string) => formatMoney(cents, currency);

  // ---- quotes --------------------------------------------------------------

  const spec: TableSpec<QuoteRow> = {
    id: "quotes",
    href: (r) => `${qbase}/${r.id}`,
    columns: [
      { label: "Quote", cell: (r) => r.number },
      { label: "For", cell: (r) => r.name ?? r.email },
      { label: "Email", cell: (r) => r.email, class: "hidden md:table-cell" },
      { label: "Total", cell: (r) => money(r.total_cents, r.currency), class: "text-right" },
      { label: "Status", cell: (r) => <StatusBadge value={shownStatus(r, todayIn(opts.timeZone))} options={QUOTE_OPTIONS} /> },
      { label: "Made", cell: (r) => <When at={r.created_at} timeZone={opts.timeZone} />, class: "hidden sm:table-cell" },
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
          empty={q || status ? <>Nothing matches. <a href={qbase}>Clear filters</a></> : "No quotes yet."} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    return framed(c, qbase, "Quotes", (
      <>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <p class="mb-3"><a href={`${qbase}/new`} class={buttonClass + " no-underline"}>New quote</a></p>
        <SearchBar action={qbase} target="#results" q={q} placeholder="Number, name or email"
          filters={[{ name: "status", label: "Status", options: QUOTE_OPTIONS, value: status, any: "Any status" }]} />
        {results}
      </>
    ));
  });

  const editor = async (c: Ctx, p: { title: string; action: string; values: FormValues; errors: Errors; current: string }, status = 200) => {
    const rates = await taxRates(getDb(c));
    return framed(c, p.current, p.title, <DocForm kind="quote" action={p.action} v={p.values} errors={p.errors} rates={rates} cancel={p.current} />, status);
  };

  // Prefilled from the query: a customer's page or a job hands over who, and the first line.
  app.get("/quotes/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const currency = (qy("currency") || opts.currency || "usd").toLowerCase();
    const values: FormValues = {
      email: qy("email"), name: qy("name"), phone: qy("phone"), address: qy("address"), currency,
      valid_until: addDays(todayIn(opts.timeZone), opts.validDays ?? 30), notes: "", terms: opts.terms ?? "", days_until_due: "", visit_id: qy("visit"),
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
    const extra = opts.quoteExtra ? await opts.quoteExtra(c, qt) : null;
    const invoices = (await invoicesFor(getDb(c), { quoteId: qt.id })).filter((i) => i.status !== "void");
    return framed(c, qbase, `Quote ${qt.number}`, (
      <>
        <p class="mb-3 text-label"><a href={qbase}>All quotes</a></p>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        {c.req.query("problem") ? <p role="alert" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">{c.req.query("problem")}</p> : null}
        <div class="mb-4 flex flex-wrap items-center gap-2">
          <StatusBadge value={shown} options={QUOTE_OPTIONS} />
          {qt.status === "draft" ? <a href={`${self}/edit`} class={buttonClass + " no-underline"}>Edit</a> : null}
          <a href={`${self}/document`} class={buttonClass + " no-underline"} target="_blank">Preview</a>
          {qt.status === "draft" || qt.status === "sent" ? (
            <a href={`${self}/send`} class={primaryClass + " no-underline"}>{qt.status === "sent" ? "Send again" : "Send"}</a>
          ) : null}
        </div>
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Lines">
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
                <p class="mb-2 text-label text-ink-3">When they say yes or no, by reply or on the phone.</p>
                <div class="flex flex-wrap gap-2">
                  <form method="post" action={`${self}/decide`}><input type="hidden" name="answer" value="accepted" /><button class={primaryClass}>Accepted</button></form>
                  <form method="post" action={`${self}/decide`}><input type="hidden" name="answer" value="declined" /><button class={buttonClass}>Declined</button></form>
                  {qt.status !== "expired" ? <form method="post" action={`${self}/expire`}><button class={buttonClass}>Expired</button></form> : null}
                </div>
              </Section>
            ) : null}
            {qt.status === "accepted" ? (
              <Section title="Invoice">
                {invoices.length ? (
                  invoices.map((i) => <p><a href={`${base}/${i.id}`}>{i.number ? `Invoice ${i.number}` : "The draft invoice"}</a>, {INVOICE_STATUS_LABELS[i.status].toLowerCase()}</p>)
                ) : (
                  <form method="post" action={`${self}/invoice`}><button class={primaryClass}>Make the invoice</button></form>
                )}
              </Section>
            ) : null}
            {extra}
            <Section title="Quote">
              <FieldList fields={[
                { label: "For", value: <>{qt.name ? <>{qt.name}<br /></> : null}<span class="break-all">{qt.email}</span>{qt.phone ? <><br />{qt.phone}</> : null}</> },
                ...(qt.address ? [{ label: "Address", value: qt.address }] : []),
                { label: "Valid until", value: qt.valid_until ? dayText(qt.valid_until) : "No date" },
                { label: "Sent", value: qt.sent_at ? <When at={qt.sent_at} timeZone={opts.timeZone} /> : "Not yet" },
                ...(qt.decided_at ? [{ label: QUOTE_STATUS_LABELS[qt.status], value: <><When at={qt.decided_at} timeZone={opts.timeZone} />{qt.decided_by ? ` by ${qt.decided_by}` : ""}</> }] : []),
                { label: "Made", value: <><When at={qt.created_at} timeZone={opts.timeZone} />{qt.created_by ? ` by ${qt.created_by}` : ""}</> },
              ]} />
              <form method="post" action={`${self}/copy`} class="mt-3">
                <button class={buttonClass}>Copy to a new quote</button>
              </form>
            </Section>
          </div>
        </div>
      </>
    ));
  });

  app.get("/quotes/:id/edit", async (c) => {
    const qt = await load(c);
    if (!qt) return c.notFound();
    if (qt.status !== "draft") return c.redirect(`${qbase}/${qt.id}`, 302);
    const values: FormValues = {
      email: qt.email, name: qt.name ?? "", phone: qt.phone ?? "", address: qt.address ?? "", currency: qt.currency,
      valid_until: qt.valid_until ?? "", notes: qt.notes ?? "", terms: qt.terms ?? "", days_until_due: "", visit_id: qt.visit_id ?? "",
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
    return framed(c, qbase, `Send quote ${qt.number}`, (
      <>
        <p class="mb-3 text-label"><a href={self}>Back to the quote</a></p>
        {problem ? <p role="alert" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">{problem}</p> : null}
        <Section title="The email">
          <FieldList fields={[
            { label: "To", value: <span class="break-all">{qt.email}</span> },
            { label: "Replies go to", value: <span class="break-all">{c.get("user")}</span> },
            { label: "Subject", value: msg.subject },
            { label: "Attached", value: opts.print ? `Quote ${qt.number}.pdf, where this server can print it; the lines are in the email either way` : "Nothing: the lines are in the email" },
          ]} />
          <pre class="mt-3 whitespace-pre-wrap break-words rounded-card border border-line bg-canvas p-3 font-body text-copy">{msg.text}</pre>
          <form method="post" action={`${self}/send`} class="mt-3 flex flex-col gap-3">
            <label class="flex items-start gap-2">
              <input type="checkbox" name="pay" value="1" class="mt-1" checked={!!payUrl} />
              <span>Add a Pay button: Stripe makes the invoice for these lines, the email links to its payment page, and paying it accepts the quote.</span>
            </label>
            <div><button class={primaryClass}>Send to {qt.email}</button></div>
          </form>
        </Section>
        <Section title="Sent it yourself?" class="mt-4">
          <p class="mb-2 text-label text-ink-3">If you emailed this text from your own mail, mark the quote sent.</p>
          <form method="post" action={`${self}/sent`}><button class={buttonClass}>Mark as sent</button></form>
        </Section>
      </>
    ));
  });

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
    return back(c, self, r.printError ? "sent-no-pdf" : "sent");
  });

  app.post("/quotes/:id/sent", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const r = await markSent(getDb(c), id, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
    return back(c, `${qbase}/${id}`, r.ok ? "marked-sent" : "not-now");
  });

  app.post("/quotes/:id/decide", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const answer = str((await c.req.parseBody()).answer);
    if (answer !== "accepted" && answer !== "declined") return back(c, `${qbase}/${id}`, "not-now");
    const r = await decideQuote(getDb(c), id, answer, c.get("user"));
    if (!r.ok && r.reason === "not_found") return c.notFound();
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
      { label: "Invoice", cell: (r) => r.number ?? `Draft ${r.id}` },
      { label: "For", cell: (r) => r.name ?? r.email },
      { label: "Total", cell: (r) => money(r.total_cents, r.currency), class: "text-right" },
      { label: "Status", cell: (r) => <><StatusBadge value={r.status} options={INVOICE_OPTIONS} />{r.livemode === false ? <span class="ml-1 text-label text-ink-3">test</span> : null}</> },
      { label: "Due", cell: (r) => (r.due_date ? dayText(r.due_date) : ""), class: "hidden sm:table-cell" },
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
          empty={q || asked ? <>Nothing matches. <a href={base}>Clear filters</a></> : "No invoices yet."} />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const top = opts.invoicesTop && !after ? await opts.invoicesTop(c) : null;
    return framed(c, base, "Invoices", (
      <>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        {top}
        <p class="mb-3"><a href={`${base}/new`} class={buttonClass + " no-underline"}>New invoice</a></p>
        <SearchBar action={base} target="#results" q={q} placeholder="Number, name or email"
          filters={[{ name: "status", label: "Status", options: [...INVOICE_OPTIONS, { value: "due", label: "Past due" }], value: params.status, any: "Any status" }]} />
        {results}
      </>
    ));
  });

  const invoiceEditor = async (c: Ctx, p: { title: string; action: string; values: FormValues; errors: Errors; current: string }, status = 200) => {
    const rates = await taxRates(getDb(c));
    return framed(c, base, p.title, <DocForm kind="invoice" action={p.action} v={p.values} errors={p.errors} rates={rates} cancel={p.current} />, status);
  };

  // Blank, or prefilled from the query: a customer's page or a job hands over who, and the first line.
  app.get("/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const values: FormValues = {
      email: qy("email"), name: qy("name"), phone: qy("phone"), address: qy("address"), currency: (qy("currency") || opts.currency || "usd").toLowerCase(),
      valid_until: "", notes: "", terms: "", days_until_due: String(opts.daysUntilDue ?? 30), visit_id: qy("visit"),
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

  app.get("/:id{[0-9]+}", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    const rates = await taxRates(getDb(c));
    const self = `${base}/${inv.id}`;
    const draft = inv.status === "draft" && !inv.stripe_invoice_id;
    const extra = opts.invoiceExtra ? await opts.invoiceExtra(c, inv) : null;
    return framed(c, base, inv.number ? `Invoice ${inv.number}` : "Draft invoice", (
      <>
        <p class="mb-3 text-label"><a href={base}>All invoices</a></p>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <div class="mb-4 flex flex-wrap items-center gap-2">
          <StatusBadge value={inv.status} options={INVOICE_OPTIONS} />
          {inv.livemode === false ? <span class="text-label text-ink-3">Stripe test mode: not real money</span> : null}
          {draft ? <a href={`${self}/edit`} class={buttonClass + " no-underline"}>Edit</a> : null}
          {inv.status === "draft" || (inv.status === "open" && !inv.sent_at) ? <a href={`${self}/send`} class={primaryClass + " no-underline"}>Send with Stripe</a> : null}
          {inv.hosted_url ? <a href={inv.hosted_url} target="_blank" rel="noopener" class={buttonClass + " no-underline"}>Their payment page</a> : null}
          {inv.pdf_url ? <a href={inv.pdf_url} target="_blank" rel="noopener" class={buttonClass + " no-underline"}>PDF</a> : null}
        </div>
        {inv.payment_failed_at && inv.status === "open" ? (
          <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
            A payment attempt failed <When at={inv.payment_failed_at} timeZone={opts.timeZone} />. The invoice is still open on their payment page.
          </p>
        ) : null}
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
            <Section title="Lines">
              <Lines qt={inv} rates={rates} />
            </Section>
            {inv.notes ? <Section title="Note on the invoice"><p class="whitespace-pre-wrap break-words">{inv.notes}</p></Section> : null}
          </div>
          <div class="flex flex-col gap-4">
            {inv.status === "open" || inv.status === "uncollectible" ? (
              <Section title="Paid another way, or not at all">
                <div class="flex flex-wrap gap-2">
                  <a href={`${self}/paid`} class={buttonClass + " no-underline"}>Mark paid</a>
                  {inv.status === "open" ? <a href={`${self}/uncollectible`} class={buttonClass + " no-underline"}>Uncollectible</a> : null}
                  <a href={`${self}/void`} class={buttonClass + " no-underline"}>Void</a>
                </div>
              </Section>
            ) : null}
            {extra}
            <Section title="Invoice">
              <FieldList fields={[
                { label: "For", value: <>{inv.name ? <>{inv.name}<br /></> : null}<span class="break-all">{inv.email}</span>{inv.phone ? <><br />{inv.phone}</> : null}</> },
                inv.due_date ? { label: "Due", value: dayText(inv.due_date) } : { label: "Days to pay", value: String(inv.days_until_due) },
                { label: "Sent", value: inv.sent_at ? <When at={inv.sent_at} timeZone={opts.timeZone} /> : "Not yet" },
                ...(inv.paid_at ? [{ label: "Paid", value: <When at={inv.paid_at} timeZone={opts.timeZone} /> }] : []),
                ...(inv.quote_id ? [{ label: "From", value: <a href={`${qbase}/${inv.quote_id}`}>the quote</a> }] : []),
                { label: "Made", value: <><When at={inv.created_at} timeZone={opts.timeZone} />{inv.created_by ? ` by ${inv.created_by}` : ""}</> },
              ]} />
              {draft ? (
                <form method="post" action={`${self}/discard`} class="mt-3">
                  <button class={buttonClass}>Discard this draft</button>
                </form>
              ) : null}
            </Section>
          </div>
        </div>
      </>
    ));
  });

  app.get("/:id{[0-9]+}/edit", async (c) => {
    const inv = await loadInvoice(c);
    if (!inv) return c.notFound();
    if (inv.status !== "draft" || inv.stripe_invoice_id) return c.redirect(`${base}/${inv.id}`, 302);
    const values: FormValues = {
      email: inv.email, name: inv.name ?? "", phone: inv.phone ?? "", address: inv.address ?? "", currency: inv.currency,
      valid_until: "", notes: inv.notes ?? "", terms: "", days_until_due: String(inv.days_until_due), visit_id: inv.visit_id ?? "", lines: linesOf(inv),
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
      path: "send", title: "Send with Stripe", button: "Send with Stripe", done: "invoice-sent",
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
      path: "uncollectible", title: "Uncollectible", button: "Mark uncollectible", done: "asked-uncollectible",
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
      return framed(c, base, `${act.title}: ${inv.number ? `invoice ${inv.number}` : "draft invoice"}`, (
        <>
          <p class="mb-3 text-label"><a href={self}>Back to the invoice</a></p>
          {problem ? <p role="alert" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">{problem}</p> : null}
          <Section title="What happens">
            <p class="mb-3 max-w-prose">{act.say(inv)}</p>
            <form method="post" action={`${self}/${act.path}`}><button class={primaryClass}>{act.button}</button></form>
          </Section>
        </>
      ));
    });
    app.post(`/:id{[0-9]+}/${act.path}`, async (c) => {
      const inv = await loadInvoice(c);
      if (!inv) return c.notFound();
      const self = `${base}/${inv.id}`;
      if (!act.allowed(inv)) return back(c, self, "not-now");
      const r = await act.run(c, inv);
      if (!r.ok) return c.redirect(listUrl(`${self}/${act.path}`, { problem: r.message }), 303);
      return back(c, self, act.done);
    });
  }

  // ---- tax rates -------------------------------------------------------------

  const ratesPage = async (c: Ctx, errors: Errors = {}, status = 200) => {
    const rates = await taxRates(getDb(c));
    const self = `${base}/tax-rates`;
    return framed(c, self, "Tax rates", (
      <>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <p class="mb-4 max-w-prose text-ink-2">
          A rate never changes once it is on a quote or an invoice. For a new percent, add a rate and stop offering the old one.
        </p>
        {rates.length ? (
          <ul class="mb-6 flex flex-col gap-2">
            {rates.map((r) => (
              <li class="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface px-3 py-2">
                <span>
                  {r.name}, {percentText(r.percent_bp)}{r.inclusive ? ", included in prices" : ""}
                  {r.active ? null : <span class="text-ink-3"> (not offered)</span>}
                </span>
                <form method="post" action={`${self}/${r.id}/active`}>
                  <input type="hidden" name="active" value={r.active ? "0" : "1"} />
                  <button class={buttonClass}>{r.active ? "Stop offering" : "Offer again"}</button>
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
            <label class="flex items-center gap-2 self-end text-label text-ink-2"><input type="checkbox" name="inclusive" /> Included in prices</label>
            <div class="sm:col-span-3"><button class={primaryClass}>Add</button></div>
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

function DocForm({ kind, action, v, errors, rates, cancel }: { kind: "quote" | "invoice"; action: string; v: FormValues; errors: Errors; rates: TaxRate[]; cancel: string }) {
  const err = (k: string) => (errors[k] ? <span class="text-ink" id={`err-${k.replace(/\./g, "-")}`}>{errors[k]}</span> : null);
  const offered = rates.filter((r) => r.active || v.lines.some((l) => l.tax_rate_id === r.id));
  const rows = [...v.lines, ...Array.from({ length: Math.max(BLANK_ROWS, 5 - v.lines.length) }, () => ({ description: "", quantity: "", unit: "", tax_rate_id: "" }))];
  const problems = Object.keys(errors).length;
  return (
    <form method="post" action={action} class="flex flex-col gap-4">
      {problems ? <p role="alert" class="rounded-card border border-line-strong bg-panel px-4 py-2">Fix what is marked below. Nothing was saved.</p> : null}
      {errors.status ? <p role="alert" class="rounded-card border border-line-strong bg-panel px-4 py-2">{errors.status}</p> : null}
      <input type="hidden" name="visit_id" value={v.visit_id} />
      <Section title="Who it is for">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class={fieldClass}>Email<input name="email" type="email" required value={v.email} maxlength={254} class={controlClass} />{err("email")}</label>
          <label class={fieldClass}>Name<input name="name" value={v.name} maxlength={200} class={controlClass} />{err("name")}</label>
          <label class={fieldClass}>Phone<input name="phone" type="tel" value={v.phone} maxlength={50} class={controlClass} />{err("phone")}</label>
          <label class={fieldClass}>Address<input name="address" value={v.address} maxlength={500} autocomplete="off" class={controlClass} />{err("address")}</label>
        </div>
      </Section>
      <Section title="Lines">
        <p class="mb-3 text-label text-ink-3">Blank rows are left out. Save to get more rows.</p>
        {err("lines")}
        <div class="flex flex-col gap-3">
          {rows.map((l, i) => (
            <fieldset class="grid gap-2 border-b border-line pb-3 sm:grid-cols-12">
              <legend class="sr-only">Line {i + 1}</legend>
              <label class={fieldClass + " sm:col-span-6"}>Description<input name="description" value={l.description} maxlength={500} class={controlClass} />{err(`lines.${i}.description`)}</label>
              <label class={fieldClass + " sm:col-span-2"}>Qty<input name="quantity" value={l.quantity} placeholder="1" inputmode="decimal" class={controlClass} />{err(`lines.${i}.quantity`)}</label>
              <label class={fieldClass + " sm:col-span-2"}>Price<input name="unit" value={l.unit} inputmode="decimal" class={controlClass} />{err(`lines.${i}.unit`)}</label>
              <label class={fieldClass + " sm:col-span-2"}>Tax
                <select name="tax_rate_id" class={controlClass}>
                  <option value="">None</option>
                  {offered.map((r) => <option value={r.id} selected={r.id === l.tax_rate_id}>{r.name} {percentText(r.percent_bp)}</option>)}
                </select>{err(`lines.${i}.tax_rate_id`)}
              </label>
            </fieldset>
          ))}
        </div>
      </Section>
      <Section title={kind === "quote" ? "Terms" : "Payment"}>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class={fieldClass}>Currency<input name="currency" value={v.currency} maxlength={3} class={controlClass} />{err("currency")}</label>
          {kind === "quote" ? (
            <label class={fieldClass}>Valid until<input name="valid_until" type="date" value={v.valid_until} class={controlClass} />{err("valid_until")}</label>
          ) : (
            <label class={fieldClass}>Days to pay<input name="days_until_due" inputmode="numeric" value={v.days_until_due} class={controlClass} />{err("days_until_due")}</label>
          )}
          <label class={fieldClass + " sm:col-span-2"}>{kind === "quote" ? "Notes for them" : "Note on the invoice"}<textarea name="notes" rows={3} maxlength={5000} class={controlClass}>{v.notes}</textarea>{err("notes")}</label>
          {kind === "quote" ? (
            <label class={fieldClass + " sm:col-span-2"}>Terms<textarea name="terms" rows={2} maxlength={5000} class={controlClass}>{v.terms}</textarea>{err("terms")}</label>
          ) : null}
        </div>
      </Section>
      <div class="flex flex-wrap items-center gap-3">
        <button class={primaryClass}>Save</button>
        <a href={cancel} class="text-label text-ink-2">Cancel</a>
      </div>
    </form>
  );
}
