---
name: reports
description: "Builds charts and report pages from the project's tables and the Google connection: KPI tiles, trends, funnels, the operations and SEO reports, branded from the theme, under /reports, and handed over as a PDF deliverable on a schedule. Use for any chart, dashboard or report. Not for lists of rows (admin)."
---

# Reports

Report pages are private views (`admin`) with charts in them. The figures
are computed on the server, in SQL or from Google's rows; the browser only
draws them.

## Figures that are easy to get wrong

- **Bucket in the business's zone, in SQL**: `date_trunc('week', created_at
  at time zone $zone)`. Periods are local dates and become instants only in
  SQL (`sql.ts`). A day bucket on the fall-back day holds 25 hours, and a
  week runs Monday to Sunday locally. Never bucket in JavaScript or in UTC.
- **Quiet periods are zero**: fill every bucket with `generate_series`.
  Otherwise the chart draws a straight line over an empty week.
- **Compare equal periods**: the previous period is the same number of
  days (whole months for a month grain only), ending the day before
  (`previousPeriod(p, grain)`). Its points line up with this period's by
  position.
- **Ratios from totals**: CTR is total clicks over total impressions; a
  conversion rate is total conversions over total sessions. Never average
  per-row ratios (`ratioOfSums`, `weightedMean`). Show a change in a rate in
  percentage points (`change="points"`).
- **Money**: one figure per currency, never a sum across currencies;
  revenue is `revenueQuery` (net of refunds, live only, dated by when it was
  paid). Minor units through `fromMinor`, never `/ 100`.
- **People are emails**: the funnel matches across tables on
  `lower(email::text)` within the period, and each step is a subset of the
  one before.
- **Where leads came from is the visit, not the app.** `submissions.source`
  is the app that took the form; an owner asking about sources means the
  UTM source the forms skill stored, else the referring host, else direct
  (`leadsByOriginQuery`).
- **A table may not exist yet** (no bookings, no payments):
  `projectTables(db)` checks `information_schema`. For a missing table,
  show one sentence in that section instead of failing the page.
- **Table and column names never come from input.** A query over another
  table is a new entry in `SOURCES` (`sql.ts`): its names are string
  literals there, values are always `$n`. Composed statements run with
  `run(db, query)`.

## The lead report

`leads.tsx` holds parts to lay out: `loadLeadReport`, then `LeadReportBody` for
the whole page, or `LeadKpis`, `LeadTrends`, `LeadFunnel`, `LeadBreakdown`.
Change a business's report by choosing and arranging them, or by adding a
component beside them. Ad cost and a lead's status from another system
come from a daily job:
`references/daily-numbers.md`.

## Where reports go

- **Under `/reports`, behind `teamOnly()`**, in `AdminLayout` with
  `head={<ChartScripts src="/reports.js" />}`. Copy `client.js` to where the
  app serves static files, at the path you pass as `src`. Show tables of
  rows (top queries, recent bookings) with admin's `DataTable` to match
  every other private view.
- **Chart.js 4.5.1, the UMD build from cdnjs** (`CHARTJS_SRC`, with its
  integrity hash). No date adapter: the server sends bucket labels as text.

## Branding

A canvas cannot use CSS classes. `client.js` reads the theme's custom
properties at draw time (`--color-accent` for the series, `--color-ink-3`
for the previous period, `--color-line` for gridlines, `--font-body`) and
again when the theme changes. An app whose `brand/` folder is filled already
has its theme set from it: its reports are in that brand. Put no colours in
chart code.

Tailwind 4 writes out only the theme variables some class uses.
`client.js` uses extra series colours (`--color-chart-2` … `-6`) when they
exist. They reach the page only with `@theme static` or a class that uses
them.

## In the page

- **Chart data is a JSON `<script>` with `<` escaped** (`jsonForScript`),
  put in through `dangerouslySetInnerHTML`. JSX text escaping does not work
  inside a script element, and an unescaped `</script>` in a label ends it.
- **htmx**: `client.js` destroys a chart when htmx cleans up its canvas and
  draws charts in new content on `htmx:load`. A partial that returns a chart
  needs nothing more. Chart.js needs the canvas alone in a sized box
  (`box`, default `h-64`).

## Handing a report to someone

Schedule the report as a job (the `schedule-job` skill), at an hour that
is right in the business's zone on both sides of a clock change. Hand it
over as a deliverable (the `work` skill). A deliverable is a file:

1. Render the report into `ReportDocument` (no private navigation,
   stylesheet and script by `fileUrl`) and `printToPdf` it (`print.ts`). It
   uses the browser that `tt-crawl setup` installs. The browser needs no
   sign-in: the job renders the page itself.
2. `python3 ~/tools/taskandtool.py create-deliverables --file -` with `[{"path": pdf, "title": …, "status": "info"}]` on stdin (the `work` skill).
3. With no browser, the deliverable is a link to the private report page
   instead: say which in the chat.

## Files

| File | What it is |
|---|---|
| `sql.ts` | periods, zone bucketing with zero fill, comparison totals, ratio helpers, the operations queries; tested |
| `charts.tsx` | `ChartScripts`, `KpiRow`/`KpiTile`, `LineChart`, `BarChart`, `FunnelChart`, `ReportSection`, `ReportDocument`, number formats |
| `client.js` | the browser side: tokens, drawing, htmx, theme changes, print; the data contract is at its top |
| `ops.tsx` | `loadOps` and `OpsReport`: leads (by where they came from, by form), bookings, revenue, the funnel |
| `seo.ts` | `googleCall`, `fetchSeo`, `saveSnapshot`, `loadSnapshot`. A job fetches; a page reads the snapshot |
| `schema.sql` | `report_snapshots`, the SEO figures a job saved; `ad_spend`, what ads cost |
| `leads.tsx` | `loadLeadReport`, `reportQuery`, `LeadReportBody`, `ReportPeriods`, `LeadKpis`, `LeadTrends`, `LeadFunnel`, `LeadBreakdown`, `breakdown`, `costPerLead` |
| `ad-spend.ts` | `saveAdSpend`: what a daily job saves |
| `cli.ts` | `reportsCli`: `reports.mjs` summary, spend, outcome |
| `seo-report.tsx` | `SeoReport` and `Notes` |
| `print.ts` | `printToPdf`, `findChrome`, `fileUrl`. Machine only |
| `test/` | copy with the files and keep green |

Copy `client.js` with `charts.tsx` (the charts test reads `client.js`
from beside it). `ops.tsx` imports `seo-report.tsx`, and `seo-report.tsx`
imports `seo.ts`. Keep those even without Google.

## More, when the request needs it

- A new report page or chart over a table: [references/add-a-report.md](references/add-a-report.md).
- Search Console, GA4, or the weekly SEO report for a client: [references/seo.md](references/seo.md).
