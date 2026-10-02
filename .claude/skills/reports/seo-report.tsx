// The SEO report: Search Console's clicks, impressions, CTR and average
// position against the previous period, the trend, top queries and pages,
// GA4's organic sessions and key events, and notes. Renders saved figures
// (seo.ts), so it runs on the machine and at the edge alike.
//
//   import { SeoReport } from "./seo-report";
//   const snap = await loadSnapshot<SeoData>(db, "seo");
//   return c.html(
//     <AdminLayout title="SEO report" css="/site.css" nav={NAV} current="/reports/seo" user={c.get("user")} head={<ChartScripts src="/reports.js" />}>
//       {snap ? <SeoReport data={snap.data} notes={notes} /> : <p>No figures yet.</p>}
//     </AdminLayout>,
//   );
import { DataTable, type TableSpec } from "../admin/list";
import { bucketLabel, formatNumber, KpiRow, KpiTile, LineChart, ReportSection } from "./charts";
import type { SeoData, TopRow } from "./seo";
import { days, type Period } from "./sql";

const dateText = (d: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(d + "T00:00:00Z"));

export const periodText = (p: Period, locale = "en-US") => `${dateText(p.from, locale)} to ${dateText(p.to, locale)}`;

type Ranked = TopRow & { id: number };

function topTable(id: string, first: string, caption: string, rows: TopRow[], locale: string) {
  const spec: TableSpec<Ranked> = {
    id,
    columns: [
      { label: first, cell: (r) => r.key, class: "break-all" },
      { label: "Clicks", cell: (r) => formatNumber(r.clicks, {}, locale), class: "text-right tabular-nums" },
      { label: "Impressions", cell: (r) => formatNumber(r.impressions, {}, locale), class: "text-right tabular-nums" },
      { label: "CTR", cell: (r) => formatNumber(r.ctr, { style: "percent" }, locale), class: "text-right tabular-nums" },
      { label: "Position", cell: (r) => formatNumber(r.position, { digits: 1 }, locale), class: "text-right tabular-nums" },
    ],
  };
  return <DataTable spec={spec} caption={caption} rows={rows.map((r, i) => ({ ...r, id: i + 1 }))} next={null} more={() => ""} empty="No rows for this period." />;
}

/** Notes are plain text the team (or the AI) writes for the reader; blank lines separate paragraphs. */
export function Notes(props: { text?: string | null }) {
  const paras = (props.text ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return null;
  return (
    <div class="max-w-prose space-y-3 rounded-card border border-line bg-surface p-4">
      {paras.map((p) => (
        <p>{p}</p>
      ))}
    </div>
  );
}

export function SeoReport(props: { data: SeoData; notes?: string | null; locale?: string }) {
  const { data, locale = "en-US" } = props;
  const { gsc, ga4 } = data;
  const against = `the previous ${days(data.period)} days`;
  const labels = gsc.days.map((d) => bucketLabel(d.date, "day", locale));
  return (
    <>
      <p class="text-label text-ink-3">
        {data.siteUrl}, {periodText(data.period, locale)}, compared with {periodText(data.previous, locale)}. Search Console figures take two to
        three days to settle, so the period ends a few days ago.
      </p>

      {gsc.incompleteFrom ? (
        <p class="mt-2 text-label font-semibold text-ink">
          Search Console had not finished counting from {dateText(gsc.incompleteFrom, locale)}, so search figures from then on are partial and
          will rise.
        </p>
      ) : null}

      {props.notes ? (
        <ReportSection title="Notes">
          <Notes text={props.notes} />
        </ReportSection>
      ) : null}

      <ReportSection title="Search">
        <KpiRow label="Search totals">
          <KpiTile label="Clicks" value={gsc.current.clicks} previous={gsc.previous.clicks} against={against} locale={locale} />
          <KpiTile label="Impressions" value={gsc.current.impressions} previous={gsc.previous.impressions} format={{ compact: true }} against={against} locale={locale} />
          <KpiTile label="CTR" value={gsc.current.ctr} previous={gsc.previous.ctr} format={{ style: "percent" }} change="points" against={against} locale={locale} />
          <KpiTile label="Average position" value={gsc.current.position} previous={gsc.previous.position} format={{ digits: 1 }} change="absolute" lowerIsBetter against={against} locale={locale} />
        </KpiRow>
        <LineChart
          title="Clicks per day"
          labels={labels}
          series={[
            { label: "This period", data: gsc.days.map((d) => d.clicks) },
            { label: "Previous period", data: gsc.previousDays.map((d) => d.clicks), previous: true },
          ]}
          locale={locale}
        />
        <LineChart
          title="Average position per day"
          labels={labels}
          series={[
            { label: "This period", data: gsc.days.map((d) => d.position) },
            { label: "Previous period", data: gsc.previousDays.map((d) => d.position), previous: true },
          ]}
          format={{ digits: 1 }}
          reverse
          locale={locale}
        />
      </ReportSection>

      <ReportSection title="Top queries" note="Search Console leaves out rare queries to protect searchers' privacy, so these add up to less than the totals.">
        {topTable("seo-queries", "Query", "Top queries", gsc.queries, locale)}
      </ReportSection>

      <ReportSection title="Top pages">{topTable("seo-pages", "Page", "Top pages", gsc.pages, locale)}</ReportSection>

      {ga4 ? (
        <ReportSection title="Organic visits" note="Google Analytics sessions from organic search, and the key events (conversions) in them.">
          <KpiRow label="Organic visit totals">
            <KpiTile label="Organic sessions" value={ga4.current.sessions} previous={ga4.previous.sessions} against={against} locale={locale} />
            <KpiTile label="Key events" value={ga4.current.keyEvents} previous={ga4.previous.keyEvents} against={against} locale={locale} />
            <KpiTile
              label="Key events per session"
              value={ga4.current.sessions ? ga4.current.keyEvents / ga4.current.sessions : null}
              previous={ga4.previous.sessions ? ga4.previous.keyEvents / ga4.previous.sessions : null}
              format={{ style: "percent" }}
              change="points"
              against={against}
              locale={locale}
            />
          </KpiRow>
          <LineChart
            title="Organic sessions per day"
            labels={ga4.days.map((d) => bucketLabel(d.date, "day", locale))}
            series={[
              { label: "This period", data: ga4.days.map((d) => d.sessions) },
              { label: "Previous period", data: ga4.previousDays.map((d) => d.sessions), previous: true },
            ]}
            locale={locale}
          />
          <DataTable
            spec={{
              id: "seo-landing",
              columns: [
                { label: "Landing page", cell: (r) => r.page, class: "break-all" },
                { label: "Sessions", cell: (r) => formatNumber(r.sessions, {}, locale), class: "text-right tabular-nums" },
                { label: "Key events", cell: (r) => formatNumber(r.keyEvents, {}, locale), class: "text-right tabular-nums" },
              ],
            }}
            caption="Top landing pages from organic search"
            rows={ga4.landingPages.map((r, i) => ({ ...r, id: i + 1 }))}
            next={null}
            more={() => ""}
            empty="No organic sessions in this period."
          />
        </ReportSection>
      ) : null}
    </>
  );
}
