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
import { fail, flag, flags, has, localTime, misused, out, parseArgs, usage, type Args } from "../data/cli";
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
  /** Where the sender and the Stripe key are found (data/cli.ts machineEnv). */
  env: Record<string, string | undefined>;
  /** A quote's PDF, where this machine has a browser (reports/print.ts). */
  print?: (html: string) => Promise<Uint8Array | null>;
  /** <who>: a person the app knows by id, email or phone. Without it, <who> is an email. */
  person?: (db: Db, ref: string) => Promise<Person | null>;
  /** When the app has quotes and invoices switched off: the line that says so. */
  off?: string | null;
  /** The app's own commands: their help lines, and what each does. */
  more?: { help: string; commands: Record<string, Extra> };
};

/** Who acted: --as, else APP_USER, else AI. */
const actor = (a: Args) => flag(a, "as") || process.env.APP_USER || process.env.CRM_USER || "AI";
const money = (c: string | number, currency: string) => formatMoney(c, currency);

/** <who> as a person: one the app knows, or a plain email someone gave. */
async function personOf(db: Db, cli: InvoicesCli, ref: string | undefined, what: string): Promise<Person> {
  if (!ref) misused(`${what} needs who it is for: an email${cli.person ? ", or a customer's id or phone" : ""}\n  Try: node scripts/quotes.mjs --help`);
  const known = cli.person ? await cli.person(db, ref) : null;
  if (known) return known;
  if (ref.includes("@")) return { email: ref, name: null, phone: null, address: null };
  return fail(`no one is ${ref} (by id, email or phone); a new person is named by their email`);
}

/** --line "what|price", "what|qty|price" or "what|qty|price|tax rate" (a rate by name or id). */
export function lineFlags(a: Args, rates: TaxRate[], script: string): LineInput[] {
  return flags(a, "line").map((raw) => {
    const parts = raw.split("|").map((p) => p.trim());
    if (parts.length < 2 || parts.length > 4) misused(`--line ${raw}: write it as "what|price", "what|qty|price" or "what|qty|price|tax rate"\n  Try: node scripts/${script}.mjs --help`);
    const [description, ...more] = parts;
    const [quantity, unit, tax] = more.length === 1 ? ["1", more[0], ""] : [more[0], more[1], more[2] ?? ""];
    let rate = "";
    if (tax) {
      const r = rates.find((x) => x.active && (x.id === tax || x.name.toLowerCase() === tax.toLowerCase()));
      if (!r) fail(`--line ${raw}: no tax rate ${tax}; offered: ${rates.filter((x) => x.active).map((x) => `${x.name} (#${x.id})`).join(", ") || "none"}\n  Try: node scripts/quotes.mjs tax-rate "Sales tax" 8.25`);
      rate = r.id;
    }
    return { description, quantity, unit, tax_rate_id: rate };
  });
}

/** Field errors as lines a person can act on: "--line 2 (price): ...", "--valid-until: ...". */
const FIELD_NAMES: Record<string, string> = { description: "what", quantity: "qty", unit: "price", tax_rate_id: "tax rate" };
/** The owner's Stripe, or a plain refusal naming the connection to ask for: never a stack trace. */
export function stripeOr(env: InvoicesCli["env"]): ReturnType<typeof stripeFrom> {
  try {
    return stripeFrom(env);
  } catch (e) {
    fail(`${e instanceof Error ? e.message : String(e)}\n  Try: request_connection("stripe", why="send and collect invoices", auth="api_key", delivery="edge")`);
  }
}

export const problems = (errors: Record<string, string>) =>
  Object.entries(errors).map(([k, v]) => {
    const line = /^lines\.(\d+)\.(\w+)$/.exec(k);
    if (line) return `--line ${Number(line[1]) + 1} (${FIELD_NAMES[line[2]] ?? line[2]}): ${v}`;
    if (k === "status") return v;
    if (k === "lines") return `--line: ${v}`;
    return `--${k === "visit_id" ? "job" : k === "days_until_due" ? "days" : k.replace(/_/g, "-")}: ${v}`;
  }).join("\n");

// ---- quotes -------------------------------------------------------------------

export async function quotesCli(argv: string[], cli: InvoicesCli): Promise<void> {
  const HELP = `quotes.mjs <command> [...] [--json] [--as <email>]      quotes, sent through the owner's own email sender

  list [--status ${QUOTE_STATUSES.join("|")}] [--find text] [--limit 50]
  list --customer <who>
  show <id>
  add <who> --line "<what>|[qty|]<price>[|<tax rate>]"... [--name n] [--phone p] [--address a]
            [--valid-until YYYY-MM-DD] [--notes n] [--terms t] [--job <id>] [--currency ${cli.currency}]
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
Prices are in the quote's currency; totals are computed from the lines. --as records who acted.`;
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  if (cli.off && has(a, "help")) console.log(cli.off + "\n");
  const commands = ["list", "show", "add", "edit", "send", "mark-sent", "accept", "decline", "expire", "tax-rates", "tax-rate", ...Object.keys(cli.more?.commands ?? {})];
  usage(a, cmd, commands, HELP, "quotes");
  if (cli.off) fail(cli.off);
  const json = has(a, "json");
  const doc = { business: cli.business, timeZone: cli.timeZone };
  const local = (d: Date | string) => localTime(d, cli.timeZone);
  const fmt = (r: Quote) =>
    [`#${r.id}`, r.number, `[${shownStatus(r, todayIn(cli.timeZone))}]`, r.name ? `${r.name} <${r.email}>` : r.email, money(r.total_cents, r.currency),
      r.valid_until ? `valid until ${r.valid_until}` : "", r.visit_id ? `job #${r.visit_id}` : ""].filter(Boolean).join("  ");
  const quoteOr = async (db: Db, id: string | undefined) => {
    if (!id || !/^\d{1,18}$/.test(id)) misused("name a quote by its id (#12 is 12)\n  Try: node scripts/quotes.mjs list");
    return (await quoteById(db, id)) ?? fail(`no quote ${id}\n  Try: node scripts/quotes.mjs list`);
  };
  const moved = (r: Moved) => (r.ok ? fmt(r.value) : r.reason === "not_found" ? fail("no such quote") : fail(`not from ${r.status}: nothing changed`));

  await cli.withDb(async (db) => {
    const by = actor(a);
    const extra = cli.more?.commands[cmd];
    if (extra) return extra(db, a, rest, by);
    switch (cmd) {
      case "list": {
        const limit = Math.min(Number(flag(a, "limit") ?? 50) || 50, 1000);
        if (has(a, "customer")) {
          const p = await personOf(db, cli, flag(a, "customer"), "list --customer");
          const rows = p.email ? await quotesFor(db, { email: p.email }) : [];
          return out(json, rows, () => (rows.length ? rows.map(fmt).join("\n") : `no quotes for ${p.name ?? p.email ?? "them"}`));
        }
        const asked = flag(a, "status");
        if (asked && !QUOTE_STATUSES.includes(asked as QuoteStatus)) misused(`--status must be one of ${QUOTE_STATUSES.join(", ")}\n  Try: node scripts/quotes.mjs list --status sent`);
        const { page, next } = cut(await quotesPage(db, { q: flag(a, "find") ?? null, status: (asked as QuoteStatus) ?? null }, null, limit, todayIn(cli.timeZone)), limit);
        return out(json, page, () => (page.length ? page.map(fmt).join("\n") + (next ? "\n... more; raise --limit" : "") : "none"));
      }

      case "show": {
        const qt = await quoteOr(db, rest[0]);
        const rates = await taxRates(db);
        return out(json, qt, () => [
          fmt(qt),
          ...qt.lines.map((l) => `  ${l.position}. ${l.description}: ${l.quantity} x ${money(l.unit_cents, qt.currency)} = ${money(l.amount_cents, qt.currency)}${l.tax_rate_id ? `  (${rates.find((r) => r.id === l.tax_rate_id)?.name ?? "tax"} ${money(l.tax_cents, qt.currency)})` : ""}`),
          `  subtotal ${money(qt.subtotal_cents, qt.currency)}, tax ${money(qt.tax_cents, qt.currency)}, total ${money(qt.total_cents, qt.currency)}`,
          qt.notes ? `notes: ${qt.notes}` : "",
          qt.terms ? `terms: ${qt.terms}` : "",
          qt.sent_at ? `sent ${local(qt.sent_at)}` : "not sent",
          qt.decided_at ? `${qt.status} ${local(qt.decided_at)}${qt.decided_by ? " by " + qt.decided_by : ""}` : "",
          `made ${local(qt.created_at)}${qt.created_by ? " by " + qt.created_by : ""}`,
        ].filter(Boolean).join("\n"));
      }

      case "add":
      case "edit": {
        const rates = await taxRates(db);
        const current = cmd === "edit" ? await quoteOr(db, rest[0]) : null;
        let f: QuoteFields;
        if (current) {
          f = {
            email: current.email, name: current.name, phone: current.phone, address: current.address, currency: current.currency,
            valid_until: current.valid_until, notes: current.notes, terms: current.terms, visit_id: current.visit_id,
            lines: current.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: amountInput(l.unit_cents, current.currency), tax_rate_id: l.tax_rate_id ?? "" })),
          };
        } else {
          const p = await personOf(db, cli, rest[0], "add");
          const valid = new Date(Date.parse(todayIn(cli.timeZone) + "T00:00:00Z") + 30 * 86_400_000).toISOString().slice(0, 10);
          f = { ...p, currency: cli.currency, valid_until: valid, terms: cli.terms ?? null, lines: [] };
        }
        const set = (k: keyof QuoteFields, flagName: string) => {
          if (has(a, flagName)) f[k] = flag(a, flagName) ?? "";
        };
        set("name", "name"); set("phone", "phone"); set("address", "address"); set("valid_until", "valid-until");
        set("notes", "notes"); set("terms", "terms"); set("visit_id", "job"); set("currency", "currency");
        if (has(a, "line")) f.lines = lineFlags(a, rates, "quotes");
        const r = current ? await saveQuote(db, current.id, f, by) : await createQuote(db, f, by, cli.source);
        if (!r.ok) fail(problems(r.errors));
        return out(json, r.value, () => `${current ? "saved" : "added"} ${fmt(r.value)}\nNext: node scripts/quotes.mjs send ${r.value.id}`);
      }

      case "send": {
        const qt = await quoteOr(db, rest[0]);
        if (qt.status !== "draft" && qt.status !== "sent") fail(`quote ${qt.number} is ${qt.status}; only a draft or sent quote is sent`);
        const rates = await taxRates(db);
        const pay = has(a, "pay");
        if (!has(a, "confirm")) {
          const m = quoteMessage(qt, rates, doc, pay ? "<the payment page Stripe makes>" : null);
          return out(json, { to: qt.email, subject: m.subject, text: m.text }, () =>
            [`To: ${qt.email}`, `Subject: ${m.subject}`, `Attached: Quote ${qt.number}.pdf, when this machine can print it`, "", m.text, "",
              `Nothing was sent. If the owner asked for it: node scripts/quotes.mjs send ${qt.id}${pay ? " --pay" : ""} --confirm; otherwise show them this and wait`].join("\n"));
        }
        let payUrl: string | null = null;
        if (pay) {
          const link = await payLinkForQuote(db, stripeOr(cli.env), qt.id, by, cli.source, cli.daysUntilDue ?? 30);
          if (!link.ok) fail(`nothing was sent: the Pay button could not be made: ${link.message}`);
          payUrl = link.url;
        }
        const r = await sendQuote(db, qt, rates, doc, { send: (mail) => sendEmail(cli.env, mail), print: cli.print, replyTo: flag(a, "as") ?? null, by, payUrl });
        if (r.sent.status === "none") fail(`nothing was sent: ${r.sent.why}. Give the owner the text (send ${qt.id} without --confirm) to send themselves, then mark-sent ${qt.id}.`);
        if (r.sent.status === "failed") fail(`the email did not go: ${r.sent.error}`);
        return out(json, { sent: true, pdf: r.pdf }, () => `sent quote ${qt.number} to ${qt.email}${r.pdf ? " with its PDF" : r.printError ? ` without a PDF (${r.printError})` : " (no browser here: the lines are in the email)"}`);
      }

      case "mark-sent":
      case "accept":
      case "decline":
      case "expire": {
        const id = (await quoteOr(db, rest[0])).id;
        const r = cmd === "mark-sent" ? await markSent(db, id, by)
          : cmd === "expire" ? await expireQuote(db, id, by)
          : await decideQuote(db, id, cmd === "accept" ? "accepted" : "declined", by);
        const line = moved(r);
        const note = cmd === "decline" ? await closePayLink(db, () => stripeOr(cli.env), id, by) : null;
        return out(json, r.ok ? r.value : null, () => (note ? `${line}\n${note}` : line));
      }

      case "tax-rates": {
        const rates = await taxRates(db);
        return out(json, rates, () => (rates.length ? rates.map((r) => `#${r.id}  ${r.name}  ${percentText(r.percent_bp)}${r.inclusive ? "  included in prices" : ""}${r.active ? "" : "  (not offered)"}`).join("\n") : "none"));
      }

      case "tax-rate": {
        const r = await createTaxRate(db, { name: rest[0], percent: rest[1], inclusive: has(a, "inclusive") }, by);
        if (!r.ok) fail(Object.values(r.errors).join("\n"));
        return out(json, r.value, () => `added #${r.value.id} ${r.value.name} ${percentText(r.value.percent_bp)}`);
      }
    }
  });
}

// ---- invoices -----------------------------------------------------------------

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
see. mark-paid is for cash or a check; it charges nothing. --as records who acted.`;
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  if (cli.off && has(a, "help")) console.log(cli.off + "\n");
  const commands = ["list", "show", "owed", "add", "edit", "from-quote", "discard", "send", "mark-paid", "void", "uncollectible", ...Object.keys(cli.more?.commands ?? {})];
  usage(a, cmd, commands, HELP, "invoices");
  if (cli.off) fail(cli.off);
  const json = has(a, "json");
  const local = (d: Date | string) => localTime(d, cli.timeZone);
  const fmt = (r: Invoice) =>
    [`#${r.id}`, r.number ?? "(no number yet)", `[${r.status}]`, r.livemode === false ? "(test mode)" : "", r.name ? `${r.name} <${r.email}>` : r.email,
      money(r.total_cents, r.currency), r.due_date ? `due ${r.due_date}` : "", r.paid_at ? `paid ${local(r.paid_at)}` : "",
      r.quote_id ? `quote #${r.quote_id}` : "", r.visit_id ? `job #${r.visit_id}` : ""].filter(Boolean).join("  ");
  const invoiceOr = async (db: Db, id: string | undefined) => {
    if (!id || !/^\d{1,18}$/.test(id)) misused("name an invoice by its id (#12 is 12)\n  Try: node scripts/invoices.mjs list");
    return (await invoiceById(db, id)) ?? fail(`no invoice ${id}\n  Try: node scripts/invoices.mjs list`);
  };

  await cli.withDb(async (db) => {
    const by = actor(a);
    const extra = cli.more?.commands[cmd];
    if (extra) return extra(db, a, rest, by);
    switch (cmd) {
      case "list": {
        const limit = Math.min(Number(flag(a, "limit") ?? 50) || 50, 1000);
        if (has(a, "customer")) {
          const p = await personOf(db, cli, flag(a, "customer"), "list --customer");
          const rows = p.email ? await invoicesFor(db, { email: p.email }) : [];
          return out(json, rows, () => (rows.length ? rows.map(fmt).join("\n") : `no invoices for ${p.name ?? p.email ?? "them"}`));
        }
        const asked = flag(a, "status");
        if (asked && asked !== "due" && !INVOICE_STATUSES.includes(asked as InvoiceStatus)) misused(`--status must be one of ${INVOICE_STATUSES.join(", ")}, due\n  Try: node scripts/invoices.mjs list --status due`);
        const status = asked && asked !== "due" ? (asked as InvoiceStatus) : null;
        const { page, next } = cut(await invoicesPage(db, { q: flag(a, "find") ?? null, status, due: asked === "due" }, null, limit, todayIn(cli.timeZone)), limit);
        return out(json, page, () => (page.length ? page.map(fmt).join("\n") + (next ? "\n... more; raise --limit" : "") : "none"));
      }

      case "show": {
        const inv = await invoiceOr(db, rest[0]);
        return out(json, inv, () => [
          fmt(inv),
          ...inv.lines.map((l) => `  ${l.position}. ${l.description}: ${l.quantity} x ${money(l.unit_cents, inv.currency)} = ${money(l.amount_cents, inv.currency)}${l.tax_rate_id ? `  (tax ${money(l.tax_cents, inv.currency)})` : ""}`),
          `  subtotal ${money(inv.subtotal_cents, inv.currency)}, tax ${money(inv.tax_cents, inv.currency)}, total ${money(inv.total_cents, inv.currency)}`,
          inv.notes ? `note: ${inv.notes}` : "",
          inv.hosted_url ? `their payment page: ${inv.hosted_url}` : "",
          inv.sent_at ? `sent ${local(inv.sent_at)}` : `not sent; ${inv.days_until_due} days to pay once it is`,
          inv.payment_failed_at && inv.status === "open" ? `a payment attempt failed ${local(inv.payment_failed_at)}` : "",
        ].filter(Boolean).join("\n"));
      }

      case "owed": {
        const p = await personOf(db, cli, rest[0], "owed");
        const rows = p.email ? await owed(db, p.email) : [];
        return out(json, rows, () => (rows.length ? rows.map((r) => `${money(r.cents, r.currency)} on ${r.count} open invoice${r.count === 1 ? "" : "s"}`).join("\n") : `${p.name ?? p.email} owes nothing on an open invoice`));
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
          const p = await personOf(db, cli, rest[0], "add");
          f = { ...p, currency: cli.currency, days_until_due: String(days), lines: [] };
        }
        if (has(a, "days")) f.days_until_due = flag(a, "days") ?? "";
        if (has(a, "notes")) f.notes = flag(a, "notes") ?? "";
        if (has(a, "job")) f.visit_id = flag(a, "job") ?? "";
        if (has(a, "currency")) f.currency = flag(a, "currency") ?? "";
        if (has(a, "line")) f.lines = lineFlags(a, rates, "invoices");
        const r = current ? await saveInvoice(db, current.id, f, by) : await createInvoice(db, f, by, cli.source);
        if (!r.ok) fail(problems(r.errors));
        return out(json, r.value, () => `${current ? "saved" : "drafted"} ${fmt(r.value)}\nNext: node scripts/invoices.mjs send ${r.value.id}`);
      }

      case "from-quote": {
        const r = await invoiceFromQuote(db, rest[0] ?? "", by, cli.source, days);
        if (!r.ok) fail(r.reason === "invoiced" ? `that quote already has invoice #${r.invoiceId}` : r.reason === "not_accepted" ? "only an accepted quote is invoiced: accept it first" : "no such quote");
        return out(json, r.value, () => `drafted ${fmt(r.value)}\nNext: node scripts/invoices.mjs send ${r.value.id}`);
      }

      case "discard": {
        const inv = await invoiceOr(db, rest[0]);
        if (!(await discardInvoice(db, inv.id, by))) fail(`invoice #${inv.id} is ${inv.status}${inv.stripe_invoice_id ? " and in Stripe: void it instead" : ""}`);
        return out(json, null, () => `discarded #${inv.id}; it stays on record as void`);
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
        if (!has(a, "confirm")) {
          return out(json, { would: say }, () => `${fmt(inv)}\n\n${say}\n\nNothing was done. If the owner asked for it: node scripts/invoices.mjs ${cmd} ${inv.id} --confirm; otherwise show them this and wait`);
        }
        const stripe = stripeOr(cli.env);
        if (cmd === "send") {
          const r = await sendInvoice(db, stripe, inv.id, by);
          if (!r.ok) fail(r.message);
          return out(json, r.invoice, () => `sent ${fmt(r.invoice)}\ntheir payment page: ${r.invoice.hosted_url ?? "(Stripe will add it)"}`);
        }
        const r = cmd === "mark-paid" ? await markPaidOutOfBand(db, stripe, inv.id) : cmd === "void" ? await voidInvoice(db, stripe, inv.id) : await markUncollectible(db, stripe, inv.id);
        if (!r.ok) fail(r.message);
        return out(json, { asked: cmd }, () => `Stripe has it. The invoice changes here when Stripe's event arrives.\nNext: node scripts/invoices.mjs show ${inv.id}`);
      }
    }
  });
}
