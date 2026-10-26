// The proposal as a customer sees it, every component ticked, on a made-up
// quote: the page written to uploads/proposal-preview/page.html, then
// screenshots at desktop and phone width (tt-crawl shoot, from a server on
// this machine that lives only as long as the shots). For looking at the
// components after a change; nothing is stored on a quote.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { cfg, dealsCfg, invoicesCfg } from "../src/config";
import { done, fail, parseArgs, plain } from "../src/data/cli.mjs";
import { PICKABLE } from "../src/proposals/components";
import { fillPage, renderPage } from "../src/proposals/page";
import { formatMoney } from "../src/payments/money";

const HELP = `usage: node scripts/proposal-preview.mjs

Draws the proposal page with every component ticked, on a made-up quote
(a made-up business, three lines, a deposit invoice on it), into
uploads/proposal-preview/page.html, and screenshots it at 1280 and 390
pixels wide with tt-crawl shoot. Nothing is stored on a quote. Run it after
npm run css.

Prints the page's path and each width's images (the first to read named),
then Next:. Exit 1 when the page or the shots fail; 2 when misused.`;

const a = parseArgs(process.argv.slice(2));
plain(a, HELP, "proposal-preview");

const OUT = "uploads/proposal-preview";
const word = invoicesCfg?.word ?? "Quote";
const business = "Lakeside Home Repair";
const now = new Date();
// The business's own currency, as its deals are counted in.
const currency = dealsCfg.currency.toLowerCase();
const line = (id: string, description: string, cents: number) =>
  ({ id, position: Number(id), description, quantity: "1", unit_cents: cents, tax_rate_id: null, amount_cents: String(cents), tax_cents: "0" });
const lines = [line("1", "The work, as quoted", 480000), line("2", "Materials", 215000), line("3", "Clean-up and disposal", 35000)];
const total = lines.reduce((s, l) => s + l.unit_cents, 0);
const valid = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
const quote = {
  id: "0", number: "Q-0000", email: "customer@example.com", name: "Sam Rivera", phone: null, address: null, status: "sent", currency,
  subtotal_cents: String(total), tax_cents: "0", total_cents: String(total), valid_until: valid,
  notes: "Thank you for having us out. This is the work we talked about, at the price below.",
  terms: "- Prices hold until the date above.\n- 30% is due when you sign, the balance when the work is done.",
  sent_at: now, decided_at: null, decided_by: null, viewed_at: null, visit_id: null, deal_id: null, source: "crm",
  created_by: "preview", updated_by: null, created_at: now, updated_at: now, lines,
};
const deposit = formatMoney(Math.round(total * 0.3), currency);

let html: string;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  html = renderPage({ word, business, timeZone: cfg.time_zone, quote: quote as any, rates: [], title: `A ${word.toLowerCase()} for Sam Rivera`,
    beforeSign: `When you sign, the invoice for ${deposit} is due, and you are taken straight to pay it online.`, agreed: "" }, PICKABLE.map((c) => c.key));
  html = fillPage(html, { kind: "open", action: "/q/preview", sha: "0".repeat(64), reasons: ["Price", "Timing"] }, word);
} catch (e) {
  fail(`proposal-preview: the page did not draw (${(e as Error).message})`, "npm run css && npm run check");
}
mkdirSync(OUT, { recursive: true });
const page = join(OUT, "page.html");
writeFileSync(page, html);

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(page));
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as AddressInfo).port;
let shot: string;
try {
  // The shot runs while this process serves the page, so it cannot block it.
  shot = await new Promise<string>((ok, no) =>
    execFile("tt-crawl", ["shoot", `http://127.0.0.1:${port}/`, "--out", OUT], { encoding: "utf8", timeout: 180_000 }, (err, stdout, stderr) =>
      err ? no(new Error((stderr || err.message).trim().split("\n").pop())) : ok(stdout)));
} catch (e) {
  server.close();
  fail(`proposal-preview: the screenshots failed (${(e as Error).message})`, "bash .taskandtool/setup.sh, which installs tt-crawl and its browser");
}
server.close();
const shots = shot.trim().split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim());
done("proposal-preview", `${PICKABLE.length} components on a made-up ${word.toLowerCase()}`, {
  lines: [`the page: ${page}`, ...shots],
  next: "read the images it names; fix a component, npm run css, then this again",
});
