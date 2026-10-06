// Quotes from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings, its customers as <who>, and "job". `--help` for usage.
import { quotesCli } from "../src/invoices/cli";
import { visitsCfg } from "../src/config";
import { fail, out } from "../src/data/cli";
import { jobFromQuote } from "../src/crm/quotes";
import { quoteById } from "../src/invoices/quotes";
import { cliSettings } from "./lib";

await quotesCli(process.argv.slice(2), {
  ...cliSettings("quotes"),
  more: visitsCfg
    ? {
        help: `  job <id>                             an accepted quote's ${visitsCfg.one.toLowerCase()} (its customer added if new)\n`,
        commands: {
          job: async (db, a, rest, by) => {
            const qt = (rest[0] && /^\d{1,18}$/.test(rest[0]) ? await quoteById(db, rest[0]) : null) ?? fail(`no quote ${rest[0] ?? ""}\n  Try: node scripts/quotes.mjs list`);
            if (qt.status !== "accepted") fail(`quote ${qt.number} is ${qt.status}; only an accepted quote becomes a ${visitsCfg!.one.toLowerCase()}`);
            const r = (await jobFromQuote(db, qt, by)) ?? fail("no open stage to add the customer to\n  Try: node scripts/stages.mjs list");
            out(a.flags.json !== undefined, r, () => `${visitsCfg!.one.toLowerCase()} #${r.visitId} for ${r.customer.name} (#${r.customer.id})`);
          },
        },
      }
    : undefined,
});
