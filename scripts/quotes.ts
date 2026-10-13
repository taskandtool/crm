// Quotes from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings and its customers as <who>. `--help` for usage.
import { quotesCli } from "../src/invoices/cli";
import { winFromQuotes } from "../src/crm/deals";
import { cliSettings } from "./lib";

await quotesCli(process.argv.slice(2), {
  ...cliSettings("quotes"),
  // A yes wins the deal the quote is for.
  afterDecide: async (db, _qt, by) => (await winFromQuotes(db, by)).map((d) => `deal #${d.id} ${d.title} won`),
});
