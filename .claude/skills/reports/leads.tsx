// The lead report's pieces: load the figures once, then lay out whichever
// components a business wants. Each takes the loaded report and nothing else.
//
//   const r = await loadLeadReport(db, { period, zone, currency: "usd" });
//   <LeadKpis report={r} /> <LeadTrends report={r} /> <LeadFunnel report={r} /> <LeadBreakdown report={r} by="campaign" href={(by) => `?by=${by}`} />
//
// Leads come from the `leads` table with their UTM tags, cost from `ad_spend`,
// and how far each got from the CRM's bookings and deals or a lead's `outcome`.
// A daily job fills what lives elsewhere: references/daily-numbers.md.
import type { Db } from "../data/db";
import { tagWords } from "../forms/origin";
import { AskAi } from "../admin/list";
import { BarChart, bucketLabel, ChartScripts, formatNumber, FunnelChart, fromMinor, KpiRow, KpiTile, LineChart } from "./charts";
import { addDays, adSpendQuery, days, leadRollupQuery, previousPeriod, run, type Grain, type Period } from "./sql";

export type LeadFigures = { leads: number; /** Those from a source with ad cost in the period: what cost per lead divides by. */ ad_leads: number; appointments: number; no_shows: number; sold: number; sold_cents: number; spend_cents: number; clicks: number; impressions: number };
type LeadCell = LeadFigures & { day: string; source: string; campaign: string; content: string; term: string };
export type LeadReport = {
  period: Period;
  previous: Period;
  grain: Grain;
  currency: string;
  /** One row per day and tag. */
  cells: LeadCell[];
  total: LeadFigures;
  earlier: LeadFigures;
  /** What the figures are narrowed to. */
  filter: ReportFilter;
};
/** Narrows the report to one source, campaign, ad or keyword; several narrow together. */
export type ReportFilter = Partial<Record<BreakdownBy, string>>;
/** A filter's value for leads with no such tag. */
export const UNTAGGED = "~none";
export const BREAKDOWNS = { source: "Source", campaign: "Campaign", content: "Ad", term: "Keyword" } as const;
export type BreakdownBy = keyof typeof BREAKDOWNS;

const ZERO: LeadFigures = { leads: 0, ad_leads: 0, appointments: 0, no_shows: 0, sold: 0, sold_cents: 0, spend_cents: 0, clicks: 0, impressions: 0 };
const add = (a: LeadFigures, b: Partial<LeadFigures>): LeadFigures => {
  const out = { ...a };
  for (const k of Object.keys(ZERO) as (keyof LeadFigures)[]) out[k] += b[k] ?? 0;
  return out;
};
const totalOf = (rows: Partial<LeadFigures>[]) => rows.reduce<LeadFigures>(add, ZERO);

/**
 * Cost per lead in minor units: cost over the leads ads could have brought, so a referral doesn't make
 * ads look cheaper. Null with no cost or no such lead, which is not a cost of nothing.
 */
export const costPerLead = (f: Pick<LeadFigures, "spend_cents" | "ad_leads">) => (f.spend_cents > 0 && f.ad_leads > 0 ? f.spend_cents / f.ad_leads : null);

/** One source under the names ad platforms give it: Meta's {{site_source_name}} says fb and ig. */
const SAME_SOURCE: Record<string, string> = { fb: "facebook", ig: "instagram", yt: "youtube", gads: "google", adwords: "google" };

async function cellsFor(db: Db, p: Period, zone: string, currency: string) {
  const [has] = await db.sql<{ deals: boolean; quotes: boolean; spend: boolean; bookings: boolean; bookingCustomers: boolean; submissions: boolean }>`
    select to_regclass('deals') is not null and to_regclass('deal_stages') is not null as deals, to_regclass('quotes') is not null as quotes,
           to_regclass('ad_spend') is not null as spend, to_regclass('bookings') is not null as bookings, to_regclass('submissions') is not null as submissions,
           exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'bookings' and column_name = 'customer_id') as "bookingCustomers"`;
  const leads = await run<Omit<LeadCell, "ad_leads" | "spend_cents" | "clicks" | "impressions">>(db, leadRollupQuery(p, zone, has));
  const spend = has.spend ? await run<{ day: string; source: string; campaign: string; content: string; currency: string; spend_cents: number; clicks: number; impressions: number }>(db, adSpendQuery(p)) : [];
  // Amounts in two currencies are never added: the report is in one.
  const here = spend.filter((s) => s.currency === currency.toLowerCase());
  const cells = [...leads.map((l) => ({ ...ZERO, ...l })), ...here.map(({ currency: _c, ...s }) => ({ ...ZERO, ...s, term: "" }))] as LeadCell[];
  for (const c of cells) c.source = SAME_SOURCE[c.source] ?? c.source;
  const paid = new Set(cells.filter((c) => c.spend_cents > 0).map((c) => c.source));
  for (const c of cells) if (paid.has(c.source)) c.ad_leads = c.leads;
  return cells;
}

/** A short period by the day, about a quarter by the week, longer by the month. */
const grainFor = (p: Period): Grain => (days(p) <= 45 ? "day" : days(p) <= 120 ? "week" : "month");

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Ad cost isn't by keyword, so a keyword narrows to leads alone.
const matches = (c: LeadCell, f: ReportFilter) =>
  (f.term === undefined || c.leads > 0) && (Object.keys(f) as BreakdownBy[]).every((k) => f[k] === undefined || c[k] === (f[k] === UNTAGGED ? "" : f[k]));

export async function loadLeadReport(db: Db, o: { period: Period; zone: string; currency: string; filter?: ReportFilter }): Promise<LeadReport> {
  const previous = previousPeriod(o.period);
  const filter = o.filter ?? {};
  const [now, then] = (await Promise.all([cellsFor(db, o.period, o.zone, o.currency), cellsFor(db, previous, o.zone, o.currency)])).map((cells) => cells.filter((c) => matches(c, filter)));
  return { period: o.period, previous, grain: grainFor(o.period), currency: o.currency.toUpperCase(), cells: now, total: totalOf(now), earlier: totalOf(then), filter };
}

/** A tag as a person reads it. */
export const tagLabel = (by: BreakdownBy, tag: string) => (tag && tag !== UNTAGGED ? sentence(tagWords(tag)) : by === "term" ? "No keyword" : "Not tagged");

/** The local date a day's bucket starts on: Monday for a week. */
function bucketOf(day: string, grain: Grain): string {
  if (grain === "day") return day;
  if (grain === "month") return `${day.slice(0, 8)}01`;
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** The period's buckets in order, nothing missed where nothing happened. */
export function bucketsOf(p: Period, grain: Grain): string[] {
  const out: string[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
    const b = bucketOf(d, grain);
    if (out[out.length - 1] !== b) out.push(b);
  }
  return out;
}

/** The report rolled up by a tag, most leads first: cost with no leads still shows, under its ad. */
export function breakdown(r: LeadReport, by: BreakdownBy): (LeadFigures & { name: string })[] {
  const groups = new Map<string, LeadFigures>();
  // Ad platforms' cost isn't by keyword here, so that view is leads alone.
  for (const c of by === "term" ? r.cells.filter((x) => x.leads > 0) : r.cells) groups.set(c[by], add(groups.get(c[by]) ?? ZERO, c));
  return [...groups].map(([name, f]) => ({ name, ...f })).sort((a, b) => b.leads - a.leads || b.spend_cents - a.spend_cents || a.name.localeCompare(b.name));
}

const money = (r: LeadReport, digits = 0) => ({ style: "currency" as const, currency: r.currency, digits });
const inMajor = (cents: number | null, r: LeadReport) => (cents === null ? null : fromMinor(cents, r.currency));

export function LeadKpis({ report: r, locale = "en-US" }: { report: LeadReport; locale?: string }) {
  const against = `the previous ${days(r.previous)} days`;
  const t = r.total;
  const e = r.earlier;
  return (
    <KpiRow label="Lead figures" class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
      <KpiTile label="Leads" value={t.leads} previous={e.leads} against={against} locale={locale} />
      <KpiTile label="Ad cost" value={inMajor(t.spend_cents, r)} previous={inMajor(e.spend_cents, r)} format={money(r)} against={against} lowerIsBetter obvious locale={locale} />
      <KpiTile label="Cost per ad lead" value={inMajor(costPerLead(t), r)} previous={inMajor(costPerLead(e), r)} format={money(r, 2)} against={against} lowerIsBetter obvious locale={locale} />
      <KpiTile label="Appointments set" value={t.appointments} previous={e.appointments} against={against} locale={locale} />
      <KpiTile label="No-shows" value={t.no_shows} previous={e.no_shows} against={against} lowerIsBetter obvious locale={locale} />
      <KpiTile label="Sold" value={t.sold} previous={e.sold} against={against} locale={locale} />
    </KpiRow>
  );
}

/** Leads and cost over the period: two cards, for the page's own grid. */
export function LeadTrends({ report: r, locale = "en-US" }: { report: LeadReport; locale?: string }) {
  // A week or month the period starts partway through would read as a fall.
  const buckets = bucketsOf(r.period, r.grain).filter((b, i, all) => b >= r.period.from || all.length === 1);
  const unit = r.grain;
  const per = (field: "leads" | "spend_cents") => {
    const sums = new Map<string, number>();
    for (const c of r.cells) {
      const b = bucketOf(c.day, r.grain);
      sums.set(b, (sums.get(b) ?? 0) + c[field]);
    }
    return buckets.map((b) => sums.get(b) ?? 0);
  };
  const labels = buckets.map((b) => bucketLabel(b, r.grain, locale));
  return (
    <>
      <LineChart title={`Leads per ${unit}`} labels={labels} series={[{ label: "Leads", data: per("leads") }]} format={{ digits: 0 }} locale={locale} />
      <BarChart title={`Ad cost per ${unit}`} labels={labels} series={[{ label: "Ad cost", data: per("spend_cents").map((c) => fromMinor(c, r.currency)) }]} format={money(r)} locale={locale} />
    </>
  );
}

export function LeadFunnel({ report: r, locale = "en-US" }: { report: LeadReport; locale?: string }) {
  const t = r.total;
  return (
    <FunnelChart
      title="From lead to sale"
      steps={[
        { label: "Leads", value: t.leads },
        { label: "Appointments set", value: t.appointments },
        { label: "Showed", value: Math.max(t.appointments - t.no_shows, 0) },
        { label: "Sold", value: t.sold },
      ]}
      locale={locale}
    />
  );
}

const th = "px-4 py-2.5 text-right font-medium first:text-left";
const td = "px-4 py-2.5 text-right tabular-nums first:text-left first:font-medium";

/**
 * Leads, cost and how far they got, by source, campaign, ad or keyword. `href` adds the tabs, and
 * `rowHref` makes each row a link: the page narrows to it.
 */
export function LeadBreakdown({ report: r, by, href, rowHref, locale = "en-US", termLabel }: { report: LeadReport; by: BreakdownBy; href?: (by: BreakdownBy) => string; rowHref?: (by: BreakdownBy, tag: string) => string; locale?: string; termLabel?: string }) {
  const labels = { ...BREAKDOWNS, term: termLabel ?? BREAKDOWNS.term };
  const rows = breakdown(r, by);
  const costs = by !== "term";
  const tabs = (Object.keys(BREAKDOWNS) as BreakdownBy[]).filter((k) => k !== "term" || by === "term" || r.cells.some((c) => c.term));
  const shown = (f: LeadFigures) => (
    <>
      <td class={td}>{formatNumber(f.leads, {}, locale)}</td>
      {costs ? (
        <>
          <td class={td}>{f.spend_cents ? formatNumber(inMajor(f.spend_cents, r), money(r), locale) : "–"}</td>
          <td class={td}>{formatNumber(inMajor(costPerLead(f), r), money(r, 2), locale)}</td>
        </>
      ) : null}
      <td class={td}>{formatNumber(f.appointments, {}, locale)}</td>
      <td class={td}>{formatNumber(f.no_shows, {}, locale)}</td>
      <td class={td}>{formatNumber(f.sold, {}, locale)}</td>
      <td class={td}>{f.sold_cents ? formatNumber(inMajor(f.sold_cents, r), money(r), locale) : "–"}</td>
    </>
  );
  return (
    <div class="overflow-hidden rounded-card border border-line bg-surface">
      {href ? (
        <nav aria-label="Group by" class="flex gap-1 border-b border-line p-2">
          {tabs.map((k) => (
            <a href={href(k)} aria-current={k === by ? "true" : undefined}
              class={"inline-flex min-h-9 items-center rounded-control px-3 text-label font-medium no-underline " + (k === by ? "bg-panel text-ink" : "text-ink-2 hover:text-ink")}>
              {labels[k]}
            </a>
          ))}
        </nav>
      ) : null}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[42rem] border-collapse text-copy">
          <caption class="sr-only">Leads by {labels[by].toLowerCase()}</caption>
          <thead>
            <tr class="border-b border-line text-label text-ink-3">
              <th scope="col" class={th}>{labels[by]}</th>
              <th scope="col" class={th}>Leads</th>
              {costs ? (
                <>
                  <th scope="col" class={th}>Ad cost</th>
                  <th scope="col" class={th}>Cost per ad lead</th>
                </>
              ) : null}
              <th scope="col" class={th}>Appts</th>
              <th scope="col" class={th}>No-shows</th>
              <th scope="col" class={th}>Sold</th>
              <th scope="col" class={th}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr class="border-b border-line last:border-0">
                <td class={td}>{rowHref ? <a href={rowHref(by, row.name || UNTAGGED)} class="underline decoration-line-strong underline-offset-2 hover:text-accent">{tagLabel(by, row.name)}</a> : tagLabel(by, row.name)}</td>
                {shown(row)}
              </tr>
            )) : (
              <tr><td colspan={8} class="px-4 py-8 text-center text-ink-2">No leads in this period.</td></tr>
            )}
          </tbody>
          {rows.length > 1 ? (
            <tfoot>
              <tr class="border-t border-line-strong font-semibold">
                <td class={td}>Total</td>
                {shown(r.total)}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}

export const REPORT_PERIODS = [7, 30, 90, 365] as const;
const periodLabel = (d: number) => (d === 365 ? "1 year" : `${d} days`);

/** What a report page's address asks for: `?days=30&by=campaign&source=facebook`. */
export function reportQuery(query: (name: string) => string | undefined): { days: number; by: BreakdownBy; filter: ReportFilter } {
  const filter: ReportFilter = {};
  for (const k of Object.keys(BREAKDOWNS) as BreakdownBy[]) {
    const v = query(k);
    if (v) filter[k] = v;
  }
  return {
    days: REPORT_PERIODS.find((d) => String(d) === query("days")) ?? 30,
    by: (Object.keys(BREAKDOWNS) as BreakdownBy[]).find((k) => k === query("by")) ?? "source",
    filter,
  };
}

/** The period's switch, for the page's header. */
export function ReportPeriods({ base, days, by, filter }: { base: string; days: number; by: BreakdownBy; filter: ReportFilter }) {
  return (
    <nav aria-label="Period" class="inline-flex flex-wrap gap-0.5 rounded-control bg-panel p-1">
      {REPORT_PERIODS.map((d) => (
        <a href={`${base}?${new URLSearchParams({ days: String(d), by, ...filter })}`} aria-current={d === days ? "true" : undefined}
          class={"inline-flex min-h-9 items-center rounded-control px-3 text-label font-medium no-underline " + (d === days ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink")}>
          {periodLabel(d)}
        </a>
      ))}
    </nav>
  );
}

/**
 * The whole report, laid out: what's filtered, the figures, the charts, the table. A row narrows the
 * page and shows what is inside it: a source's campaigns, a campaign's ads. `scripts` is where
 * client.js is served. To change a business's report, lay the components out in its own page instead.
 */
export function LeadReportBody({ report: r, base, scripts, days, by, locale = "en-US", termLabel, setupNotes = true }: { report: LeadReport; base: string; scripts: string; days: number; by: BreakdownBy; locale?: string; termLabel?: string; setupNotes?: boolean }) {
  const labels = { ...BREAKDOWNS, term: termLabel ?? BREAKDOWNS.term };
  const here = (o: { by?: BreakdownBy; filter?: ReportFilter }) => `${base}?${new URLSearchParams({ days: String(days), by: o.by ?? by, ...(o.filter ?? r.filter) })}`;
  const inside: Partial<Record<BreakdownBy, BreakdownBy>> = { source: "campaign", campaign: "content" };
  const narrowed = (Object.keys(r.filter) as BreakdownBy[]).filter((k) => r.filter[k] !== undefined);
  return (
    <div class="space-y-6">
      <ChartScripts src={scripts} />
      {narrowed.length ? (
        <div class="flex flex-wrap items-center gap-2 text-label">
          {narrowed.map((k) => {
            const { [k]: _gone, ...rest } = r.filter;
            return (
              <a href={here({ filter: rest })} aria-label={`Stop filtering by ${labels[k].toLowerCase()}`} class="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 font-medium text-ink no-underline hover:border-line-strong">
                <span class="text-ink-3">{labels[k]}:</span> {tagLabel(k, r.filter[k]!)} <span aria-hidden="true" class="text-ink-3">×</span>
              </a>
            );
          })}
          {narrowed.length > 1 ? <a href={here({ filter: {} })} class="px-2 font-medium text-ink-2 hover:text-ink">Clear all</a> : null}
        </div>
      ) : null}
      <LeadKpis report={r} locale={locale} />
      {setupNotes && r.total.spend_cents === 0 && !narrowed.length ? <AskAi ask="Each morning, read yesterday's ad costs from our ad account and save them for the lead report" /> : null}
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <LeadTrends report={r} locale={locale} />
        <LeadFunnel report={r} locale={locale} />
      </div>
      <LeadBreakdown report={r} by={by} href={(k) => here({ by: k })} rowHref={(k, tag) => here({ by: inside[k] ?? k, filter: { ...r.filter, [k]: tag } })} locale={locale} termLabel={termLabel} />
    </div>
  );
}
