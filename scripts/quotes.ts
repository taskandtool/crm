// Quotes from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings, its customers as <who>, and "job". `--help` for usage.
import { quotesCli } from "../src/invoices/cli";
import { visitsCfg } from "../src/config";
import { jobFromQuote } from "../src/crm/quotes";
import { winFromQuotes } from "../src/crm/deals";
import { quoteById } from "../src/invoices/quotes";
import { cliSettings, done, fail, has, misused, out } from "./lib";

await quotesCli(process.argv.slice(2), {
  ...cliSettings("quotes"),
  // A yes wins the deal the quote is for.
  afterDecide: async (db, _qt, by) => (await winFromQuotes(db, by)).map((d) => `deal #${d.id} ${d.title} won`),
  more: visitsCfg
    ? {
        help: `  job <id>                             an accepted quote's ${visitsCfg.one.toLowerCase()} (its customer added if new)\n`,
        flags: { job: ["as"] },
        commands: {
          job: async (db, a, rest, by) => {
            const at = "quotes job";
            if (!rest[0] || !/^\d{1,18}$/.test(rest[0])) misused(`${at}: name an accepted quote by its id`, "node scripts/quotes.mjs list --status accepted");
            if (rest.length > 1) misused(`${at}: unexpected ${rest.slice(1).join(" ")}`, "node scripts/quotes.mjs --help");
            const qt = (await quoteById(db, rest[0])) ?? fail(`${at}: no quote ${rest[0]}`, "node scripts/quotes.mjs list");
            if (qt.status !== "accepted") fail(`${at}: quote ${qt.number} is ${qt.status}; only an accepted quote becomes a ${visitsCfg!.one.toLowerCase()}`, `node scripts/quotes.mjs show ${qt.id}`);
            const r = (await jobFromQuote(db, qt, by)) ?? fail(`${at}: there is no open status to add the customer to`, "node scripts/stages.mjs list --statuses");
            if (has(a, "json")) return out(true, r, String);
            done(at, `${qt.visit_id ? "already made: " : ""}${visitsCfg!.one.toLowerCase()} #${r.visitId} for ${r.customer.name} (#${r.customer.id})${qt.visit_id ? "; left alone" : ""}`, { next: `node scripts/visits.mjs show ${r.visitId}` });
          },
        },
      }
    : undefined,
});
