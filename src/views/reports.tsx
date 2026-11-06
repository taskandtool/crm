// The Reports page: the reports skill's lead components, laid out for this
// business. To change the report, change this file: drop a component, move
// one, or add a new one beside them (.claude/skills/reports/SKILL.md).
import { AskAi } from "../admin/list";
import { ChartScripts } from "../reports/charts";
import { BREAKDOWNS, LeadBreakdown, LeadFunnel, LeadKpis, LeadTrends, tagLabel, type BreakdownBy, type ReportFilter, type LeadReport } from "../reports/leads";
import { Layout } from "./layout";
import { viewsClass } from "./ui";

export const REPORT_PERIODS = [7, 30, 90, 365] as const;
const label = (d: number) => (d === 365 ? "1 year" : `${d} days`);

export function ReportsPage(p: { user: string; report: LeadReport; days: number; by: BreakdownBy }) {
  const { report: r } = p;
  const here = (o: { days?: number; by?: BreakdownBy; filter?: ReportFilter }) => {
    const q = new URLSearchParams({ days: String(o.days ?? p.days), by: o.by ?? p.by, ...(o.filter ?? r.filter) });
    return `/reports?${q}`;
  };
  // A row narrows the page and shows what is inside it: a source's campaigns, a campaign's ads.
  const inside: Partial<Record<BreakdownBy, BreakdownBy>> = { source: "campaign", campaign: "content" };
  const narrowed = (Object.keys(r.filter) as BreakdownBy[]).filter((k) => r.filter[k] !== undefined);
  return (
    <Layout title="Reports" user={p.user} section="reports" wide
      actions={
        <nav aria-label="Period" class={viewsClass}>
          {REPORT_PERIODS.map((d) => (
            <a href={here({ days: d })} aria-current={d === p.days ? "true" : undefined} class={"inline-flex min-h-9 items-center rounded-control px-3 text-label font-medium no-underline " + (d === p.days ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink")}>{label(d)}</a>
          ))}
        </nav>
      }>
      <ChartScripts src="/reports.js" />
      <div class="space-y-6">
        {narrowed.length ? (
          <div class="flex flex-wrap items-center gap-2 text-label">
            {narrowed.map((k) => {
              const { [k]: _gone, ...rest } = r.filter;
              return (
                <a href={here({ filter: rest })} aria-label={`Stop filtering by ${BREAKDOWNS[k].toLowerCase()}`} class="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 font-medium text-ink no-underline hover:border-line-strong">
                  <span class="text-ink-3">{BREAKDOWNS[k]}:</span> {tagLabel(k, r.filter[k]!)} <span aria-hidden="true" class="text-ink-3">×</span>
                </a>
              );
            })}
            {narrowed.length > 1 ? <a href={here({ filter: {} })} class="px-2 font-medium text-ink-2 hover:text-ink">Clear all</a> : null}
          </div>
        ) : null}
        <LeadKpis report={r} />
        {r.total.spend_cents === 0 && !narrowed.length ? <AskAi ask="Each morning, read yesterday's ad costs from our ad account and save them for the lead report" /> : null}
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <LeadTrends report={r} />
          <LeadFunnel report={r} />
        </div>
        <LeadBreakdown report={r} by={p.by} href={(by) => here({ by })} rowHref={(by, tag) => here({ by: inside[by] ?? by, filter: { ...r.filter, [by]: tag } })} />
      </div>
    </Layout>
  );
}
