// Quotes and invoices from chat: the same changes as the pages, as two
// commands every app that carries this skill runs the same way. Machine only.
// An app's scripts/quotes.mjs and scripts/invoices.mjs are a few lines that
// pass its own settings:
//
//   await quotesCli(process.argv.slice(2), {
//     withDb, business: "Acme", currency: "usd", timeZone: "America/Denver", terms: null, daysUntilDue: 30,
//     source: "crm", env: machineEnv(), print: printPdf,
//     person: (db, ref) => …,                       // <who>: the app's customers, by id, email or phone
//     more: { help: "  bill <who> …", commands: { bill: async (db, a, rest, by) => … } },
//   });
//
// Nothing reaches a customer or moves money without --confirm. The AI adds
// it when the owner asked for that action; otherwise it shows the preview.
import { cut } from "../admin/keyset";
import { done, fail, flag, flags, has, limitOf, localTime, misused, noMore, out, parseArgs, usage, type Args } from "../data/cli.mjs";
import type { Db } from "../data/db";
import { sendEmail } from "../data/send";
import { createHash } from "node:crypto";
import { formatMoney, toMinor } from "../payments/money";
import { stripeFrom } from "../payments/stripe";
import { createTaxRate, percentText, taxRates, type TaxRate } from "../payments/tax";
import { addDays, isDay, quoteMessage, sendQuote, todayIn } from "./document";
import {
  createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, invoicesPage, owed, saveInvoice, INVOICE_STATUSES,
  type Invoice, type InvoiceFields, type InvoiceStatus,
} from "./invoices";
import { amountInput, type LineInput, type SavedLine } from "./lines";
import {
  createQuote, decideQuote, expireQuote, markSent, quoteById, quotesFor, quotesPage, saveQuote, shownStatus, QUOTE_STATUSES,
  type Quote, type QuoteFields, type QuoteStatus,
} from "./quotes";
import { cardName, chargeCard, defaultCard } from "./cards";
import {
  createRecurring, describe, endRecurring, invoicesOf, makeNow, MODES, pauseRecurring, periodLabel, previewRecurring, recurringById, recurringList, resumeRecurring,
  saveRecurring, shortDay, type Recurring, type RecurringFields,
} from "./recurring";
import { chargeInvoice, emailPaymentPage, markUncollectible, paidSoFar, PAYMENT_METHODS, recordPayment, sendInvoice, voidInvoice } from "./stripe";

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
  /** What the business calls a quote: "Quote" (default), "Proposal" or "Estimate". */
  word?: string;
  /** recurring.mjs: a recurring invoice on a quote changed, so the app re-makes what the quote shows (default: proposal.saved). */
  quoteSaved?: (db: Db, qt: Quote) => Promise<void>;
  /** Quotes as the app's own pages at a link the customer reads and accepts (the CRM's proposals). */
  proposal?: {
    /** After a quote is added or edited here: the app keeps its page current. */
    saved: (db: Db, qt: Quote) => Promise<void>;
    /** Whether it can go as a link now: null, or why not, in a sentence. */
    ready: (db: Db, qt: Quote) => Promise<string | null>;
    /** A new link for the quote; it replaces the earlier one only once `keep` runs (after its email went). */
    mint: (db: Db, qt: Quote, by: string) => Promise<{ url: string; keep: () => Promise<void> }>;
    /** The email carrying the link went out now. */
    emailed: (db: Db, qt: Quote) => Promise<void>;
    /** The quote as its customer reads it, for the PDF when it goes without a link. */
    document: (db: Db, qt: Quote & { lines: SavedLine[] }) => Promise<string>;
    /** What accepting it does, in a sentence; null when nothing. Accept waits for --confirm when there is one. */
    onAccept: (db: Db, qt: Quote) => Promise<string | null>;
    /** Anything to know before it goes (parts still showing sample words), in a sentence; null when nothing. */
    warning: (db: Db, qt: Quote) => Promise<string | null>;
  };
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
    return `--${k === "visit_id" ? "event" : k === "deal_id" ? "deal" : k === "days_until_due" ? "days" : k.replace(/_/g, "-")}: ${v}`;
  }).join("\n");

// ---- quotes -------------------------------------------------------------------

const QUOTE_FIELDS = ["line", "name", "phone", "address", "valid-until", "notes", "terms", "event", "deal", "currency", "as"];
const QUOTE_FLAGS: Record<string, string[]> = {
  list: ["status", "find", "limit", "customer"], show: [], add: QUOTE_FIELDS, edit: QUOTE_FIELDS, send: ["link", "confirm", "as"],
  "mark-sent": ["as"], accept: ["confirm", "as"], decline: ["as"], expire: ["as"], "tax-rates": [], "tax-rate": ["inclusive", "as"],
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
            [--valid-until YYYY-MM-DD] [--notes n] [--terms t] [--event <id>] [--deal <id>] [--currency ${cli.currency}]
  edit <id> [the same flags]           until it is accepted or declined; --line replaces every line
  send <id>                            prints exactly what would go to whom; sends nothing
  send <id> --confirm                  sends it: when the owner asked for it, or said yes to the preview${cli.proposal ? `
  send <id> --link --confirm           makes its link for the owner to pass on themselves; emails nothing` : ""}
  mark-sent <id>                       the owner emailed it themselves
  accept <id> [--confirm] | decline <id> | expire <id>${cli.proposal ? `
                                       accept prints what accepting it does first, and waits for --confirm` : ""}
  tax-rates                            the rates a line can carry
  tax-rate "<name>" <percent> [--inclusive]
${cli.more?.help ?? ""}
<who> is ${cli.person ? "a customer's id, email or phone (their name, phone and address are copied in), or" : ""} an
email. A line is "Fence repair|450.00", "Hours|2.5|80" or "Install|1|450|Sales tax" (a rate by name or id).
Prices are in the quote's currency; totals are computed from the lines. --as records who acted.

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;
  // --link and --inclusive take no value: `send --link 3` keeps 3 as the id.
  const a = parseArgs(argv, { bare: ["link", "inclusive"] });
  const [cmd, ...rest] = a._;
  if (cli.off && has(a, "help")) console.log(cli.off + "\n");
  const commands = ["list", "show", "add", "edit", "send", "mark-sent", "accept", "decline", "expire", "tax-rates", "tax-rate", ...Object.keys(cli.more?.commands ?? {})];
  usage(a, cmd, commands, HELP, "quotes", { ...QUOTE_FLAGS, ...cli.more?.flags });
  if (cli.off) fail(cli.off);
  const at = `quotes ${cmd}`;
  if (QUOTE_ARITY[cmd] !== undefined) noMore(rest, QUOTE_ARITY[cmd], at);
  const limit = cmd === "list" ? limitOf(a, at) : 50;
  const json = has(a, "json");
  const W = cli.word ?? "Quote", word = W.toLowerCase();
  const doc = { business: cli.business, timeZone: cli.timeZone, word: W };
  const local = (d: Date | string) => localTime(d, cli.timeZone);
  const fmt = (r: Quote) =>
    [`#${r.id}`, r.number, `[${shownStatus(r, todayIn(cli.timeZone))}]`, r.name ? `${r.name} <${r.email}>` : r.email, money(r.total_cents, r.currency),
      r.valid_until ? `valid until ${r.valid_until}` : "", r.visit_id ? `event #${r.visit_id}` : "", r.deal_id ? `deal #${r.deal_id}` : ""].filter(Boolean).join("  ");
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
          const valid = addDays(todayIn(cli.timeZone), 30);
          f = { ...p, currency: cli.currency, valid_until: valid, terms: cli.terms ?? null, lines: [] };
        }
        const set = (k: keyof QuoteFields, flagName: string) => {
          if (has(a, flagName)) f[k] = flag(a, flagName) ?? "";
        };
        set("name", "name"); set("phone", "phone"); set("address", "address"); set("valid_until", "valid-until");
        set("notes", "notes"); set("terms", "terms"); set("visit_id", "event"); set("deal_id", "deal"); set("currency", "currency");
        if (has(a, "line")) f.lines = lineFlags(a, rates, "quotes");
        const r = current ? await saveQuote(db, current.id, f, by) : await createQuote(db, f, by, cli.source);
        if (!r.ok) fail(`${at}: not saved\n${problems(r.errors)}`, "node scripts/quotes.mjs --help");
        await cli.proposal?.saved(db, r.value);
        if (json) return out(true, r.value, String);
        return done(at, `${current ? "saved" : "added"} ${fmt(r.value)}`, { next: `node scripts/quotes.mjs send ${r.value.id}` });
      }

      case "send": {
        const qt = await quoteOr(db, rest[0]);
        if (qt.status !== "draft" && qt.status !== "sent") fail(`${at}: ${word} ${qt.number} is ${qt.status}; only a draft or sent ${word} is sent`, `node scripts/quotes.mjs show ${qt.id}`);
        const rates = await taxRates(db);
        const noLink = cli.proposal ? await cli.proposal.ready(db, qt) : "";
        const withLink = noLink === null;
        if (has(a, "link") && !withLink) fail(`${at}: there is no link to give: ${noLink || "this app has no page for it"}`, `node scripts/quotes.mjs send ${qt.id} --confirm, to email it without a link`);
        if (!has(a, "confirm")) {
          const m = quoteMessage(qt, rates, doc, withLink ? "<its link, made when it is sent>" : null);
          if (json) return out(true, { to: qt.email, subject: m.subject, text: m.text, link: withLink, why_no_link: withLink ? null : noLink || null }, String);
          if (has(a, "link")) return done(at, `${word} ${qt.number}: a link for the owner to pass on to ${qt.email}; nothing is emailed`, { waits: `node scripts/quotes.mjs send ${qt.id} --link` });
          const warning = cli.proposal ? await cli.proposal.warning(db, qt) : null;
          return done(at, `${word} ${qt.number} to ${qt.email}, ${money(qt.total_cents, qt.currency)}`, {
            lines: [
              ...(warning ? [`Before it goes: ${warning}`] : []),
              ...(cli.proposal && !withLink ? [`No link this time: ${noLink} They reply to accept.`] : []),
              `Subject: ${m.subject}`, withLink ? "Attached: nothing; the link always shows the current one" : `Attached: ${W} ${qt.number}.pdf, when this machine can print it`, "", m.text, "",
            ],
            waits: `node scripts/quotes.mjs send ${qt.id}`,
          });
        }
        if (has(a, "link")) {
          // Made (it can fail, and then nothing changed), marked sent, then kept: a link works only for a quote that is out.
          const made = await cli.proposal!.mint(db, qt, by);
          const r = await markSent(db, qt.id, by);
          if (!r.ok) fail(`${at}: ${word} ${qt.number} cannot be sent now${r.status ? ` (it is ${r.status})` : ""}`, `node scripts/quotes.mjs show ${qt.id}`);
          await made.keep();
          const link = made.url;
          await cli.afterSend?.(db, { kind: "quote", id: qt.id, email: qt.email }, by);
          if (json) return out(true, { link }, String);
          return done(at, `${word} ${qt.number}'s link, for the owner to send ${qt.name ?? qt.email} themselves`, {
            lines: [link, "Anyone with it can open and accept it. Sending again makes a new one, and this one stops working."],
            next: `node scripts/quotes.mjs show ${qt.id}`,
          });
        }
        const made = withLink ? await cli.proposal!.mint(db, qt, by) : null;
        const link = made?.url ?? null;
        const html = cli.proposal && !link ? await cli.proposal.document(db, qt) : undefined;
        const r = await sendQuote(db, qt, rates, doc, { send: (mail) => sendEmail(cli.env, mail), print: cli.print, html, replyTo: flag(a, "as") ?? null, by, link });
        if (r.sent.status === "none") fail(`${at}: nothing was sent: ${r.sent.why}\n  Give the owner the text to send themselves, then mark it sent`, `node scripts/quotes.mjs send ${qt.id}, without --confirm, for the text; then node scripts/quotes.mjs mark-sent ${qt.id}`);
        if (r.sent.status === "failed") fail(`${at}: the email did not go: ${r.sent.error}`, "python3 ~/tools/taskandtool.py list-connections, to check the email sender");
        if (made) {
          await made.keep();
          // The email went: a failed record of it must not read as a failed send.
          await cli.proposal!.emailed(db, qt).catch((e) => console.error(`quote ${qt.id}: emailed: ${e instanceof Error ? e.message : e}`));
        }
        await cli.afterSend?.(db, { kind: "quote", id: qt.id, email: qt.email }, by);
        if (json) return out(true, { sent: true, pdf: r.pdf, link: !!link }, String);
        return done(at, `sent ${word} ${qt.number} to ${qt.email}${link ? " with its link" : r.pdf ? " with its PDF" : r.printError ? ` without a PDF (${r.printError})` : " (no browser here: the lines are in the email)"}`, {
          next: `node scripts/quotes.mjs show ${qt.id}`,
        });
      }

      case "mark-sent":
      case "accept":
      case "decline":
      case "expire": {
        const qt = await quoteOr(db, rest[0]);
        const id = qt.id;
        // What accepting it does (its first invoice, sent or not) is shown first, as Mark accepted's page does.
        const does = cmd === "accept" && cli.proposal ? await cli.proposal.onAccept(db, qt) : null;
        if (does && !has(a, "confirm") && (qt.status === "draft" || qt.status === "sent" || qt.status === "expired")) {
          if (json) return out(true, { accept: qt.id, does }, String);
          return done(at, `${word} ${qt.number} accepted would also do this: ${does}`, { waits: `node scripts/quotes.mjs accept ${qt.id}` });
        }
        const r = cmd === "mark-sent" ? await markSent(db, id, by)
          : cmd === "expire" ? await expireQuote(db, id, by)
          : await decideQuote(db, id, cmd === "accept" ? "accepted" : "declined", by);
        if (!r.ok && r.status === TO[cmd]) {
          if (json) return out(true, await quoteById(db, id), String);
          return done(at, `${word} ${id} is already ${r.status}; left alone`, { next: `node scripts/quotes.mjs show ${id}` });
        }
        if (!r.ok) fail(r.reason === "not_found" ? `${at}: no ${word} ${id}` : `${at}: ${word} ${id} is ${r.status}; nothing changed`, `node scripts/quotes.mjs show ${id}`);
        if (cmd === "mark-sent") await cli.afterSend?.(db, { kind: "quote", id, email: r.value.email }, by);
        const after = (cmd === "accept" || cmd === "decline") && cli.afterDecide ? await cli.afterDecide(db, r.value, by) : [];
        if (json) return out(true, r.value, String);
        return done(at, `${DONE[cmd]} ${fmt(r.value)}`, { lines: after, next: cmd === "accept" ? `node scripts/invoices.mjs from-quote ${id}` : undefined });
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

const INVOICE_FIELDS = ["line", "days", "notes", "event", "currency", "as"];
const INVOICE_FLAGS: Record<string, string[]> = {
  list: ["status", "find", "limit", "customer"], show: [], owed: [], add: INVOICE_FIELDS, edit: INVOICE_FIELDS, "from-quote": ["deposit", "rest", "as"],
  discard: ["as"], send: ["charge", "confirm", "as"], charge: ["confirm", "as"], "email-page": ["confirm", "as"], "record-payment": ["amount", "method", "on", "reference", "confirm", "as"], void: ["confirm", "as"], uncollectible: ["confirm", "as"],
};
const INVOICE_ARITY: Record<string, number> = { list: 0, show: 1, owed: 1, add: 1, edit: 1, "from-quote": 1, discard: 1, send: 1, charge: 1, "email-page": 1, "record-payment": 1, void: 1, uncollectible: 1 };

export async function invoicesCli(argv: string[], cli: InvoicesCli): Promise<void> {
  const days = cli.daysUntilDue ?? 30;
  const HELP = `invoices.mjs <command> [...] [--json] [--as <email>]      invoices, sent and collected by the owner's Stripe

  list [--status ${INVOICE_STATUSES.join("|")}|due] [--find text] [--limit 50]
  list --customer <who>
  show <id>
  owed <who>                           open invoices, live money only, per currency
  add <who> --line "<what>|[qty|]<price>[|<tax rate>]"... [--days ${days}] [--notes n] [--event <id>] [--currency ${cli.currency}]
  from-quote <quote id>                an accepted quote's lines, when it has no invoice yet
  from-quote <quote id> --deposit 50   a deposit: that percent of each tax rate's lines, when it has no invoice yet
  from-quote <quote id> --rest         what its invoices have not billed yet
  edit <id> [the add flags]            a draft not yet in Stripe; --line replaces every line
  discard <id>                         a draft not yet in Stripe: kept as void
  send <id> | void <id> | uncollectible <id>
  send <id> --charge                   charged to the card they saved, not emailed to pay
  charge <id>                          an open invoice, charged now to their card (again, after a refusal)
  email-page <id>                      Stripe emails them an open invoice's payment page (a refused or unconfirmed charge)
  record-payment <id> [--amount 120.50] [--method ${PAYMENT_METHODS.map((m) => `"${m}"`).join("|")}] [--on YYYY-MM-DD] [--reference r]
                                       paid another way, all that is owed (the default) or part
                                       prints exactly what would happen; does nothing
  ... --confirm                        does it: when the owner asked for it, or said yes to the preview
${cli.more?.help ?? ""}
Stripe emails the invoice and hosts the page they pay on. Paid, void and
uncollectible arrive from Stripe's webhook, a few seconds after: show it to
see. Charge a card only with the customer's agreement to pay that way (a
signed proposal that says so is that); a card is saved when they pay an
invoice on Stripe's page. record-payment is for cash, a check or a transfer; it charges nothing, and
the invoice stays open until nothing is owed. --as records who acted.

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  if (cli.off && has(a, "help")) console.log(cli.off + "\n");
  const commands = ["list", "show", "owed", "add", "edit", "from-quote", "discard", "send", "charge", "email-page", "record-payment", "void", "uncollectible", ...Object.keys(cli.more?.commands ?? {})];
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
      r.quote_id ? `quote #${r.quote_id}` : "", r.visit_id ? `event #${r.visit_id}` : ""].filter(Boolean).join("  ");
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
        if (has(a, "event")) f.visit_id = flag(a, "event") ?? "";
        if (has(a, "currency")) f.currency = flag(a, "currency") ?? "";
        if (has(a, "line")) f.lines = lineFlags(a, rates, "invoices");
        const r = current ? await saveInvoice(db, current.id, f, by) : await createInvoice(db, f, by, cli.source);
        if (!r.ok) fail(`${at}: not saved\n${problems(r.errors)}`, "node scripts/invoices.mjs --help");
        if (json) return out(true, r.value, String);
        return done(at, `${current ? "saved" : "drafted"} ${fmt(r.value)}`, { next: `node scripts/invoices.mjs send ${r.value.id}` });
      }

      case "from-quote": {
        if (!rest[0] || !ID.test(rest[0])) misused(`${at}: name the quote by its id (#12 is 12)`, "node scripts/quotes.mjs list --status accepted");
        const dep = flag(a, "deposit");
        if (dep !== undefined && (!/^\d{1,3}$/.test(dep) || Number(dep) < 1 || Number(dep) > 100)) misused(`${at}: --deposit ${dep} is not a percent from 1 to 100`, `node scripts/invoices.mjs from-quote ${rest[0]} --deposit 50`);
        if (dep !== undefined && has(a, "rest")) misused(`${at}: a deposit or the rest, not both`, `node scripts/invoices.mjs from-quote ${rest[0]} --rest`);
        // Run twice, the whole quote and a deposit make one invoice: they are made only while it has none. The rest bills what is left.
        const seen = has(a, "rest") ? (await invoicesFor(db, { quoteId: rest[0] })).filter((i) => i.status !== "void").length : 0;
        const share = has(a, "rest") ? { kind: "rest" as const } : dep !== undefined ? { kind: "percent" as const, percent: Number(dep) } : { kind: "all" as const };
        const r = await invoiceFromQuote(db, rest[0], by, cli.source, days, { share, seen });
        if (!r.ok && r.reason === "invoiced" && r.invoiceId) {
          const inv = await invoiceById(db, r.invoiceId);
          if (json) return out(true, inv, String);
          return done(at, `quote #${rest[0]} already has invoice #${r.invoiceId}; left alone`, { next: `node scripts/invoices.mjs show ${r.invoiceId}, or from-quote ${rest[0]} --rest for what is left` });
        }
        if (!r.ok && r.reason === "nothing_left") {
          if (json) return out(true, null, String);
          return done(at, `quote #${rest[0]} is invoiced in full already; left alone`, { next: `node scripts/quotes.mjs show ${rest[0]}` });
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

      case "record-payment": {
        const inv = await invoiceOr(db, rest[0]);
        if (inv.status === "paid") {
          if (json) return out(true, { already: "paid", invoice: inv }, String);
          return done(at, `invoice #${inv.id} is already paid; left alone`, { next: `node scripts/invoices.mjs show ${inv.id}` });
        }
        if (inv.status !== "open" && inv.status !== "uncollectible") fail(`${at}: invoice #${inv.id} is ${inv.status}; only a sent one is paid`, `node scripts/invoices.mjs show ${inv.id}`);
        const left = Number(inv.total_cents) - (await paidSoFar(db, inv.id));
        const amount = flag(a, "amount");
        const cents = amount ? toMinor(amount, inv.currency) : left;
        if (cents === null || cents <= 0) misused(`${at}: --amount ${amount}: an amount like 120 or 120.50`, `node scripts/invoices.mjs record-payment ${inv.id} --amount 120.50`);
        const method = PAYMENT_METHODS.find((m) => m.toLowerCase() === (flag(a, "method") ?? "Other").toLowerCase())
          ?? misused(`${at}: --method: one of ${PAYMENT_METHODS.join(", ")}`, `node scripts/invoices.mjs record-payment ${inv.id} --method Check`);
        const today = todayIn(cli.timeZone);
        const on = flag(a, "on") ?? today;
        if (!isDay(on) || on > today) misused(`${at}: --on ${on}: the day it was paid, today or before`, `node scripts/invoices.mjs record-payment ${inv.id} --on ${today}`);
        const reference = flag(a, "reference")?.slice(0, 100) ?? null;
        const say = `${money(cents!, inv.currency)} paid by ${method.toLowerCase()} on ${on}${reference ? ` (${reference})` : ""} is recorded on invoice ${inv.number ?? "#" + inv.id} in Stripe. No card is charged. ${cents === left ? "Nothing is left to pay." : `${money(left - cents!, inv.currency)} is still owed.`}`;
        if (!has(a, "confirm")) {
          if (json) return out(true, { would: say }, String);
          return done(at, fmt(inv), { lines: [say], waits: `node scripts/invoices.mjs record-payment ${rest.join(" ")}` });
        }
        // The same payment asked twice is recorded once: the key is what it is. A second like it on the same day needs its own --reference.
        const key = createHash("sha256").update([inv.id, cents, method, on, reference ?? ""].join("|")).digest("hex").slice(0, 40);
        const r = await recordPayment(db, stripeOr(cli.env, at), inv.id, { amountCents: cents!, method, paidOn: on, reference, key, today }, by);
        if (!r.ok) fail(`${at}: ${r.message}`, `node scripts/invoices.mjs show ${inv.id}`);
        if (json) return out(true, { recorded: cents, remaining: r.remaining ?? null }, String);
        return done(at, `recorded ${money(cents!, inv.currency)} on invoice #${inv.id}`, {
          lines: [r.remaining === 0 ? "nothing is left to pay: it turns paid when Stripe's event arrives, a few seconds after" : `${money(r.remaining ?? left - cents!, inv.currency)} is still owed`],
          next: `node scripts/invoices.mjs show ${inv.id}`,
        });
      }

      case "charge":
      case "email-page": {
        const inv = await invoiceOr(db, rest[0]);
        if (inv.status !== "open") fail(`${at}: invoice #${inv.id} is ${inv.status}; only an open one`, `node scripts/invoices.mjs show ${inv.id}`);
        if (cmd === "charge" && !inv.sent_at) fail(`${at}: invoice #${inv.id} is not sent yet`, `node scripts/invoices.mjs send ${inv.id} --charge`);
        const card = cmd === "charge" ? await defaultCard(db, inv.email, inv.livemode ?? false) : null;
        if (cmd === "charge" && !card) fail(`${at}: ${inv.name ?? inv.email} has no card on file; a card is saved when they pay an invoice on Stripe's page`, `node scripts/invoices.mjs email-page ${inv.id}`);
        const say = cmd === "charge"
          ? `What is left on invoice ${inv.number ?? "#" + inv.id} is charged now to ${cardName(card!)}, the card ${inv.email} saved.`
          : inv.collect === "charge"
            ? `${inv.email} is emailed from the owner's own address the payment page of invoice ${inv.number ?? "#" + inv.id}, where they pay with any card or confirm a charge (Stripe does not email the page of an invoice it charges).`
            : `Stripe emails ${inv.email} the payment page of invoice ${inv.number ?? "#" + inv.id}, where they pay with any card.`;
        if (!has(a, "confirm")) {
          if (json) return out(true, { would: say }, String);
          return done(at, fmt(inv), { lines: [say], waits: `node scripts/invoices.mjs ${cmd} ${inv.id}` });
        }
        const stripe = stripeOr(cli.env, at);
        const r = cmd === "charge" ? await chargeInvoice(db, stripe, inv.id, by)
          : await emailPaymentPage(db, stripe, inv.id, { send: (mail) => sendEmail(cli.env, mail), business: cli.business, replyTo: by.includes("@") ? by : null });
        if (!r.ok) fail(`${at}: ${r.message}`, cmd === "charge" ? `node scripts/invoices.mjs email-page ${inv.id}` : `node scripts/invoices.mjs show ${inv.id}`);
        if (json) return out(true, { done: cmd }, String);
        return done(at, cmd === "charge" ? `charged ${cardName(card!)} for invoice #${inv.id}` : `emailed ${inv.email} the payment page`, {
          lines: cmd === "charge" ? ["it turns paid here when Stripe's event arrives, a few seconds after"] : [],
          next: `node scripts/invoices.mjs show ${inv.id}`,
        });
      }

      case "send":
      case "void":
      case "uncollectible": {
        const inv = await invoiceOr(db, rest[0]);
        const charge = cmd === "send" && has(a, "charge");
        // The card a charge would use, read from Stripe (a preview, so the owner sees which).
        const card = charge && !inv.sent_at ? await (async () => {
          const stripe = stripeOr(cli.env, at);
          const { livemode } = await stripe<{ livemode: boolean }>("GET", "/v1/balance");
          return chargeCard(db, stripe, inv.email, livemode);
        })() : null;
        if (charge && !inv.sent_at && !card) fail(`${at}: ${inv.name ?? inv.email} has no card on file; a card is saved when they pay an invoice on Stripe's page`, `node scripts/invoices.mjs send ${inv.id}`);
        const say = {
          send: charge
            ? `Stripe makes invoice #${inv.id} in the owner's Stripe account and charges ${card ? cardName(card) : "the card"}, the card ${inv.email} saved: ${money(inv.total_cents, inv.currency)}. After this it no longer changes here.`
            : `Stripe makes invoice #${inv.id} in the owner's Stripe account and emails it to ${inv.email}: ${money(inv.total_cents, inv.currency)}, due ${inv.days_until_due} days after it is sent. After this it no longer changes here.`,
          void: `Invoice ${inv.number ?? "#" + inv.id} is voided in Stripe: ${inv.email} can no longer pay it. It cannot be undone.`,
          uncollectible: `Invoice ${inv.number ?? "#" + inv.id} is written off in Stripe. It can still be paid or voided later.`,
        }[cmd];
        // Already where the command would put it: done, and nothing goes to Stripe again.
        const already = cmd === "send" ? (inv.sent_at ? `sent ${local(inv.sent_at)}` : null)
          : inv.status === { void: "void", uncollectible: "uncollectible" }[cmd] ? inv.status : null;
        if (already) {
          if (json) return out(true, { already: cmd, invoice: inv }, String);
          return done(at, `invoice #${inv.id} is already ${already}; left alone`, { next: `node scripts/invoices.mjs show ${inv.id}` });
        }
        if (!has(a, "confirm")) {
          if (json) return out(true, { would: say }, String);
          return done(at, fmt(inv), { lines: [say], waits: `node scripts/invoices.mjs ${cmd} ${inv.id}` });
        }
        if (cmd === "void" && (await paidSoFar(db, inv.id)) > 0) fail(`${at}: part of invoice #${inv.id} is paid; Stripe will not void it. Write it off instead`, `node scripts/invoices.mjs uncollectible ${inv.id}`);
        const stripe = stripeOr(cli.env, at);
        if (cmd === "send") {
          const r = await sendInvoice(db, stripe, inv.id, by, { collect: charge ? "charge" : "email", timeZone: cli.timeZone });
          if (!r.ok) fail(`${at}: ${r.message}`, r.reason === "declined" || r.reason === "action" ? `node scripts/invoices.mjs email-page ${inv.id}` : `node scripts/invoices.mjs show ${inv.id}`);
          await cli.afterSend?.(db, { kind: "invoice", id: inv.id, email: inv.email }, by);
          if (json) return out(true, r.invoice, String);
          return done(at, `sent ${fmt(r.invoice)}`, { lines: [`their payment page: ${r.invoice.hosted_url ?? "(Stripe will add it)"}`], next: `node scripts/invoices.mjs show ${inv.id}` });
        }
        const r = cmd === "void" ? await voidInvoice(db, stripe, inv.id) : await markUncollectible(db, stripe, inv.id);
        if (!r.ok) fail(`${at}: ${r.message}`, `node scripts/invoices.mjs show ${inv.id}`);
        if (json) return out(true, { asked: cmd }, String);
        return done(at, `Stripe has it for invoice #${inv.id}`, { lines: ["it changes here when Stripe's event arrives, a few seconds after"], next: `node scripts/invoices.mjs show ${inv.id}` });
      }
    }
  });
}

// ---- recurring invoices ------------------------------------------------------

const RECURRING_FIELDS = ["name", "every", "first", "ends", "times", "mode", "ahead", "days", "notes", "note-for-team", "owner", "line", "quote", "currency", "confirm", "as"];
const RECURRING_FLAGS: Record<string, string[]> = {
  list: ["all", "customer"], show: [], add: RECURRING_FIELDS, edit: RECURRING_FIELDS,
  pause: ["as"], resume: ["confirm", "as"], end: ["confirm", "as"], "make-now": ["as"],
};
const RECURRING_ARITY: Record<string, number> = { list: 0, show: 1, add: 1, edit: 1, pause: 1, resume: 1, end: 1, "make-now": 1 };

/** "month", "2 weeks", "quarter", "year": every n units. */
function everyOf(v: string | undefined, at: string): { unit: string; every: string } {
  const t = (v ?? "month").trim().toLowerCase();
  if (t === "quarter" || t === "quarterly") return { unit: "month", every: "3" };
  // "monthly" is month, "weekly" week, "yearly" year.
  const m = /^(?:every\s+)?(\d{1,2})?\s*(week|month|year)s?$/.exec(t.replace(/ly$/, ""));
  if (!m) misused(`${at}: --every ${v}: write it as week, 2 weeks, month, 3 months, quarter or year`, "node scripts/recurring.mjs add ann@example.com --every month ...");
  return { unit: m![2], every: m![1] ?? "1" };
}

/**
 * Recurring invoices from chat: the same record as the Recurring tab. Adding
 * or changing one shows what it will do and waits for --confirm, as sending
 * does: from then on it sends or charges by itself on its dates.
 */
export async function recurringCli(argv: string[], cli: InvoicesCli): Promise<void> {
  const days = cli.daysUntilDue ?? 30;
  const HELP = `recurring.mjs <command> [...] [--json] [--as <email>]      invoices made on a schedule

  list [--all]                         every recurring invoice not ended (--all: ended too), next date first
  list --customer <who>
  show <id>                            what it does, its next date, the invoices it made
  add <who> --name "Maintenance plan" --line "<what>|[qty|]<price>[|<tax rate>]"... --first YYYY-MM-DD
      [--every month|2 weeks|quarter|year] [--mode draft|send|charge] [--ends YYYY-MM-DD | --times 12]
      [--ahead 3] [--days ${days}] [--notes "to the customer"] [--note-for-team "add 12% of ad spend"] [--owner <who gets its tasks>]
      [--quote <id>]                   with a quote not yet accepted: it starts at their yes
  edit <id> [the add flags]            from the next invoice; how often and the first date are fixed once one is made
  pause <id> | resume <id> | end <id>
  make-now <id>                        the next period's invoice now, as a draft to check and send
  add, edit, resume and end print what they would do; ... --confirm does it

--mode: draft (a draft --ahead days early, with a task: an amount that
changes), send (Stripe emails it to pay; the default), charge (the card they
saved; emailed to pay until they have one). A month's or year's first date
is the 1st to the 28th. Dates are in ${cli.timeZone}. A daily scheduled job
("Recurring invoices") makes each one on its date.

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  usage(a, cmd, Object.keys(RECURRING_FLAGS), HELP, "recurring", RECURRING_FLAGS);
  if (cli.off) fail(cli.off);
  const at = `recurring ${cmd}`;
  noMore(rest, RECURRING_ARITY[cmd], at);
  const json = has(a, "json");
  const fmt = (r: Recurring) => [`#${r.id}`, `[${r.status}]`, r.name ? `${r.name} <${r.email}>` : r.email, r.title, money(r.total_cents, r.currency),
    r.status === "active" ? `next ${r.next_on}` : "", r.mode].filter(Boolean).join("  ");
  const one = async (db: Db, id: string | undefined) => {
    if (!id || !ID.test(id)) misused(`${at}: name a recurring invoice by its id`, "node scripts/recurring.mjs list");
    return (await recurringById(db, id)) ?? fail(`${at}: no recurring invoice ${id}`, "node scripts/recurring.mjs list");
  };
  // Wrong input is refused before the database is opened.
  const every = (cmd === "add" || cmd === "edit") && has(a, "every") ? everyOf(flag(a, "every"), at) : null;
  if (has(a, "mode") && !MODES.includes(flag(a, "mode") as never)) misused(`${at}: --mode is one of ${MODES.join(", ")}`, "node scripts/recurring.mjs --help");
  if (has(a, "ends") && has(a, "times")) misused(`${at}: --ends or --times, not both`, "node scripts/recurring.mjs --help");
  const quoteId = flag(a, "quote");
  if (quoteId !== undefined && (!ID.test(quoteId) || cmd !== "add")) misused(`${at}: --quote takes a quote's id, on add`, "node scripts/quotes.mjs list");
  const cardFor = async (db: Db, r: Recurring) => (r.mode === "charge" ? await defaultCard(db, r.email, true) ?? await defaultCard(db, r.email, false) : null);

  await cli.withDb(async (db) => {
    const by = actor(a);
    switch (cmd) {
      case "list": {
        const p = has(a, "customer") ? await personOf(db, cli, flag(a, "customer"), at) : null;
        const rows = await recurringList(db, p ? { email: p.email } : { all: has(a, "all") });
        if (json) return out(true, rows, String);
        return done(at, rows.length ? plural(rows.length, "recurring invoice") : "no recurring invoices", { lines: rows.map(fmt) });
      }
      case "show": {
        const r = await one(db, rest[0]);
        const card = await cardFor(db, r);
        const made = await invoicesOf(db, r.id);
        if (json) return out(true, { ...r, invoices: made }, String);
        return done(at, fmt(r), {
          lines: [
            describe(r, card ? cardName(card) : null),
            ...r.lines.map((l) => `${l.position}. ${l.description}: ${l.quantity} x ${money(l.unit_cents, r.currency)} = ${money(l.amount_cents, r.currency)}`),
            r.status === "pending" ? `starts when quote #${r.quote_id} is accepted` : r.status === "active" ? `next: ${shortDay(r.next_on)}` : "",
            r.note_for_team ? `note for the team: ${r.note_for_team}` : "",
            ...made.map((i) => `invoice #${i.id} for ${i.period_on ? periodLabel(r.unit, i.period_on) : "?"}: [${i.status}] ${money(i.total_cents, i.currency)}`),
          ].filter(Boolean),
        });
      }
      case "add":
      case "edit": {
        const rates = await taxRates(db);
        const now = cmd === "edit" ? await one(db, rest[0]) : null;
        let f: RecurringFields;
        if (now) {
          f = {
            email: now.email, name: now.name, phone: now.phone, address: now.address, currency: now.currency, title: now.title, unit: now.unit,
            every: String(now.every), first_on: now.first_on, ends: now.ends_after ? "after" : now.ends_on ? "on" : "never", ends_on: now.ends_on, ends_after: now.ends_after,
            mode: now.mode, days_ahead: now.days_ahead, days_until_due: now.days_until_due, notes: now.notes, note_for_team: now.note_for_team, owner: now.owner,
            lines: now.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: amountInput(l.unit_cents, now.currency), tax_rate_id: l.tax_rate_id ?? "" })),
          };
        } else {
          const p = await personOf(db, cli, rest[0], at);
          f = { ...p, currency: cli.currency, unit: "month", every: "1", mode: "send", days_until_due: String(days), ends: "never", lines: [] };
        }
        if (has(a, "name")) f.title = flag(a, "name");
        if (every) Object.assign(f, every);
        if (has(a, "first")) f.first_on = flag(a, "first");
        if (has(a, "ends")) Object.assign(f, flag(a, "ends") === "never" ? { ends: "never" } : { ends: "on", ends_on: flag(a, "ends") });
        if (has(a, "times")) Object.assign(f, { ends: "after", ends_after: flag(a, "times") });
        if (has(a, "mode")) f.mode = flag(a, "mode");
        if (has(a, "ahead")) f.days_ahead = flag(a, "ahead");
        if (has(a, "days")) f.days_until_due = flag(a, "days");
        if (has(a, "notes")) f.notes = flag(a, "notes");
        if (has(a, "note-for-team")) f.note_for_team = flag(a, "note-for-team");
        if (has(a, "owner")) f.owner = flag(a, "owner");
        if (has(a, "currency")) f.currency = flag(a, "currency");
        if (has(a, "line")) f.lines = lineFlags(a, rates, "recurring");
        const quote = quoteId ? (await quoteById(db, quoteId)) ?? fail(`${at}: no quote ${quoteId}`, "node scripts/quotes.mjs list") : null;
        const pending = quote && ["draft", "sent", "expired"].includes(quote.status) ? { quoteId: quote.id } : undefined;
        if (!has(a, "confirm")) {
          // A dry run: checked, then shown in words; nothing saved.
          const shown = now ?? null;
          const preview = await previewRecurring(db, f, now ?? undefined);
          if (!preview.ok) fail(`${at}: not saved\n${problems(preview.errors)}`, "node scripts/recurring.mjs --help");
          const words = describe(preview.value, null);
          if (json) return out(true, { would: words }, String);
          return done(at, `${shown ? "would save" : "would add"} ${preview.value.title} for ${preview.value.name ?? preview.value.email}`, {
            lines: [words, pending ? `it starts when quote #${quote!.id} is accepted` : ""].filter(Boolean),
            waits: `node scripts/recurring.mjs ${argv.filter((x) => x !== "--json").join(" ")}`,
          });
        }
        const r = now ? await saveRecurring(db, now.id, f, by) : await createRecurring(db, f, by, cli.source, { pending });
        if (!r.ok) fail(`${at}: not saved\n${problems(r.errors)}`, "node scripts/recurring.mjs --help");
        if (quote?.status === "accepted" && !now) await db.sql`update recurring_invoices set quote_id = ${quote.id}::bigint where id = ${r.value.id}::bigint`;
        // What the quote shows (the CRM's proposal page) says what follows its yes.
        const onQuote = pending ? quote : now?.status === "pending" && now.quote_id ? await quoteById(db, now.quote_id) : null;
        if (onQuote) await (cli.quoteSaved ?? cli.proposal?.saved)?.(db, onQuote);
        if (json) return out(true, r.value, String);
        return done(at, `${now ? "saved" : r.value.status === "pending" ? "added, waiting for the quote's yes:" : "added"} ${fmt(r.value)}`, {
          lines: [describe(r.value, null)],
          next: `node scripts/recurring.mjs show ${r.value.id}`,
        });
      }
      case "pause":
      case "resume":
      case "end": {
        const r = await one(db, rest[0]);
        const say = { pause: "Nothing is made until it is resumed.", resume: `It starts again from the next date to come; dates missed while paused are not made. ${describe(r, null)}`, end: "No more invoices are made. Those it made stay. It cannot be restarted." }[cmd];
        if (cmd !== "pause" && !has(a, "confirm")) {
          if (json) return out(true, { would: say }, String);
          return done(at, fmt(r), { lines: [say], waits: `node scripts/recurring.mjs ${cmd} ${r.id}` });
        }
        const ok = cmd === "pause" ? await pauseRecurring(db, r.id, by) : cmd === "resume" ? await resumeRecurring(db, r.id, by, todayIn(cli.timeZone)) : await endRecurring(db, r.id, by);
        if (!ok) fail(`${at}: #${r.id} is ${r.status}`, `node scripts/recurring.mjs show ${r.id}`);
        if (json) return out(true, { done: cmd }, String);
        return done(at, `${{ pause: "paused", resume: "resumed", end: "ended" }[cmd]} #${r.id}`, { lines: [say], next: `node scripts/recurring.mjs show ${r.id}` });
      }
      case "make-now": {
        const r = await one(db, rest[0]);
        const inv = await makeNow(db, r.id, { today: todayIn(cli.timeZone), timeZone: cli.timeZone, stripe: () => stripeOr(cli.env, at), by });
        if (!inv) fail(`${at}: #${r.id} is ${r.status}, or has ended`, `node scripts/recurring.mjs show ${r.id}`);
        if (json) return out(true, inv, String);
        return done(at, `made invoice #${inv!.id} for ${periodLabel(r.unit, inv!.period_on!)} as a draft`, { next: `node scripts/invoices.mjs send ${inv!.id}` });
      }
    }
  });
}
