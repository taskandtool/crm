// The Reports page: the reports skill's lead report in this app's frame. To change the report, lay
// out its components here instead (.claude/skills/reports/SKILL.md).
import { LeadReportBody, ReportPeriods, type BreakdownBy, type LeadReport } from "../reports/leads";
import { Layout } from "./layout";

export function ReportsPage(p: { user: string; report: LeadReport; days: number; by: BreakdownBy }) {
  return (
    <Layout title="Reports" user={p.user} section="reports" wide actions={<ReportPeriods base="/reports" days={p.days} by={p.by} filter={p.report.filter} />}>
      <LeadReportBody report={p.report} base="/reports" scripts="/reports.js" days={p.days} by={p.by} />
    </Layout>
  );
}
