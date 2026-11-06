// The lead report from chat, and what a daily job saves into it. `node scripts/reports.mjs --help`.
import { readFileSync } from "node:fs";
import { cfg, dealsCfg } from "../src/config";
import { saveAdSpend, type AdSpend } from "../src/reports/ad-spend";
import { breakdown, costPerLead, loadLeadReport } from "../src/reports/leads";
import { addDays, todayIn } from "../src/reports/sql";
import { parseAmount } from "../src/crm/text";
import { done, fail, flag, has, misused, noMore, out, parseArgs, usage, withDb } from "./lib";

const HELP = `reports.mjs <command> [...] [--json]      the lead report's figures, and the ad costs behind them

  summary [--days 30]        leads, cost, cost per lead, appointments, no-shows and sold, by source
  spend --file rows.json     save ad costs: [{ "day": "2026-11-05", "source": "facebook",
                             "campaign": "Spring Roof", "content": "Roof | 4:5",
                             "spend_cents": 4210, "currency": "usd", "clicks": 91, "impressions": 5400 }]
  spend --day YYYY-MM-DD --source facebook --cost 42.10 [--campaign c] [--ad a] [--clicks n] [--impressions n]
                             save one row, in ${dealsCfg.currency}

Tags are normalized as a form's UTM is, so they match the leads those ads brought.
Saving a day and ad again replaces it, so a daily job can re-read recent days.
How to set the job up: .claude/skills/reports/references/daily-numbers.md

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = { summary: ["days"], spend: ["file", "day", "source", "cost", "campaign", "ad", "clicks", "impressions"] };
const a = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "reports", FLAGS);
const at = `reports ${cmd}`;
noMore(rest, 0, at);
const json = has(a, "json");
const TRY = `node scripts/reports.mjs spend --day 2026-11-05 --source facebook --cost 42.10`;
const whole = (name: string) => {
  const v = flag(a, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) misused(`${at}: --${name} ${v}: a whole number`, TRY);
  return Number(v);
};

function rowsFromFlags(): AdSpend[] {
  const cost = parseAmount(flag(a, "cost") ?? "", dealsCfg.currency);
  if (cost === "invalid" || cost === null) misused(`${at}: --cost: an amount like 42.10`, TRY);
  return [{ day: flag(a, "day") ?? "", source: flag(a, "source") ?? "", campaign: flag(a, "campaign"), content: flag(a, "ad"), spend_cents: cost as number, currency: dealsCfg.currency, clicks: whole("clicks"), impressions: whole("impressions") }];
}

function rowsFromFile(file: string): AdSpend[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    misused(`${at}: --file ${file}: ${e instanceof Error ? e.message : String(e)}`, TRY);
  }
  if (!Array.isArray(parsed)) misused(`${at}: --file ${file}: a JSON list of rows`, "node scripts/reports.mjs --help");
  return parsed as AdSpend[];
}

await withDb(async (db) => {
  if (cmd === "spend") {
    const file = flag(a, "file");
    const rows = file ? rowsFromFile(file) : rowsFromFlags();
    const r = await saveAdSpend(db, rows);
    if (!r.ok) return fail(`${at}: ${r.why}; nothing saved`, "node scripts/reports.mjs --help");
    if (json) return out(true, r, String);
    return done(at, `saved ${r.saved} row${r.saved === 1 ? "" : "s"}; a day and ad saved before is replaced`, { next: "node scripts/reports.mjs summary" });
  }
  const days = whole("days") ?? 30;
  if (days < 1 || days > 730) misused(`${at}: --days ${days}: 1 to 730`, "node scripts/reports.mjs summary --days 30");
  const today = todayIn(cfg.time_zone);
  const report = await loadLeadReport(db, { period: { from: addDays(today, 1 - days), to: today }, zone: cfg.time_zone, currency: dealsCfg.currency });
  const line = (name: string, f: Parameters<typeof costPerLead>[0] & { leads: number; spend_cents: number; appointments: number; no_shows: number; sold: number }) => {
    const cpl = costPerLead(f);
    return `${name}: ${f.leads} leads, cost ${(f.spend_cents / 100).toFixed(2)}, per lead ${cpl === null ? "n/a" : (cpl / 100).toFixed(2)}, ${f.appointments} appointments, ${f.no_shows} no-shows, ${f.sold} sold`;
  };
  if (json) return out(true, { total: report.total, by_source: breakdown(report, "source") }, String);
  return done(at, line(`last ${days} days`, report.total), { lines: breakdown(report, "source").map((r) => line(r.name || "not tagged", r)) });
});
