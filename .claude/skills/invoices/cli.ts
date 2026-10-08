// Quotes and invoices from chat: the same changes as the pages, as two
// commands every app that carries this skill runs the same way. Machine only.
// An app's scripts/quotes.mjs and scripts/invoices.mjs are a few lines that
// pass its own settings:
//
//   await quotesCli(process.argv.slice(2), {
//     withDb, business: "Acme", currency: "usd", timeZone: "America/Denver", terms: null, daysUntilDue: 30,
//     source: "crm", env: machineEnv(), print: printPdf,
//     person: (db, ref) => …,                       // <who>: the app's customers, by id, email or phone
//     more: { help: "  job <id> …", commands: { job: async (db, a, rest, by) => … } },
//   });
//
// Nothing reaches a customer or moves money without --confirm. The AI adds
// it when the owner asked for that action; otherwise it shows the preview.
import { cut } from "../admin/keyset";
import { done, fail, flag, flags, has, limitOf, localTime, misused, noMore, out, parseArgs, usage, type Args } from "../data/cli.mjs";
import type { Db } from "../data/db";
import { sendEmail } from "../data/send";
import { formatMoney } from "../payments/money";
import { stripeFrom } from "../payments/stripe";
import { createTaxRate, percentText, taxRates, type TaxRate } from "../payments/tax";
import { todayIn } from "./admin";
import { quoteMessage, sendQuote } from "./document";
import {
  createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, invoicesPage, owed, saveInvoice, INVOICE_STATUSES,
  type Invoice, type InvoiceFields, type InvoiceStatus,
} from "./invoices";
import { amountInput, type LineInput } from "./lines";
import {
  createQuote, decideQuote, expireQuote, markSent, quoteById, quotesFor, quotesPage, saveQuote, shownStatus, QUOTE_STATUSES,
  type Moved, type Quote, type QuoteFields, type QuoteStatus,
} from "./quotes";
import { closePayLink, markPaidOutOfBand, markUncollectible, payLinkForQuote, sendInvoice, voidInvoice } from "./stripe";

/** Someone a quote or invoice is for, as the app knows them. */
export type Person = { email: string | null; name: string | null; phone: string | null; address: string | null };

export type Extra = (db: Db, a: Args, rest: string[], by: string) => Promise<void>;

export type InvoicesCli = {
  /** Opens the project's database (set up first) for the length of the command. */
  withDb: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  /** The name on quotes; "" leaves it off. */
  business: string;
  currency: string;
  timeZone: string;
  terms?: string | null;
  daysUntilDue?: number;
  /** This app's slug, stored on what it makes. */
  source: string;
  /** Where the sender and the Stripe key are found (data/cli.mjs machineEnv). */
  env: Record<string, string | undefined>;
  /** A quote's PDF, where this machine has a browser (reports/print.ts). */
  print?: (html: string) => Promise<Uint8Array | null>;
  /** <who>: a person the app knows by id, email or phone. Without it, <who> is an email. */
  person?: (db: Db, ref: string) => Promise<Person | null>;
  /** When the app has quotes and invoices switched off: the line that says so. */
  off?: string | null;
  /** After a quote or an invoice goes to its customer (sent, or marked sent): the CRM counts it as contact. */
  afterSend?: (db: Db, doc: { kind: "quote" | "invoice"; id: string; email: string }, by: string) => Promise<void>;
  /** After accept or decline: what the app did about it (the CRM wins the deal), as lines to print. */
  afterDecide?: (db: Db, qt: Quote, by: string) => Promise<string[]>;
  /** The app's own commands: their help lines, what each does, and the flags each takes (unchecked when not given). */
  more?: { help: string; commands: Record<string, Extra>; flags?: Record<string, string[]> };
};

/** Who acted: --as, else APP_USER, else AI. */
const actor = (a: Args) => flag(a, "as") || process.env.APP_USER || process.env.CRM_USER || "AI";
const money = (c: string | number, currency: string) => formatMoney(c, currency);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const ID = /^\d{1,18}$/;

/** <who> as a person: one the app knows, or a plain email someone gave. `at` is "quotes add". */
async function personOf(db: Db, cli: InvoicesCli, ref: string | undefined, at: string): Promise<Person> {
  const script = at.split(" ")[0];
  if (!ref) misused(`${at}: it needs who it is for: an email${cli.person ? ", or a customer's id or phone" : ""}`, `node scripts/${script}.mjs --help`);
  const known = cli.person ? await cli.person(db, ref) : null;
  if (known) return known;
  if (ref.includes("@")) return { email: ref, name: null, phone: null, address: null };
  return fail(`${at}: no one is ${ref} (by id, email or phone); a new person is named by their email`, `node scripts/${script}.mjs ${at.slice(script.length + 1)} ann@example.com`);
}

/** --line "what|price", "what|qty|price" or "what|qty|price|tax rate" (a rate by name or id). */
export function lineFlags(a: Args, rates: TaxRate[], script: string): LineInput[] {
  const at = `${script} ${a._[0] ?? ""}`.trim();
  return flags(a, "line").map((raw) => {
    const parts = raw.split("|").map((p) => p.trim());
    if (parts.length < 2 || parts.length > 4) misused(`${at}: --line ${raw}: write it as "what|price", "what|qty|price" or "what|qty|price|tax rate"`, `node scripts/${script}.mjs --help`);
    const [description, ...more] = parts;
    const [quantity, unit, tax] = more.length === 1 ? ["1", more[0], ""] : [more[0], more[1], more[2] ?? ""];
    let rate = "";
    if (tax) {
      const r = rates.find((x) => x.active && (x.id === tax || x.name.toLowerCase() === tax.toLowerCase()));
      if (!r) fail(`${at}: --line ${raw}: no tax rate ${tax}; offered: ${rates.filter((x) => x.active).map((x) => `${x.name} (#${x.id})`).join(", ") || "none"}`, `node scripts/quotes.mjs tax-rate "Sales tax" 8.25`);
      rate = r.id;
    }
    return { description, quantity, unit, tax_rate_id: rate };
  });
}

/** Field errors as lines a person can act on: "--line 2 (price): ...", "--valid-until: ...". */
const FIELD_NAMES: Record<string, string> = { description: "what", quantity: "qty", unit: "price", tax_rate_id: "tax rate" };
/** The owner's Stripe, or a plain refusal naming the connection to ask for: never a stack trace. */
export function stripeOr(env: InvoicesCli["env"], at?: string): ReturnType<typeof stripeFrom> {
  try {
    return stripeFrom(env);
  } catch {
    fail(`${at ? at + ": " : ""}nothing was done: this app has no Stripe connection`,
      `python3 ~/tools/taskandtool.py request-connection stripe --why "send and collect invoices" --auth api_key --delivery edge`);
  }
}

export const problems = (errors: Record<string, string>) =>
  Object.entries(errors).map(([k, v]) => {
    const line = /^lines\.(\d+)\.(\w+)$/.exec(k);
    if (line) return `--line ${Number(line[1]) + 1} (${FIELD_NAMES[line[2]] ?? line[2]}): ${v}`;
    if (k === "status") return v;
    if (k === "lines") return `--line: ${v}`;
    return `--${k === "visit_id" ? "job" : k === "deal_id" ? "deal" : k === "days_until_due" ? "days" : k.replace(/_/g, "-")}: ${v}`;
  }).join("\n");

// ---- quotes -------------------------------------------------------------------

const QUOTE_FIELDS = ["line", "name", "phone", "address", "valid-until", "notes", "terms", "job", "deal", "currency", "as"];
const QUOTE_FLAGS: Record<string, string[]> = {
  list: ["status", "find", "limit", "customer"], show: [], add: QUOTE_FIELDS, edit: QUOTE_FIELDS, send: ["pay", "confirm", "as"],
  "mark-sent": ["as"], accept: ["as"], decline: ["as"], expire: ["as"], "tax-rates": [], "tax-rate": ["inclusive", "as"],
};
const QUOTE_ARITY: Record<string, number> = { list: 0, show: 1, add: 1, edit: 1, send: 1, "mark-sent": 1, accept: 1, decline: 1, expire: 1, "tax-rates": 0, "tax-rate": 2 };
const DONE: Record<string, string> = { "mark-sent": "marked sent", accept: "accepted", decline: "declined", expire: "expired" };
/** The status each of those leaves a quote in: one already there is done, not refused. */
const TO: Record<string, string> = { accept: "accepted", decline: "declined", expire: "expired" };

export async function quotesCli(argv: string[], cli: InvoicesCli): Promise<void> {
  const HELP = `quotes.mjs <command> [...] [--json] [--as <email>]      quotes, sent through the owner's own email sender

  list [--status ${QUOTE_STATUSES.join("|")}] [--find text] [--limit 50]
  list --customer <who>
  show <id>
  add <who> --line "<what>|[qty|]<price>[|<tax rate>]"... [--name n] [--phone p] [--address a]
            [--valid-until YYYY-MM-DD] [--notes n] [--terms t] [--job <id>] [--deal <id>] [--currency ${cli.currency}]
  edit <id> [the same flags]           a draft only; --line replaces every line
  send <id> [--pay]                    prints exactly what would go to whom; sends nothing. --pay adds a
                                       Pay button: Stripe's page for these lines; paying it accepts the quote
  send <id> [--pay] --confirm          sends it: when the owner asked for it, or said yes to the preview
  mark-sent <id>                       the owner emailed it themselves
  accept <id> | decline <id> | expire <id>
  tax-rates                            the rates a line can carry
  tax-rate "<name>" <percent> [--inclusive]
${cli.more?.help ?? ""}
<who> is ${cli.person ? "a customer's id, email or phone (their name, phone and address are copied in), or" : ""} an
email. A line is "Fence repair|450.00", "Hours|2.5|80" or "Install|1|450|Sales tax" (a rate by name or id).
Prices are in the quote's currency; totals are computed from the lines. --as records who acted.

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;
  // --pay and --inclusive take no value: `send --pay 3` keeps 3 as the id.
  const a = parseArgs(argv, { bare: ["pay", "inclusive"] });
  const [cmd, ...rest] = a._;
  if (cli.off && has(a, "help")) console.log(cli.off + "\n");
  const commands = ["list", "show", "add", "edit", "send", "mark-sent", "accept", "decline", "expire", "tax-rates", "tax-rate", ...Object.keys(cli.more?.commands ?? {})];
  usage(a, cmd, commands, HELP, "quotes", { ...QUOTE_FLAGS, ...cli.more?.flags });
  if (cli.off) fail(cli.off);
  const at = `quotes ${cmd}`;
  if (QUOTE_ARITY[cmd] !== undefined) noMore(rest, QUOTE_ARITY[cmd], at);
  const limit = cmd === "list" ? limitOf(a, at) : 50;
  const json = has(a, "json");
  const doc = { business: cli.business, timeZone: cli.timeZone };
  const local = (d: Date | string) => localTime(d, cli.timeZone);
  const fmt = (r: Quote) =>
    [`#${r.id}`, r.number, `[${shownStatus(r, todayIn(cli.timeZone))}]`, r.name ? `${r.name} <${r.email}>` : r.email, money(r.total_cents, r.currency),
      r.valid_until ? `valid until ${r.valid_until}` : "", r.visit_id ? `job #${r.visit_id}` : "", r.deal_id ? `deal #${r.deal_id}` : ""].filter(Boolean).join("  ");
  const quoteOr = async (db: Db, id: string | undefined) => {
    if (!id || !ID.test(id)) misused(`${at}: name a quote by its id (#12 is 12)`, "node scripts/quotes.mjs list");
    return (await quoteById(db, id)) ?? fail(`${at}: no quote ${id}`, "node scripts/quotes.mjs list");
  };

  await cli.withDb(async (db) => {
    const by = actor(a);
    const extra = cli.more?.commands[cmd];
    if (extra) return extra(db, a, rest, by);
    switch (cmd) {
      case "list": {
        if (has(a, "customer")) {
          const p = await personOf(db, cli, flag(a, "customer"), "quotes list --customer");
          const rows = p.email ? await quotesFor(db, { email: p.email }) : [];
          if (json) return out(true, rows, String);
          return done(at, rows.length ? `${plural(rows.length, "quote")} for ${p.name ?? p.email}` : `no quotes for ${p.name ?? p.email ?? "them"}`, { lines: rows.map(fmt) });
        }
        const asked = flag(a, "status");
        if (asked && !QUOTE_STATUSES.includes(asked as QuoteStatus)) misused(`${at}: --status must be one of ${QUOTE_STATUSES.join(", ")}`, "node scripts/quotes.mjs list --status sent");
        const { page, next } = cut(await quotesPage(db, { q: flag(a, "find") ?? null, status: (asked as QuoteStatus) ?? null }, null, limit, todayIn(cli.timeZone)), limit);
        if (json) return out(true, page, String);
        if (!page.length) return done(at, `no quotes${asked ? ` ${asked}` : ""}`, { next: "node scripts/quotes.mjs add --help" });
        return done(at, `${plural(page.length, "quote")}${asked ? ` ${asked}` : ""}, newest first`, {
          lines: [...page.map(fmt), ...(next ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : [])],
        });
      }

      case "show": {
        const qt = await quoteOr(db, rest[0]);
        const rates = await taxRates(db);
        if (json) return out(true, qt, String);
        return done(at, fmt(qt), {
          lines: [
            ...qt.lines.map((l) => `${l.position}. ${l.description}: ${l.quantity} x ${money(l.unit_cents, qt.currency)} = ${money(l.amount_cents, qt.currency)}${l.tax_rate_id ? `  (${rates.find((r) => r.id === l.tax_rate_id)?.name ?? "tax"} ${money(l.tax_cents, qt.currency)})` : ""}`),
            `subtotal ${money(qt.subtotal_cents, qt.currency)}, tax ${money(qt.tax_cents, qt.currency)}, total ${money(qt.total_cents, qt.currency)}`,
            qt.notes ? `notes: ${qt.notes}` : "",
            qt.terms ? `terms: ${qt.terms}` : "",
            qt.sent_at ? `sent ${local(qt.sent_at)}` : "not sent",
            qt.decided_at ? `${qt.status} ${local(qt.decided_at)}${qt.decided_by ? " by " + qt.decided_by : ""}` : "",
            `made ${local(qt.created_at)}${qt.created_by ? " by " + qt.created_by : ""}`,
          ].filter(Boolean),
        });
      }

      case "add":
      case "edit": {
        const rates = await taxRates(db);
        const current = cmd === "edit" ? await quoteOr(db, rest[0]) : null;
        let f: QuoteFields;
        if (current) {
          f = {
            email: current.email, name: current.name, phone: current.phone, address: current.address, currency: current.currency,
            valid_until: current.valid_until, notes: current.notes, terms: current.terms, visit_id: current.visit_id, deal_id: current.deal_id,
            lines: current.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: amountInput(l.unit_cents, current.currency), tax_rate_id: l.tax_rate_id ?? "" })),
          };
        } else {
          const p = await personOf(db, cli, rest[0], at);
          const valid = new Date(Date.parse(todayIn(cli.timeZone) + "T00:00:00Z") + 30 * 86_400_000).toISOString().slice(0, 10);
          f = { ...p, currency: cli.currency, valid_until: valid, terms: cli.terms ?? null, lines: [] };
        }
        const set = (k: keyof QuoteFields, flagName: string) => {
          if (has(a, flagName)) f[k] = flag(a, flagName) ?? "";
        };
        set("name", "name"); set("phone", "phone"); set("address", "address"); set("valid_until", "valid-until");
        set("notes", "notes"); set("terms", "terms"); set("visit_id", "job"); set("deal_id", "deal"); set("currency", "currency");
        if (has(a, "line")) f.lines = lineFlags(a, rates, "quotes");
        const r = current ? await saveQuote(db, current.id, f, by) : await createQuote(db, f, by, cli.source);
        if (!r.ok) fail(`${at}: not saved\n${problems(r.errors)}`, "node scripts/quotes.mjs --help");
        if (json) return out(true, r.value, String);
        return done(at, `${current ? "saved" : "added"} ${fmt(r.value)}`, { next: `node scripts/quotes.mjs send ${r.value.id}` });
      }

      case "send": {
        const qt = await quoteOr(db, rest[0]);
        if (qt.status !== "draft" && qt.status !== "sent") fail(`${at}: quote ${qt.number} is ${qt.status}; only a draft or sent quote is sent`, `node scripts/quotes.mjs show ${qt.id}`);
        const rates = await taxRates(db);
        const pay = has(a, "pay");
        if (!has(a, "confirm")) {
          const m = quoteMessage(qt, rates, doc, pay ? "<the payment page Stripe makes>" : null);
          if (json) return out(true, { to: qt.email, subject: m.subject, text: m.text }, String);
          return done(at, `quote ${qt.number} to ${qt.email}, ${money(qt.total_cents, qt.currency)}`, {
            lines: [`Subject: ${m.subject}`, `Attached: Quote ${qt.number}.pdf, when this machine can print it`, "", m.text, ""],
            waits: `node scripts/quotes.mjs send ${qt.id}${pay ? " --pay" : ""}`,
          });
        }
        let payUrl: string | null = null;
        if (pay) {
          const link = await payLinkForQuote(db, stripeOr(cli.env, at), qt.id, by, cli.source, cli.daysUntilDue ?? 30);
          if (!link.ok) fail(`${at}: nothing was sent: the Pay button could not be made: ${link.message}`, `node scripts/quotes.mjs send ${qt.id} --confirm, without --pay`);
          payUrl = link.url;
        }
        const r = await sendQuote(db, qt, rates, doc, { send: (mail) => sendEmail(cli.env, mail), print: cli.print, replyTo: flag(a, "as") ?? null, by, payUrl });
        if (r.sent.status === "none") fail(`${at}: nothing was sent: ${r.sent.why}\n  Give the owner the text to send themselves, then mark it sent`, `node scripts/quotes.mjs send ${qt.id}, without --confirm, for the text; then node scripts/quotes.mjs mark-sent ${qt.id}`);
        if (r.sent.status === "failed") fail(`${at}: the email did not go: ${r.sent.error}`, "python3 ~/tools/taskandtool.py list-connections, to check the email sender");
        await cli.afterSend?.(db, { kind: "quote", id: qt.id, email: qt.email }, by);
        if (json) return out(true, { sent: true, pdf: r.pdf }, String);
        return done(at, `sent quote ${qt.number} to ${qt.email}${r.pdf ? " with its PDF" : r.printError ? ` without a PDF (${r.printError})` : " (no browser here: the lines are in the email)"}`, {
          lines: payUrl ? [`with a Pay button: ${payUrl}`] : [],
          next: `node scripts/quotes.mjs show ${qt.id}`,
        });
      }

      case "mark-sent":
      case "accept":
      case "decline":
      case "expire": {
        const id = (await quoteOr(db, rest[0])).id;
        const r = cmd === "mark-sent" ? await markSent(db, id, by)
          : cmd === "expire" ? await expireQuote(db, id, by)
          : await decideQuote(db, id, cmd === "accept" ? "accepted" : "declined", by);
        if (!r.ok && r.status === TO[cmd]) {
          if (json) return out(true, await quoteById(db, id), String);
          return done(at, `quote ${id} is already ${r.status}; left alone`, { next: `node scripts/quotes.mjs show ${id}` });
        }
        if (!r.ok) fail(r.reason === "not_found" ? `${at}: no quote ${id}` : `${at}: quote ${id} is ${r.status}; nothing changed`, `node scripts/quotes.mjs show ${id}`);
        if (cmd === "mark-sent") await cli.afterSend?.(db, { kind: "quote", id, email: r.value.email }, by);
        const note = cmd === "decline" ? await closePayLink(db, () => stripeOr(cli.env, at), id, by) : null;
        const after = (cmd === "accept" || cmd === "decline") && cli.afterDecide ? await cli.afterDecide(db, r.value, by) : [];
        if (json) return out(true, r.value, String);
        return done(at, `${DONE[cmd]} ${fmt(r.value)}`, { lines: [...(note ? [note] : []), ...after], next: cmd === "accept" ? `node scripts/invoices.mjs from-quote ${id}` : undefined });
      }

      case "tax-rates": {
        const rates = await taxRates(db);
        if (json) return out(true, rates, String);
        if (!rates.length) return done(at, "no tax rates yet", { next: `node scripts/quotes.mjs tax-rate "Sales tax" 8.25` });
        return done(at, plural(rates.length, "tax rate"), {
          lines: rates.map((r) => `#${r.id}  ${r.name}  ${percentText(r.percent_bp)}${r.inclusive ? "  included in prices" : ""}${r.active ? "" : "  (not offered)"}`),
        });
      }

      case "tax-rate": {
        // Running it twice keeps one rate: a name already there is left alone.
        const same = (await taxRates(db)).find((r) => r.name.toLowerCase() === (rest[0] ?? "").trim().toLowerCase());
        if (same) {
          if (json) return out(true, same, String);
          return done(at, `${same.name} is already #${same.id} at ${percentText(same.percent_bp)}; left alone`, { next: "node scripts/quotes.mjs tax-rates" });
        }
        const r = await createTaxRate(db, { name: rest[0], percent: rest[1], inclusive: has(a, "inclusive") }, by);
        if (!r.ok) misused(`${at}: ${Object.values(r.errors).join(" ")}`, `node scripts/quotes.mjs tax-rate "Sales tax" 8.25`);
        if (json) return out(true, r.value, String);
        return done(at, `added #${r.value.id} ${r.value.name} ${percentText(r.value.percent_bp)}`, { next: "node scripts/quotes.mjs tax-rates" });
      }
    }
  });
}

// ---- invoices -----------------------------------------------------------------

const INVOICE_FIELDS = ["line", "days", "notes", "job", "currency", "as"];
const INVOICE_FLAGS: Record<string, string[]> = {
  list: ["status", "find", "limit", "customer"], show: [], owed: [], add: INVOICE_FIELDS, edit: INVOICE_FIELDS, "from-quote": ["as"],
  discard: ["as"], send: ["confirm", "as"], "mark-paid": ["confirm", "as"], void: ["confirm", "as"], uncollectible: ["confirm", "as"],
};
const INVOICE_ARITY: Record<string, number> = { list: 0, show: 1, owed: 1, add: 1, edit: 1, "from-quote": 1, discard: 1, send: 1, "mark-paid": 1, void: 1, uncollectible: 1 };

export async function invoicesCli(argv: string[], cli: InvoicesCli): Promise<void> {
  const days = cli.daysUntilDue ?? 30;
  const HELP = `invoices.mjs <command> [...] [--json] [--as <email>]      invoices, sent and collected by the owner's Stripe

  list [--status ${INVOICE_STATUSES.join("|")}|due] [--find text] [--limit 50]
  list --customer <who>
  show <id>
  owed <who>                           open invoices, live money only, per currency
  add <who> --line "<what>|[qty|]<price>[|<tax rate>]"... [--days ${days}] [--notes n] [--job <id>] [--currency ${cli.currency}]
  from-quote <quote id>                an accepted quote's lines, once
  edit <id> [the add flags]            a draft not yet in Stripe; --line replaces every line
  discard <id>                         a draft not yet in Stripe: kept as void
  send <id> | mark-paid <id> | void <id> | uncollectible <id>
                                       prints exactly what would happen; does nothing
  ... --confirm                        does it: when the owner asked for it, or said yes to the preview
${cli.more?.help ?? ""}
Stripe emails the invoice and hosts the page they pay on. Paid, void and
uncollectible arrive from Stripe's webhook, a few seconds after: show it to
see. mark-paid is for cash or a check; it charges nothing. --as records who acted.

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  if (cli.off && has(a, "help")) console.log(cli.off + "\n");
  const commands = ["list", "show", "owed", "add", "edit", "from-quote", "discard", "send", "mark-paid", "void", "uncollectible", ...Object.keys(cli.more?.commands ?? {})];
  usage(a, cmd, commands, HELP, "invoices", { ...INVOICE_FLAGS, ...cli.more?.flags });
  if (cli.off) fail(cli.off);
  const at = `invoices ${cmd}`;
  if (INVOICE_ARITY[cmd] !== undefined) noMore(rest, INVOICE_ARITY[cmd], at);
  const limit = cmd === "list" ? limitOf(a, at) : 50;
  const json = has(a, "json");
  const local = (d: Date | string) => localTime(d, cli.timeZone);
  const fmt = (r: Invoice) =>
    [`#${r.id}`, r.number ?? "(no number yet)", `[${r.status}]`, r.livemode === false ? "(test mode)" : "", r.name ? `${r.name} <${r.email}>` : r.email,
      money(r.total_cents, r.currency), r.due_date ? `due ${r.due_date}` : "", r.paid_at ? `paid ${local(r.paid_at)}` : "",
      r.quote_id ? `quote #${r.quote_id}` : "", r.visit_id ? `job #${r.visit_id}` : ""].filter(Boolean).join("  ");
  const invoiceOr = async (db: Db, id: string | undefined) => {
    if (!id || !ID.test(id)) misused(`${at}: name an invoice by its id (#12 is 12)`, "node scripts/invoices.mjs list");
    return (await invoiceById(db, id)) ?? fail(`${at}: no invoice ${id}`, "node scripts/invoices.mjs list");
  };

  await cli.withDb(async (db) => {
    const by = actor(a);
    const extra = cli.more?.commands[cmd];
    if (extra) return extra(db, a, rest, by);
    switch (cmd) {
      case "list": {
        if (has(a, "customer")) {
          const p = await personOf(db, cli, flag(a, "customer"), "invoices list --customer");
          const rows = p.email ? await invoicesFor(db, { email: p.email }) : [];
          if (json) return out(true, rows, String);
          return done(at, rows.length ? `${plural(rows.length, "invoice")} for ${p.name ?? p.email}` : `no invoices for ${p.name ?? p.email ?? "them"}`, { lines: rows.map(fmt) });
        }
        const asked = flag(a, "status");
        if (asked && asked !== "due" && !INVOICE_STATUSES.includes(asked as InvoiceStatus)) misused(`${at}: --status must be one of ${INVOICE_STATUSES.join(", ")}, due`, "node scripts/invoices.mjs list --status due");
        const status = asked && asked !== "due" ? (asked as InvoiceStatus) : null;
        const { page, next } = cut(await invoicesPage(db, { q: flag(a, "find") ?? null, status, due: asked === "due" }, null, limit, todayIn(cli.timeZone)), limit);
        if (json) return out(true, page, String);
        if (!page.length) return done(at, `no invoices${asked ? ` ${asked}` : ""}`);
        return done(at, `${plural(page.length, "invoice")}${asked ? ` ${asked}` : ""}, newest first`, {
          lines: [...page.map(fmt), ...(next ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : [])],
        });
      }

      case "show": {
        const inv = await invoiceOr(db, rest[0]);
        if (json) return out(true, inv, String);
        return done(at, fmt(inv), {
          lines: [
            ...inv.lines.map((l) => `${l.position}. ${l.description}: ${l.quantity} x ${money(l.unit_cents, inv.currency)} = ${money(l.amount_cents, inv.currency)}${l.tax_rate_id ? `  (tax ${money(l.tax_cents, inv.currency)})` : ""}`),
            `subtotal ${money(inv.subtotal_cents, inv.currency)}, tax ${money(inv.tax_cents, inv.currency)}, total ${money(inv.total_cents, inv.currency)}`,
            inv.notes ? `note: ${inv.notes}` : "",
            inv.hosted_url ? `their payment page: ${inv.hosted_url}` : "",
            inv.sent_at ? `sent ${local(inv.sent_at)}` : `not sent; ${inv.days_until_due} days to pay once it is`,
            inv.payment_failed_at && inv.status === "open" ? `a payment attempt failed ${local(inv.payment_failed_at)}` : "",
          ].filter(Boolean),
        });
      }

      case "owed": {
        const p = await personOf(db, cli, rest[0], at);
        const rows = p.email ? await owed(db, p.email) : [];
        if (json) return out(true, rows, String);
        return done(at, rows.length ? `${p.name ?? p.email} owes` : `${p.name ?? p.email} owes nothing on an open invoice`, {
          lines: rows.map((r) => `${money(r.cents, r.currency)} on ${plural(r.count, "open invoice")}`),
          next: rows.length ? `node scripts/invoices.mjs list --customer ${p.email}` : undefined,
        });
      }

      case "add":
      case "edit": {
        const rates = await taxRates(db);
        const current = cmd === "edit" ? await invoiceOr(db, rest[0]) : null;
        let f: InvoiceFields;
        if (current) {
          f = {
            email: current.email, name: current.name, phone: current.phone, address: current.address, currency: current.currency,
            days_until_due: String(current.days_until_due), notes: current.notes, visit_id: current.visit_id,
            lines: current.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: amountInput(l.unit_cents, current.currency), tax_rate_id: l.tax_rate_id ?? "" })),
          };
        } else {
          const p = await personOf(db, cli, rest[0], at);
          f = { ...p, currency: cli.currency, days_until_due: String(days), lines: [] };
        }
        if (has(a, "days")) f.days_until_due = flag(a, "days") ?? "";
        if (has(a, "notes")) f.notes = flag(a, "notes") ?? "";
        if (has(a, "job")) f.visit_id = flag(a, "job") ?? "";
        if (has(a, "currency")) f.currency = flag(a, "currency") ?? "";
        if (has(a, "line")) f.lines = lineFlags(a, rates, "invoices");
        const r = current ? await saveInvoice(db, current.id, f, by) : await createInvoice(db, f, by, cli.source);
        if (!r.ok) fail(`${at}: not saved\n${problems(r.errors)}`, "node scripts/invoices.mjs --help");
        if (json) return out(true, r.value, String);
        return done(at, `${current ? "saved" : "drafted"} ${fmt(r.value)}`, { next: `node scripts/invoices.mjs send ${r.value.id}` });
      }

      case "from-quote": {
        if (!rest[0] || !ID.test(rest[0])) misused(`${at}: name the quote by its id (#12 is 12)`, "node scripts/quotes.mjs list --status accepted");
        const r = await invoiceFromQuote(db, rest[0], by, cli.source, days);
        if (!r.ok && r.reason === "invoiced" && r.invoiceId) {
          const inv = await invoiceById(db, r.invoiceId);
          if (json) return out(true, inv, String);
          return done(at, `quote #${rest[0]} already has invoice #${r.invoiceId}; left alone`, { next: `node scripts/invoices.mjs show ${r.invoiceId}` });
        }
        if (!r.ok) fail(r.reason === "not_accepted" ? `${at}: quote #${rest[0]} is not accepted; only an accepted quote is invoiced` : `${at}: no quote ${rest[0]}`,
          r.reason === "not_accepted" ? `node scripts/quotes.mjs accept ${rest[0]}, once the customer said yes` : "node scripts/quotes.mjs list --status accepted");
        if (json) return out(true, r.value, String);
        return done(at, `drafted ${fmt(r.value)}`, { next: `node scripts/invoices.mjs send ${r.value.id}` });
      }

      case "discard": {
        const inv = await invoiceOr(db, rest[0]);
        if (inv.status === "void" && !inv.stripe_invoice_id) {
          if (json) return out(true, null, String);
          return done(at, `#${inv.id} is already discarded (void); left alone`);
        }
        if (!(await discardInvoice(db, inv.id, by)))
          fail(`${at}: invoice #${inv.id} is ${inv.status}${inv.stripe_invoice_id ? " and in Stripe" : ""}; only a draft not yet in Stripe is discarded`,
            inv.stripe_invoice_id ? `node scripts/invoices.mjs void ${inv.id}` : `node scripts/invoices.mjs show ${inv.id}`);
        if (json) return out(true, null, String);
        return done(at, `discarded #${inv.id}; it stays on record as void`);
      }

      case "send":
      case "mark-paid":
      case "void":
      case "uncollectible": {
        const inv = await invoiceOr(db, rest[0]);
        const say = {
          send: `Stripe makes invoice #${inv.id} in the owner's Stripe account and emails it to ${inv.email}: ${money(inv.total_cents, inv.currency)}, due ${inv.days_until_due} days after it is sent. After this it no longer changes here.`,
          "mark-paid": `Invoice ${inv.number ?? "#" + inv.id} for ${money(inv.total_cents, inv.currency)} is recorded in Stripe as paid outside Stripe (cash or a check). No card is charged. It cannot be undone.`,
          void: `Invoice ${inv.number ?? "#" + inv.id} is voided in Stripe: ${inv.email} can no longer pay it. It cannot be undone.`,
          uncollectible: `Invoice ${inv.number ?? "#" + inv.id} is written off in Stripe. It can still be paid or voided later.`,
        }[cmd];
        // Already where the command would put it: done, and nothing goes to Stripe again.
        const already = cmd === "send" ? (inv.sent_at ? `sent ${local(inv.sent_at)}` : null)
          : inv.status === { "mark-paid": "paid", void: "void", uncollectible: "uncollectible" }[cmd] ? inv.status : null;
        if (already) {
          if (json) return out(true, { already: cmd, invoice: inv }, String);
          return done(at, `invoice #${inv.id} is already ${already}; left alone`, { next: `node scripts/invoices.mjs show ${inv.id}` });
        }
        if (!has(a, "confirm")) {
          if (json) return out(true, { would: say }, String);
          return done(at, fmt(inv), { lines: [say], waits: `node scripts/invoices.mjs ${cmd} ${inv.id}` });
        }
        const stripe = stripeOr(cli.env, at);
        if (cmd === "send") {
          const r = await sendInvoice(db, stripe, inv.id, by);
          if (!r.ok) fail(`${at}: ${r.message}`, `node scripts/invoices.mjs show ${inv.id}`);
          await cli.afterSend?.(db, { kind: "invoice", id: inv.id, email: inv.email }, by);
          if (json) return out(true, r.invoice, String);
          return done(at, `sent ${fmt(r.invoice)}`, { lines: [`their payment page: ${r.invoice.hosted_url ?? "(Stripe will add it)"}`], next: `node scripts/invoices.mjs show ${inv.id}` });
        }
        const r = cmd === "mark-paid" ? await markPaidOutOfBand(db, stripe, inv.id) : cmd === "void" ? await voidInvoice(db, stripe, inv.id) : await markUncollectible(db, stripe, inv.id);
        if (!r.ok) fail(`${at}: ${r.message}`, `node scripts/invoices.mjs show ${inv.id}`);
        if (json) return out(true, { asked: cmd }, String);
        return done(at, `Stripe has it for invoice #${inv.id}`, { lines: ["it changes here when Stripe's event arrives, a few seconds after"], next: `node scripts/invoices.mjs show ${inv.id}` });
      }
    }
  });
}
