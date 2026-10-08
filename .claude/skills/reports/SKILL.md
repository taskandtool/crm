---
name: reports
description: "Charts and report pages over the project's tables and the Google connection: KPI tiles, trends, funnels, the operations and SEO reports, branded from the theme, under /reports, and handed over as a PDF deliverable on a schedule. Use for any chart, dashboard or report. Not for lists of rows (admin)."
---

# Reports

Report pages are private views (`admin`) with charts in them. The figures
are computed on the server, in SQL or from Google's rows; the browser only
draws them.

Version: 0.2.1 (taskandtool/skills)

## Figures that go wrong quietly

- **Bucket in the business's zone, in SQL**: `date_trunc('week', created_at
  at time zone $zone)`. Periods are local dates and become instants only in
  SQL (`sql.ts`); a day bucket on the fall-back day holds 25 hours and a
  week is Monday to Sunday locally. Never bucket in JavaScript or in UTC.
- **Quiet periods are zero**: `generate_series` fills every bucket, or the
  chart draws a line straight over an empty week.
- **Compare equal periods**: the previous period is the same number of
  days (whole months for a month grain only), ending the day before
  (`previousPeriod(p, grain)`). Its points line up with this period's by position.
- **Ratios from totals**: CTR is total clicks over total impressions; a
  conversion rate is total conversions over total sessions. Never average
  per-row ratios (`ratioOfSums`, `weightedMean`). Show a change in a rate in
  percentage points (`change="points"`).
- **Money**: one figure per currency, never a sum across currencies.
  Revenue is `amount_cents - refunded_cents` for `paid`,
  `partially_refunded` and `refunded` payments, dated by `paid_at` (or by
  `created_at` when a refund handled first left `paid_at` empty), leaving
  out `livemode = false`. Minor units are Stripe's, not Intl's (`fromMinor`: yen
  have none, ISK counts hundredths).
- **People are emails**: the funnel matches across tables on
  `lower(email::text)` within the period, and each step narrows the one
  before.
- **Where leads came from is the visit, not the app.** `submissions.source`
  is the app that took the form; an owner asking about sources means the
  UTM source the forms skill stored, else the referring host, else direct
  (`leadsByOriginQuery`).
- **A table may not exist yet** (no bookings, no payments):
  `projectTables(db)` checks `information_schema`, and the section says so
  in a sentence instead of failing the page.
- **Identifiers are never parameters or input.** A query over another table
  is a new entry in `SOURCES` (`sql.ts`): table and column names are string
  literals there, values are always `$n`. Composed statements run with
  `run(db, query)`.

## Where reports live

- **Under `/reports`, behind `teamOnly()`**, in `AdminLayout` with
  `head={<ChartScripts src="/reports.js" />}`. Copy `client.js` to where the
  app serves static files, at the path you pass as `src`. Tables of rows
  (top queries, recent bookings) are admin's `DataTable`, so they match
  every other private view.
- **Chart.js 4.5.1, the UMD build from cdnjs** (`CHARTJS_SRC`, with its
  integrity hash). No date adapter: the server sends bucket labels as text.

## Branding

A canvas cannot use CSS classes, so `client.js` reads the theme's custom
properties at draw time (`--color-accent` for the series, `--color-ink-3`
for the previous period, `--color-line` for gridlines, `--font-body`) and
reads them again when the theme changes. An app whose `brand/` folder is
filled already has its theme set from it, so a report for a client is
branded by that and nothing else: no colours in chart code, ever.

Tailwind 4 writes out only the theme variables some class uses. Extra
series colours (`--color-chart-2` … `-6`, which `client.js` uses when they
exist) need `@theme static`, or a class that uses them, to reach the page.

## In the page

- **Chart data is a JSON `<script>` with `<` escaped** (`jsonForScript`),
  put in through `dangerouslySetInnerHTML`. JSX text escaping does not work
  inside a script element, and an unescaped `</script>` in a label ends it.
- **htmx**: `client.js` destroys a chart when htmx cleans up its canvas and
  draws charts in new content on `htmx:load`. A partial that returns a chart
  needs nothing more. Chart.js needs the canvas alone in a sized box
  (`box`, default `h-64`).

## Handing a report to someone

A schedule is a job (`schedule-job` skill; cron is in UTC, so pick an hour
that is right in the business's zone either side of a clock change). The
hand-over is a deliverable (`work` skill), and a deliverable is a file:

1. Render the report into `ReportDocument` (no private navigation,
   stylesheet and script by `fileUrl`) and `printToPdf` it (`print.ts`).
   That uses the browser the crawler installs (`tt-crawl setup`). The job
   renders the page itself, so the browser needs no sign-in.
2. `create_deliverables([{"path": pdf, "title": …, "status": "info"}], …)`.
3. With no browser, the deliverable is a link to the private report page
   instead: say which in the chat.

## Files

| File | What it is |
|---|---|
| `sql.ts` | periods, zone bucketing with zero fill, comparison totals, ratio helpers, the operations queries; tested |
| `charts.tsx` | `ChartScripts`, `KpiRow`/`KpiTile`, `LineChart`, `BarChart`, `FunnelChart`, `ReportSection`, `ReportDocument`, number formats |
| `client.js` | the browser side: tokens, drawing, htmx, theme changes, print; the data contract is at its top |
| `ops.tsx` | `loadOps` and `OpsReport`: leads (by where they came from, by form), bookings, revenue, the funnel |
| `seo.ts` | `googleCall`, `fetchSeo`, `saveSnapshot`, `loadSnapshot`. Machine only for the fetch |
| `schema.sql` | `report_snapshots`, the SEO figures a job saved |
| `seo-report.tsx` | `SeoReport` and `Notes` |
| `print.ts` | `printToPdf`, `findChrome`, `fileUrl`. Machine only |
| `test/` | copy with the files and keep green |

Copy `client.js` with `charts.tsx` (the charts test reads `client.js`
from beside it), and serve `client.js` as a static file too. `ops.tsx` imports `seo-report.tsx`, which
imports `seo.ts`, so keep those even without Google. `print.ts` is machine
only: leave it and `test/seo.test.ts` out of an app that deploys `src/` to
Cloudflare until a PDF is wanted.

## More, when the request needs it

- A new report page or chart over a table: [references/add-a-report.md](references/add-a-report.md).
- Search Console, GA4, or the weekly SEO report for a client: [references/seo.md](references/seo.md).
