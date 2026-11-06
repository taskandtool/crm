// The Reports page: the reports skill's lead components, laid out for this
// business. To change the report, change this file: drop a component, move
// one, or add a new one beside them (.claude/skills/reports/SKILL.md).
import { AskAi } from "../admin/list";
import { ChartScripts } from "../reports/charts";
import { LeadBreakdown, LeadFunnel, LeadKpis, LeadTrends, type BreakdownBy, type LeadReport } from "../reports/leads";
import { Layout } from "./layout";
import { viewsClass } from "./ui";

export const REPORT_PERIODS = [7, 30, 90, 365] as const;
const label = (d: number) => (d === 365 ? "1 year" : `${d} days`);

export function ReportsPage(p: { user: string; report: LeadReport; days: number; by: BreakdownBy }) {
  const { report: r } = p;
  const here = (o: { days?: number; by?: string }) => `/reports?days=${o.days ?? p.days}&by=${o.by ?? p.by}`;
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
        <LeadKpis report={r} />
        {r.total.spend_cents === 0 ? <AskAi ask="Each morning, read yesterday's ad costs from our ad account and save them for the lead report" /> : null}
        {r.otherCurrencies.length ? <p class="text-label text-ink-2">Ad cost in {r.otherCurrencies.join(", ").toUpperCase()} is left out: these figures are in {r.currency}.</p> : null}
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <LeadTrends report={r} />
          <LeadFunnel report={r} />
        </div>
        <LeadBreakdown report={r} by={p.by} href={(by) => here({ by })} />
      </div>
    </Layout>
  );
}
