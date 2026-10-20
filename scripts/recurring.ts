// Recurring invoices from chat: the invoices skill's command (src/invoices/cli.ts)
// with this CRM's settings and its customers as <who>. A recurring invoice
// on a quote that is not yet accepted waits for its yes, and the quote's
// proposal page says what follows. `--help` for usage.
import { recurringCli } from "../src/invoices/cli";
import { cfg, invoicesCfg } from "../src/config";
import { ensureProposal, storePage } from "../src/proposals/store";
import { businessOf } from "../src/data/business";
import { cliSettings } from "./lib";

await recurringCli(process.argv.slice(2), {
  ...cliSettings("recurring"),
  word: invoicesCfg?.word ?? "Quote",
  quoteSaved: async (db, qt) => {
    await ensureProposal(db, qt);
    const r = await storePage(db, qt.id, { business: (await businessOf(db)).name ?? "", word: invoicesCfg?.word ?? "Quote", timeZone: cfg.time_zone });
    if (!r.ok) console.error(`its proposal page was not made again: ${r.why}`);
  },
});
