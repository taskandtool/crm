// Invoices from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings, its customers as <who>, "from-event" and "bill". `--help` for usage.
import { invoicesCli, problems, stripeOr } from "../src/invoices/cli";
import { eventsCfg } from "../src/config";
import type { Db } from "../src/data/db";
import { findCustomer } from "../src/crm/customers";
import { customerEvents, getEvent, type Event } from "../src/crm/events";
import { amountText } from "../src/crm/text";
import { createInvoice, invoiceById, invoiceFromQuote, invoicesFor, type Invoice } from "../src/invoices/invoices";
import { quotesFor } from "../src/invoices/quotes";
import { sendInvoice } from "../src/invoices/stripe";
import { formatMoney } from "../src/payments/money";
import { cliSettings, done, fail, flag, has, local, misused, out, resolveCustomer } from "./lib";

type Outcome = "drafted" | "took_draft" | "sent" | "left_alone";

const word = () => eventsCfg!.one.toLowerCase();
const billable = (e: Event) => e.amount_cents !== null && Number(e.amount_cents) > 0;
/** The event's invoices that still count: every one but a void one. */
const liveFor = async (db: Db, e: Event) => (await invoicesFor(db, { visitId: e.id })).filter((i) => i.status !== "void");
const sentWhen = (i: Invoice) => (i.sent_at ? ` (sent ${local(i.sent_at)})` : "");

/**
 * The event's invoice: a sent one is left alone; else its draft; else one made
 * from its accepted quote (the quote's lines and tax, once); else one line of
 * what it was and its amount.
 */
async function invoiceForEvent(db: Db, event: Event, by: string, at: string): Promise<{ invoice: Invoice; outcome: Outcome }> {
  const live = await liveFor(db, event);
  const sent = live.find((i) => i.status !== "draft");
  if (sent) return { invoice: sent, outcome: "left_alone" };
  if (live[0]) return { invoice: (await invoiceById(db, live[0].id))!, outcome: "took_draft" };
  const s = cliSettings("invoices");
  const quote = (await quotesFor(db, { visitId: event.id })).find((q) => q.status === "accepted");
  if (quote) {
    const r = await invoiceFromQuote(db, quote.id, by, s.source, s.daysUntilDue ?? 30);
    const id = r.ok ? r.value.id : (r.reason === "invoiced" && r.invoiceId) || fail(`${at}: quote #${quote.id} could not be invoiced (${r.reason})`, `node scripts/quotes.mjs show ${quote.id}`);
    return { invoice: (await invoiceById(db, id))!, outcome: "drafted" };
  }
  const currency = (event.currency ?? s.currency).toLowerCase();
  if (!event.email) fail(`${at}: ${event.customer_name ?? event.name} has no email, and Stripe emails the invoice`, event.customer_id ? `node scripts/customers.mjs update ${event.customer_id} --email <address>` : `node scripts/events.mjs show ${event.id}`);
  const customer = event.customer_id ? await findCustomer(db, event.customer_id) : null;
  const r = await createInvoice(db, {
    email: event.email, name: event.customer_name ?? event.name, phone: event.phone, address: customer?.address ?? event.location,
    currency, visit_id: event.id, days_until_due: String(s.daysUntilDue ?? 30),
    lines: [{ description: event.what, quantity: "1", unit: amountText(event.amount_cents, currency.toUpperCase()) }],
  }, by, s.source);
  if (!r.ok) fail(`${at}: ${problems(r.errors)}`, `node scripts/events.mjs show ${event.id}`);
  return { invoice: (await invoiceById(db, r.value.id))!, outcome: "drafted" };
}

const about = (inv: Invoice, event: Event) =>
  `invoice #${inv.id} to ${inv.name ?? ""} <${inv.email}>: ${event.what}${inv.quote_id ? ` (quote #${inv.quote_id})` : ""}, ${formatMoney(inv.total_cents, inv.currency)}, due ${inv.days_until_due} days after it is sent`;
const listEvents = (events: Event[]) => events.map((e) => `#${e.id} ${e.what} ${formatMoney(e.amount_cents ?? 0, e.currency ?? cliSettings("invoices").currency)}`);

await invoicesCli(process.argv.slice(2), {
  ...cliSettings("invoices"),
  more: eventsCfg
    ? {
        help:
          `  from-event <id>                      a ${word()}'s invoice: its draft, its accepted quote, or what it was and its amount\n` +
          `  bill <who> [--event <id>] [--confirm] the invoice for their finished ${word()}, in one step: drafts it (or takes\n` +
          `                                       its draft) and says what Stripe will do; --confirm sends it\n`,
        flags: { "from-event": ["as"], bill: ["event", "confirm", "as"] },
        commands: {
          "from-event": async (db, a, rest, by) => {
            const at = "invoices from-event";
            const pastOnes = "node scripts/events.mjs list --past";
            if (!rest[0] || !/^\d{1,18}$/.test(rest[0])) misused(`${at}: name a ${word()} by its id`, pastOnes);
            if (rest.length > 1) misused(`${at}: unexpected ${rest.slice(1).join(" ")}`, "node scripts/invoices.mjs --help");
            const event = (await getEvent(db, rest[0])) ?? fail(`${at}: no ${word()} #${rest[0]}`, pastOnes);
            if (!billable(event)) fail(`${at}: ${word()} #${event.id} has no amount`, `node scripts/events.mjs update ${event.id} --amount <price>`);
            const { invoice, outcome } = await invoiceForEvent(db, event, by, at);
            if (has(a, "json")) return out(true, { outcome, invoice }, String);
            if (outcome === "left_alone") {
              return done(at, `invoice #${invoice.id} for ${word()} #${event.id} is already ${invoice.status}${sentWhen(invoice)}; left alone`, { next: `node scripts/invoices.mjs show ${invoice.id}` });
            }
            done(at, `${outcome === "drafted" ? "drafted" : "took the draft"} ${about(invoice, event)}`, { next: `node scripts/invoices.mjs send ${invoice.id}` });
          },

          bill: async (db, a, rest, by) => {
            const at = "invoices bill";
            if (!rest[0]) misused(`${at}: name the customer by id, email or phone`, "node scripts/invoices.mjs bill ann@example.com");
            if (rest.length > 1) misused(`${at}: unexpected ${rest.slice(1).join(" ")}`, "node scripts/invoices.mjs --help");
            if (has(a, "event") && !/^\d{1,18}$/.test(flag(a, "event") ?? "")) misused(`${at}: --event takes a ${word()}'s id`, `node scripts/events.mjs list --customer ${rest[0]}`);
            const c = await resolveCustomer(db, rest[0], at);
            if (!c.email) fail(`${at}: ${c.name} has no email, and Stripe emails the invoice`, `node scripts/customers.mjs update ${c.id} --email <address>`);
            const json = has(a, "json");
            const finished = (await customerEvents(db, c.id)).filter((e) => e.status === "completed");
            const unbilled: Event[] = [];
            for (const e of finished) if (billable(e) && !(await liveFor(db, e)).some((i) => i.status !== "draft")) unbilled.push(e);

            let event: Event;
            if (has(a, "event")) {
              event = finished.find((e) => e.id === flag(a, "event")) ?? fail(`${at}: ${c.name} has no finished ${word()} #${flag(a, "event")}`, `node scripts/events.mjs list --customer ${c.email}`);
              if (!billable(event)) fail(`${at}: ${word()} #${event.id} has no amount`, `node scripts/events.mjs update ${event.id} --amount <price>`);
            } else {
              // A retry of a send that went through must not bill the next one:
              // an invoice sent to them in the last hour is the one they asked for.
              const recent = (await invoicesFor(db, { email: c.email })).find((i) => i.status !== "void" && i.sent_at && Date.now() - i.sent_at.getTime() < 3_600_000);
              if (recent) {
                if (json) return out(true, { outcome: "left_alone" as Outcome, invoice: recent, unbilled }, String);
                return done(at, `nothing new was sent: invoice #${recent.id} went to ${c.email}${sentWhen(recent)}, so this looks like a repeat; left alone`, {
                  lines: unbilled.length ? ["not invoiced yet:", ...listEvents(unbilled).map((l) => `  ${l}`)] : [],
                  next: unbilled.length ? `to bill one: node scripts/invoices.mjs bill ${c.email} --event <id>` : `node scripts/invoices.mjs show ${recent.id}`,
                });
              }
              if (!unbilled.length) {
                fail(`${at}: ${c.name} has no finished ${word()} with an amount that is not invoiced yet` +
                  (finished.length ? `; their finished ${word()}s: ${finished.map((e) => `#${e.id} ${e.what}`).join(", ")}` : ""),
                  `node scripts/invoices.mjs list --customer ${c.email}`);
              }
              if (unbilled.length > 1) {
                misused(`${at}: ${c.name} has ${unbilled.length} finished ${word()}s not invoiced yet; ask the owner which:\n${listEvents(unbilled).map((l) => `  ${l}`).join("\n")}`,
                  `node scripts/invoices.mjs bill ${c.email} --event <id>`);
              }
              event = unbilled[0];
            }

            const { invoice, outcome } = await invoiceForEvent(db, event, by, at);
            if (outcome === "left_alone") {
              if (json) return out(true, { outcome, invoice }, String);
              return done(at, `invoice #${invoice.id} for ${word()} #${event.id} is already ${invoice.status}${sentWhen(invoice)}; left alone`, {
                lines: invoice.hosted_url ? [`their payment page: ${invoice.hosted_url}`] : [],
                next: `node scripts/invoices.mjs show ${invoice.id}`,
              });
            }
            if (!has(a, "confirm")) {
              if (json) return out(true, { outcome, invoice }, String);
              return done(at, `${outcome === "drafted" ? "drafted" : "took the draft"} ${about(invoice, event)}`, { waits: `node scripts/invoices.mjs bill ${c.email} --event ${event.id}` });
            }
            const r = await sendInvoice(db, stripeOr(cliSettings("invoices").env, at), invoice.id, by);
            if (!r.ok) fail(`${at}: ${r.message}`, `node scripts/invoices.mjs show ${invoice.id}`);
            if (json) return out(true, { outcome: "sent" as Outcome, invoice: r.invoice }, String);
            return done(at, `sent ${about(r.invoice, event)}; Stripe emailed it${r.invoice.livemode === false ? " (test mode)" : ""}`, {
              lines: [`their payment page: ${r.invoice.hosted_url ?? "(Stripe adds it in a moment)"}`],
              next: `node scripts/invoices.mjs show ${invoice.id}`,
            });
          },
        },
      }
    : undefined,
});
