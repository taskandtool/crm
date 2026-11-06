// The lead report from chat, and what a daily job saves into it: ad costs and a lead's outcome.
// An app gives it its database, zone and currency:
//
//   await reportsCli(process.argv.slice(2), { withDb, zone, currency: "USD" });
//
// How to set the job up: references/daily-numbers.md.
import { readFileSync } from "node:fs";
import { LEAD_OUTCOMES, setLeadOutcome, type LeadOutcome } from "../customers/customer";
import { done, fail, flag, has, misused, noMore, out, parseArgs, usage } from "../data/cli.mjs";
import type { Db } from "../data/db";
import { formatMoney, toMinor } from "../payments/money";
import { saveAdSpend, type AdSpend } from "./ad-spend";
import { breakdown, costPerLead, loadLeadReport, type LeadFigures } from "./leads";
import { addDays, run, todayIn } from "./sql";

type Lead = { id: string; name: string | null; outcome: string | null; sold_cents: number | null; external_id: string | null; external_status: string | null; external_url: string | null };
const LEAD = (where: string) => `select l.id::text as id, c.name, l.outcome, l.sold_cents::float8 as sold_cents, l.external_id, l.external_status, l.external_url from leads l join customers c on c.id = l.customer_id where ${where}`;

export async function reportsCli(argv: string[], app: { withDb: <T>(fn: (db: Db) => Promise<T>) => Promise<T>; zone: string; currency: string; who?: string }): Promise<void> {
  const money = (cents: number) => formatMoney(cents, app.currency);
  const HELP = `reports.mjs <command> [...] [--json]      the lead report's figures, and what a daily job saves into them

  summary [--days 30]        leads, cost, cost per ad lead, clicks, appointments, no-shows and sold, by source
  spend --file rows.json     save ad costs: [{ "day": "2026-11-05", "source": "facebook",
                             "campaign": "Spring Roof", "content": "Roof | 4:5",
                             "spend_cents": 4210, "currency": "${app.currency.toLowerCase()}", "clicks": 91, "impressions": 5400 }]
  spend --day YYYY-MM-DD --source facebook --cost 42.10 [--campaign c] [--ad a] [--clicks n] [--impressions n]
                             save one row, in ${app.currency}
  outcome <lead id|ext:their-id> [--status ${LEAD_OUTCOMES.join("|")}|none] [--sold 1200.00] [--external-id x] [--external-status "Set"] [--external-url u]
                             where a lead got to, here or in the client's own CRM; only what is given changes

Tags are normalized as a form's UTM is, so they match the leads those ads brought.
Saving a day and ad again replaces it, so a daily job can re-read recent days. A re-run says "already".
How to set the job up: .claude/skills/reports/references/daily-numbers.md

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;
  const FLAGS: Record<string, string[]> = {
    summary: ["days"],
    spend: ["file", "day", "source", "cost", "campaign", "ad", "clicks", "impressions"],
    outcome: ["status", "sold", "external-id", "external-status", "external-url"],
  };
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  usage(a, cmd, Object.keys(FLAGS), HELP, "reports", FLAGS);
  const at = `reports ${cmd}`;
  noMore(rest, cmd === "outcome" ? 1 : 0, at);
  const json = has(a, "json");
  const SPEND = "node scripts/reports.mjs spend --day 2026-11-05 --source facebook --cost 42.10";
  const OUTCOME = "node scripts/reports.mjs outcome 12 --status sold --sold 1200.00";
  const whole = (name: string) => {
    const v = flag(a, name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) misused(`${at}: --${name} ${v}: a whole number`, cmd === "spend" ? SPEND : "node scripts/reports.mjs summary --days 30");
    return Number(v);
  };
  const cents = (name: string, tryCmd: string): number | undefined => {
    const v = flag(a, name);
    if (v === undefined) return undefined;
    const n = toMinor(v.replace(/,/g, ""), app.currency);
    if (n === null) misused(`${at}: --${name} ${v}: an amount like 42.10`, tryCmd);
    return n as number;
  };

  await app.withDb(async (db) => {
    if (cmd === "spend") {
      const file = flag(a, "file");
      let rows: AdSpend[];
      if (file) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch (e) {
          misused(`${at}: --file ${file}: ${e instanceof Error ? e.message : String(e)}`, SPEND);
        }
        if (!Array.isArray(parsed)) misused(`${at}: --file ${file}: a JSON list of rows`, "node scripts/reports.mjs --help");
        rows = parsed as AdSpend[];
      } else {
        const cost = cents("cost", SPEND);
        if (cost === undefined) misused(`${at}: --cost: an amount like 42.10`, SPEND);
        rows = [{ day: flag(a, "day") ?? "", source: flag(a, "source") ?? "", campaign: flag(a, "campaign"), content: flag(a, "ad"), spend_cents: cost as number, currency: app.currency, clicks: whole("clicks"), impressions: whole("impressions") }];
      }
      const other = rows.find((x) => x?.currency && x.currency.toLowerCase() !== app.currency.toLowerCase());
      if (other) return fail(`${at}: ${other.currency} isn't this app's currency, ${app.currency}; convert it first; nothing saved`, "node scripts/reports.mjs --help");
      const r = await saveAdSpend(db, rows);
      if (!r.ok) return fail(`${at}: ${r.why}; nothing saved`, "node scripts/reports.mjs --help");
      if (json) return out(true, r, String);
      return done(at, `saved ${r.saved} row${r.saved === 1 ? "" : "s"}; a day and ad saved before is replaced`, { next: "node scripts/reports.mjs summary" });
    }

    if (cmd === "outcome") {
      const name = rest[0] ?? misused(`${at}: name a lead by its id, or ext:<their id>`, OUTCOME);
      const external = name.startsWith("ext:");
      if (!external && !/^#?\d{1,18}$/.test(name)) misused(`${at}: name a lead by its id, or ext:<their id>`, OUTCOME);
      const by = external ? name.slice(4) : name.replace(/^#/, "");
      const [l] = await run<Lead>(db, { text: LEAD(external ? "l.external_id = $1" : "l.id = $1::bigint"), values: [by] });
      if (!l) return fail(`${at}: no lead ${name}`, external ? "node scripts/reports.mjs outcome <id> --external-id <their id>" : "node scripts/reports.mjs summary");
      const status = flag(a, "status");
      if (status !== undefined && status !== "none" && !(LEAD_OUTCOMES as readonly string[]).includes(status)) misused(`${at}: --status ${status}: one of ${LEAD_OUTCOMES.join(", ")}, none`, OUTCOME);
      const sold = cents("sold", OUTCOME);
      const externalId = flag(a, "external-id");
      const externalStatus = flag(a, "external-status");
      const url = flag(a, "external-url");
      if (status === undefined && sold === undefined && externalId === undefined && externalStatus === undefined && url === undefined) misused(`${at}: say what changed: --status, --sold or --external-status`, OUTCOME);
      if (url !== undefined && !/^https?:\/\//i.test(url)) misused(`${at}: --external-url ${url}: a web address, http or https`, "node scripts/reports.mjs outcome 12 --external-url https://their-crm.example/lead/9");
      if (externalId !== undefined) {
        const [other] = await run<Lead>(db, { text: LEAD("l.external_id = $1"), values: [externalId] });
        if (other && other.id !== l.id) return fail(`${at}: external id ${externalId} is already lead ${other.id} (${other.name})`, "node scripts/reports.mjs --help");
      }
      const outcome = status === undefined ? undefined : status === "none" ? null : (status as LeadOutcome);
      const same = (outcome === undefined || outcome === l.outcome) && (sold === undefined || sold === l.sold_cents)
        && (externalId === undefined || externalId === l.external_id) && (externalStatus === undefined || externalStatus === l.external_status) && (url === undefined || url === l.external_url);
      if (same) return json ? out(true, l, String) : done(at, `lead ${l.id} (${l.name}) already says that; left alone`);
      await setLeadOutcome(db, l.id, { outcome, soldCents: sold, externalId, externalStatus, externalUrl: url }, app.who ?? "AI");
      const [now] = await run<Lead>(db, { text: LEAD("l.id = $1::bigint"), values: [l.id] });
      if (json) return out(true, now, String);
      return done(at, `lead ${l.id} (${now.name}): ${now.outcome ?? "no outcome"}${now.sold_cents !== null ? `, sold for ${money(now.sold_cents)}` : ""}${now.external_status ? `, "${now.external_status}" in their CRM` : ""}`, { next: "node scripts/reports.mjs summary" });
    }

    const days = whole("days") ?? 30;
    if (days < 1 || days > 730) misused(`${at}: --days ${days}: 1 to 730`, "node scripts/reports.mjs summary --days 30");
    const today = todayIn(app.zone);
    const report = await loadLeadReport(db, { period: { from: addDays(today, 1 - days), to: today }, zone: app.zone, currency: app.currency });
    const line = (name: string, f: LeadFigures) => {
      const cpl = costPerLead(f);
      return `${name}: ${f.leads} leads, cost ${money(f.spend_cents)}, per ad lead ${cpl === null ? "n/a" : money(Math.round(cpl))}, ${f.clicks} clicks, ${f.appointments} appointments, ${f.no_shows} no-shows, ${f.sold} sold`;
    };
    if (json) return out(true, { total: report.total, by_source: breakdown(report, "source") }, String);
    return done(at, line(`last ${days} days`, report.total), { lines: breakdown(report, "source").map((r) => line(r.name || "not tagged", r)) });
  });
}
