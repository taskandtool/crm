// Invoices from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings, its customers as <who>, "from-job" and "bill". `--help` for usage.
import { invoicesCli, problems, stripeOr } from "../src/invoices/cli";
import { visitsCfg } from "../src/config";
import type { Db } from "../src/data/db";
import { findCustomer } from "../src/crm/customers";
import { amountText, customerVisits, getVisit, type Visit } from "../src/crm/visits";
import { createInvoice, invoiceById, invoiceFromQuote, invoicesFor, type Invoice } from "../src/invoices/invoices";
import { quotesFor } from "../src/invoices/quotes";
import { sendInvoice } from "../src/invoices/stripe";
import { formatMoney as money } from "../src/payments/money";
import { cliSettings, done, fail, flag, has, local, misused, out, resolveCustomer } from "./lib";

type Outcome = "drafted" | "took_draft" | "sent" | "left_alone";

const word = () => visitsCfg!.one.toLowerCase();
const billable = (v: Visit) => v.amount_cents !== null && Number(v.amount_cents) > 0;
/** The job's invoices that still count: every one but a void one. */
const liveFor = async (db: Db, v: Visit) => (await invoicesFor(db, { visitId: v.id })).filter((i) => i.status !== "void");
const sentWhen = (i: Invoice) => (i.sent_at ? ` (sent ${local(i.sent_at)})` : "");

/**
 * The job's invoice: a sent one is left alone; else its draft; else one made
 * from its accepted quote (the quote's lines and tax, once); else one line of
 * the job's title and amount.
 */
async function invoiceForJob(db: Db, job: Visit, by: string, at: string): Promise<{ invoice: Invoice; outcome: Outcome }> {
  const live = await liveFor(db, job);
  const sent = live.find((i) => i.status !== "draft");
  if (sent) return { invoice: sent, outcome: "left_alone" };
  if (live[0]) return { invoice: (await invoiceById(db, live[0].id))!, outcome: "took_draft" };
  const s = cliSettings("invoices");
  const quote = (await quotesFor(db, { visitId: job.id })).find((q) => q.status === "accepted");
  if (quote) {
    const r = await invoiceFromQuote(db, quote.id, by, s.source, s.daysUntilDue ?? 30);
    const id = r.ok ? r.value.id : (r.reason === "invoiced" && r.invoiceId) || fail(`${at}: quote #${quote.id} could not be invoiced (${r.reason})`, `node scripts/quotes.mjs show ${quote.id}`);
    return { invoice: (await invoiceById(db, id))!, outcome: "drafted" };
  }
  const currency = (job.currency ?? s.currency).toLowerCase();
  const customer = await findCustomer(db, job.customer_id);
  const r = await createInvoice(db, {
    email: job.customer_email, name: job.customer_name, phone: job.customer_phone, address: customer?.address ?? null,
    currency, visit_id: job.id, days_until_due: String(s.daysUntilDue ?? 30),
    lines: [{ description: job.title, quantity: "1", unit: amountText(job.amount_cents, currency.toUpperCase()) }],
  }, by, s.source);
  if (!r.ok) fail(`${at}: ${problems(r.errors)}`, `node scripts/visits.mjs show ${job.id}`);
  return { invoice: (await invoiceById(db, r.value.id))!, outcome: "drafted" };
}

const about = (inv: Invoice, job: Visit) =>
  `invoice #${inv.id} to ${inv.name ?? ""} <${inv.email}>: ${job.title}${inv.quote_id ? ` (quote #${inv.quote_id})` : ""}, ${money(inv.total_cents, inv.currency)}, due ${inv.days_until_due} days after it is sent`;
const listJobs = (jobs: Visit[]) => jobs.map((v) => `#${v.id} ${v.title} ${money(v.amount_cents ?? 0, v.currency ?? cliSettings("invoices").currency)}`);

await invoicesCli(process.argv.slice(2), {
  ...cliSettings("invoices"),
  more: visitsCfg
    ? {
        help:
          `  from-job <id>                        a ${word()}'s invoice: its draft, its accepted quote, or its title and amount\n` +
          `  bill <who> [--job <id>] [--confirm]  the invoice for their finished ${word()}, in one step: drafts it (or takes\n` +
          `                                       its draft) and says what Stripe will do; --confirm sends it\n`,
        flags: { "from-job": ["as"], bill: ["job", "confirm", "as"] },
        commands: {
          "from-job": async (db, a, rest, by) => {
            const at = "invoices from-job";
            const finishedJobs = "node scripts/visits.mjs list --done";
            if (!rest[0] || !/^\d{1,18}$/.test(rest[0])) misused(`${at}: name a ${word()} by its id`, finishedJobs);
            if (rest.length > 1) misused(`${at}: unexpected ${rest.slice(1).join(" ")}`, "node scripts/invoices.mjs --help");
            const job = (await getVisit(db, rest[0])) ?? fail(`${at}: no ${word()} #${rest[0]}`, finishedJobs);
            if (!billable(job)) fail(`${at}: ${word()} #${job.id} has no amount`, `node scripts/visits.mjs update ${job.id} --amount <price>`);
            const { invoice, outcome } = await invoiceForJob(db, job, by, at);
            if (has(a, "json")) return out(true, { outcome, invoice }, String);
            if (outcome === "left_alone") {
              return done(at, `invoice #${invoice.id} for ${word()} #${job.id} is already ${invoice.status}${sentWhen(invoice)}; left alone`, { next: `node scripts/invoices.mjs show ${invoice.id}` });
            }
            done(at, `${outcome === "drafted" ? "drafted" : "took the draft"} ${about(invoice, job)}`, { next: `node scripts/invoices.mjs send ${invoice.id}` });
          },

          bill: async (db, a, rest, by) => {
            const at = "invoices bill";
            if (!rest[0]) misused(`${at}: name the customer by id, email or phone`, "node scripts/invoices.mjs bill ann@example.com");
            if (rest.length > 1) misused(`${at}: unexpected ${rest.slice(1).join(" ")}`, "node scripts/invoices.mjs --help");
            if (has(a, "job") && !/^\d{1,18}$/.test(flag(a, "job") ?? "")) misused(`${at}: --job takes a ${word()}'s id`, `node scripts/visits.mjs list --customer ${rest[0]}`);
            const c = await resolveCustomer(db, rest[0], at);
            if (!c.email) fail(`${at}: ${c.name} has no email, and Stripe emails the invoice`, `node scripts/customers.mjs update ${c.id} --email <address>`);
            const json = has(a, "json");
            const finished = (await customerVisits(db, c.id)).filter((v) => v.status === "done");
            const unbilled: Visit[] = [];
            for (const v of finished) if (billable(v) && !(await liveFor(db, v)).some((i) => i.status !== "draft")) unbilled.push(v);

            let job: Visit;
            if (has(a, "job")) {
              job = finished.find((v) => v.id === flag(a, "job")) ?? fail(`${at}: ${c.name} has no finished ${word()} #${flag(a, "job")}`, `node scripts/visits.mjs list --customer ${c.email}`);
              if (!billable(job)) fail(`${at}: ${word()} #${job.id} has no amount`, `node scripts/visits.mjs update ${job.id} --amount <price>`);
            } else {
              // A retry of a send that went through must not bill the next job:
              // an invoice sent to them in the last hour is the one they asked for.
              const recent = (await invoicesFor(db, { email: c.email })).find((i) => i.status !== "void" && i.sent_at && Date.now() - i.sent_at.getTime() < 3_600_000);
              if (recent) {
                if (json) return out(true, { outcome: "left_alone" as Outcome, invoice: recent, unbilled }, String);
                return done(at, `nothing new was sent: invoice #${recent.id} went to ${c.email}${sentWhen(recent)}, so this looks like a repeat; left alone`, {
                  lines: unbilled.length ? ["not invoiced yet:", ...listJobs(unbilled).map((l) => `  ${l}`)] : [],
                  next: unbilled.length ? `to bill one: node scripts/invoices.mjs bill ${c.email} --job <id>` : `node scripts/invoices.mjs show ${recent.id}`,
                });
              }
              if (!unbilled.length) {
                fail(`${at}: ${c.name} has no finished ${word()} with an amount that is not invoiced yet` +
                  (finished.length ? `; their finished ${word()}s: ${finished.map((v) => `#${v.id} ${v.title}`).join(", ")}` : ""),
                  `node scripts/invoices.mjs list --customer ${c.email}`);
              }
              if (unbilled.length > 1) {
                misused(`${at}: ${c.name} has ${unbilled.length} finished ${word()}s not invoiced yet; ask the owner which:\n${listJobs(unbilled).map((l) => `  ${l}`).join("\n")}`,
                  `node scripts/invoices.mjs bill ${c.email} --job <id>`);
              }
              job = unbilled[0];
            }

            const { invoice, outcome } = await invoiceForJob(db, job, by, at);
            if (outcome === "left_alone") {
              if (json) return out(true, { outcome, invoice }, String);
              return done(at, `invoice #${invoice.id} for ${word()} #${job.id} is already ${invoice.status}${sentWhen(invoice)}; left alone`, {
                lines: invoice.hosted_url ? [`their payment page: ${invoice.hosted_url}`] : [],
                next: `node scripts/invoices.mjs show ${invoice.id}`,
              });
            }
            if (!has(a, "confirm")) {
              if (json) return out(true, { outcome, invoice }, String);
              return done(at, `${outcome === "drafted" ? "drafted" : "took the draft"} ${about(invoice, job)}`, { waits: `node scripts/invoices.mjs bill ${c.email} --job ${job.id}` });
            }
            const r = await sendInvoice(db, stripeOr(cliSettings("invoices").env, at), invoice.id, by);
            if (!r.ok) fail(`${at}: ${r.message}`, `node scripts/invoices.mjs show ${invoice.id}`);
            if (json) return out(true, { outcome: "sent" as Outcome, invoice: r.invoice }, String);
            return done(at, `sent ${about(r.invoice, job)}; Stripe emailed it${r.invoice.livemode === false ? " (test mode)" : ""}`, {
              lines: [`their payment page: ${r.invoice.hosted_url ?? "(Stripe adds it in a moment)"}`],
              next: `node scripts/invoices.mjs show ${invoice.id}`,
            });
          },
        },
      }
    : undefined,
});
