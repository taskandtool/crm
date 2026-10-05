// The operations report, from the project's tables: leads, bookings, revenue
// per currency, the funnel lead, booked, showed, paid (matched by email),
// bookings per week, leads by where they came from and by form, and the
// latest bookings. A table the
// project does not have yet (no bookings, no payments) leaves its section
// out with a plain note; the rest still renders.
//
//   const zone = "America/New_York";                      // the business's zone, from the app's settings
//   const data = await loadOps(db, { period: lastFull("week", 12, zone), grain: "week", zone });
//   return c.html(
//     <AdminLayout title="Operations" css="/site.css" nav={NAV} current="/reports/ops" user={c.get("user")} head={<ChartScripts src="/reports.js" />}>
//       <OpsReport data={data} />
//     </AdminLayout>,
//   );
import type { Db } from "../data/db";
import { DataTable, When } from "../admin/list";
import { BarChart, bucketLabel, fromMinor, FunnelChart, KpiRow, KpiTile, LineChart, ReportSection } from "./charts";
import { periodText } from "./seo-report";
import {
  compareQuery,
  days,
  funnelQuery,
  leadsByFormQuery,
  leadsByOriginQuery,
  previousPeriod,
  recentBookingsQuery,
  revenueQuery,
  run,
  seriesQuery,
  projectTables,
  type Grain,
  type Period,
  type ProjectTables,
} from "./sql";

export type Revenue = { currency: string; gross: number; refunds: number; net: number; previous_net: number };
type Point = { bucket: string; value: number };
type Compared = { current: number; previous: number; series: Point[]; previousSeries: Point[] };

export type OpsData = {
  period: Period;
  previous: Period;
  grain: Grain;
  zone: string;
  tables: ProjectTables;
  leads: (Compared & { byOrigin: { origin: string; leads: number }[]; byForm: { form: string; leads: number }[] }) | null;
  bookings: (Compared & { recent: { id: string; name: string | null; email: string; status: string; starts_at: string }[] }) | null;
  revenue: Revenue[] | null;
  funnel: { step: string; people: number }[] | null;
};

async function compared(db: Db, name: "leads" | "bookings", p: Period, prev: Period, grain: Grain, zone: string): Promise<Compared> {
  const [[totals], series, previousSeries] = await Promise.all([
    run<{ current: number; previous: number }>(db, compareQuery(name, p, zone, prev)),
    run<Point>(db, seriesQuery(name, p, grain, zone)),
    run<Point>(db, seriesQuery(name, prev, grain, zone)),
  ]);
  return { current: totals.current, previous: totals.previous, series, previousSeries };
}

export async function loadOps(db: Db, opts: { period: Period; grain: Grain; zone: string; previous?: Period }): Promise<OpsData> {
  const { period, grain, zone } = opts;
  const previous = opts.previous ?? previousPeriod(period, grain);
  const tables = await projectTables(db);
  const funnel = funnelQuery(period, zone, tables);
  const [leads, byOrigin, byForm, bookings, recent, revenue, steps] = await Promise.all([
    tables.submissions ? compared(db, "leads", period, previous, grain, zone) : null,
    tables.submissions ? run<{ origin: string; leads: number }>(db, leadsByOriginQuery(period, zone)) : null,
    tables.submissions ? run<{ form: string; leads: number }>(db, leadsByFormQuery(period, zone, tables)) : null,
    tables.bookings ? compared(db, "bookings", period, previous, grain, zone) : null,
    tables.bookings ? run<{ id: string; name: string | null; email: string; status: string; starts_at: string }>(db, recentBookingsQuery()) : null,
    tables.payments ? run<Revenue>(db, revenueQuery(period, zone, previous)) : null,
    funnel ? run<{ step: string; people: number }>(db, funnel) : null,
  ]);
  return {
    period,
    previous,
    grain,
    zone,
    tables,
    leads: leads && byOrigin && byForm ? { ...leads, byOrigin, byForm } : null,
    bookings: bookings && recent ? { ...bookings, recent } : null,
    revenue,
    funnel: steps,
  };
}

const STEP: Record<string, string> = { lead: "Leads", booked: "Booked", showed: "Showed", paid: "Paid" };
const missing = (what: string, app: string) => `This project has no ${what} yet, so there is nothing to show here. It fills in once ${app} is set up.`;

export function OpsReport(props: { data: OpsData; locale?: string }) {
  const { data, locale = "en-US" } = props;
  const { leads, bookings, revenue, funnel, grain } = data;
  const against = `the previous ${days(data.previous)} days`; // whole months can differ in length from this period
  const unit = grain === "day" ? "day" : grain === "week" ? "week" : "month";
  const trend = (c: Compared) => ({
    labels: c.series.map((p) => bucketLabel(p.bucket, grain, locale)),
    series: [
      { label: "This period", data: c.series.map((p) => p.value) },
      { label: "Previous period", data: c.previousSeries.map((p) => p.value), previous: true },
    ],
  });
  return (
    <>
      <p class="text-label text-ink-3">
        {periodText(data.period, locale)}, compared with {periodText(data.previous, locale)}. Days are counted in {data.zone}.
      </p>

      <ReportSection title="Leads" note={leads ? undefined : missing("form submissions", "a form")}>
        {leads ? (
          <>
            <KpiRow label="Leads">
              <KpiTile label="Leads" value={leads.current} previous={leads.previous} against={against} locale={locale} />
            </KpiRow>
            <LineChart title={`Leads per ${unit}`} {...trend(leads)} locale={locale} />
            <BarChart
              title="Leads by where they came from"
              labels={leads.byOrigin.map((r) => (r.origin === "direct" ? "Direct or unknown" : r.origin))}
              series={[{ label: "Leads", data: leads.byOrigin.map((r) => r.leads) }]}
              locale={locale}
            />
            {leads.byForm.length ? (
              <BarChart
                title="Leads by form"
                labels={leads.byForm.map((r) => r.form)}
                series={[{ label: "Leads", data: leads.byForm.map((r) => r.leads) }]}
                locale={locale}
              />
            ) : null}
          </>
        ) : null}
      </ReportSection>

      <ReportSection title="Bookings" note={bookings ? "Appointments held or due in the period; cancelled ones are left out." : missing("bookings", "booking")}>
        {bookings ? (
          <>
            <KpiRow label="Bookings">
              <KpiTile label="Bookings" value={bookings.current} previous={bookings.previous} against={against} locale={locale} />
            </KpiRow>
            <BarChart
              title={`Bookings per ${unit}`}
              {...trend(bookings)}
              locale={locale}
            />
            <DataTable
              spec={{
                id: "ops-recent",
                columns: [
                  { label: "Name", cell: (r) => r.name || r.email },
                  { label: "Email", cell: (r) => r.email, class: "break-all" },
                  { label: "When", cell: (r) => <When at={r.starts_at} timeZone={data.zone} locale={locale} /> },
                  { label: "Status", cell: (r) => r.status.replace("_", " ") },
                ],
              }}
              caption="The latest bookings made"
              rows={bookings.recent}
              next={null}
              more={() => ""}
              empty="No bookings yet."
            />
          </>
        ) : null}
      </ReportSection>

      <ReportSection
        title="Revenue"
        note={revenue ? "Payments taken in the period less what has been refunded of them. Each currency is its own figure." : missing("payments", "payments")}
      >
        {revenue ? (
          revenue.length ? (
            <KpiRow label="Revenue by currency">
              {revenue.map((r) => (
                <KpiTile
                  label={`Revenue, ${r.currency}`}
                  value={fromMinor(r.net, r.currency)}
                  previous={fromMinor(r.previous_net, r.currency)}
                  format={{ style: "currency", currency: r.currency }}
                  against={against}
                  locale={locale}
                />
              ))}
            </KpiRow>
          ) : (
            <p class="text-ink-2">No payments in this period.</p>
          )
        ) : null}
      </ReportSection>

      {funnel ? (
        <ReportSection
          title="From lead to paid"
          note={`People who became a lead in the period, matched by email, and how far they went in the same period.${data.tables.bookings ? "" : " There is no booking step: this project has no bookings yet."}`}
        >
          <FunnelChart title="Lead to paid" steps={funnel.map((s) => ({ label: STEP[s.step] ?? s.step, value: s.people }))} locale={locale} />
        </ReportSection>
      ) : null}
    </>
  );
}

