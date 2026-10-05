---
name: reports
description: "Charts and report pages over the project's tables and the Google connection: KPI tiles, trends, funnels, the operations and SEO reports, branded from the theme, under /reports, and handed over as a PDF deliverable on a schedule. Use for any chart, dashboard or report. Not for lists of rows (admin)."
---

# Reports

Report pages are private views (`admin`) with charts in them. The figures
are computed on the server, in SQL or from Google's rows; the browser only
draws them.

Version: 0.1.0 (taskandtool/skills)

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
  `partially_refunded` and `refunded` payments placed by `paid_at` (else
  `created_at`: a refund handled first can leave `paid_at` empty), leaving
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

## Search Console and GA4

Through the `google` connection: endpoints `google-gsc` and `google-ga4` on
the gateway (`googleCall` in `seo.ts`). If the app does not hold it, ask with
`request_connection("google", why=…, auth="oauth")`; the owner also needs
the Search Console and Analytics Data APIs enabled on their Google Cloud
project.

- **Data lags two to three days**: end the period three days back
  (`lastFull("day", 28, zone, { lag: 3 })`), and say so on the page. A
  day still unfinished is not zero: `fetchSeo` sets `gsc.incompleteFrom`
  and `SeoReport` says the figures are partial.
- **Lower average position is better**: its tile takes `lowerIsBetter`, its
  chart `reverse`. A day with no impressions has no position (null), never
  0.
- **Totals come from rows by date**, never from top-query rows, which leave
  out anonymised queries. Position is weighted by impressions.
- `siteUrl` is the property exactly as Search Console names it
  (`sc-domain:acme.com`, or `https://acme.com/` with the slash), encoded in
  the path. GA4 takes the numeric property id; `keyEvents` is what GA4 now
  calls conversions; totals use `metricAggregations: ["TOTAL"]`.
- **The gateway answers only dev.** A report served in production cannot
  reach Google: a job on the machine fetches and
  `saveSnapshot`s, and the page renders `loadSnapshot`. The snapshot table
  is made once by `createSnapshotTable(db)` in the app's setup script.

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
| `seo.ts` | `googleCall`, `fetchSeo`, snapshots (`createSnapshotTable` at setup). Machine only for the fetch |
| `seo-report.tsx` | `SeoReport` and `Notes` |
| `print.ts` | `printToPdf`, `findChrome`, `fileUrl`. Machine only |
| `test/` | copy with the files and keep green |

Copy the folder whole, `client.js` included (its test reads it from
there), and serve `client.js` as a static file too. `ops.tsx` imports `seo-report.tsx`, which
imports `seo.ts`, so keep those even without Google. `print.ts` is machine
only: leave it and `test/seo.test.ts` out of an app that deploys `src/` to
Cloudflare until a PDF is wanted.

## Add a report to this app

```tsx
import { Hono } from "hono";
import { teamOnly, type TeamVars } from "../admin/guard";
import { AdminLayout } from "../admin/layout";
import { ChartScripts } from "./charts";
import { loadOps, OpsReport } from "./ops";
import { lastFull } from "./sql";

const reports = new Hono<{ Variables: TeamVars }>();
reports.use("*", teamOnly());
reports.get("/", async (c) => {
  const zone = "America/New_York"; // the business's zone, from the app's settings, never the server's
  const data = await loadOps(getDb(c), { period: lastFull("week", 12, zone), grain: "week", zone });
  return c.html(
    <AdminLayout title="Operations" css="/site.css" nav={NAV} current="/reports" user={c.get("user")} head={<ChartScripts src="/reports.js" />}>
      <OpsReport data={data} />
    </AdminLayout>,
  );
});
app.route("/reports", reports);
```

A period to date ("this quarter", "this month") is `{ from: <first day>,
to: todayIn(zone) }`; its first and last weeks are partial, so say so on
the page. `lastFull` covers whole periods only.

A new chart over another table: add its entry to `SOURCES`, then
`run(db, seriesQuery(name, period, grain, zone))` and
`compareQuery(...)`, and pass the rows to `LineChart` or `BarChart` with
`bucketLabel` labels.

## The weekly SEO report for a client

1. Hold the `google` connection; note the client's Search Console property
   and GA4 property id in the app's settings.
2. `scripts/seo-report.tsx`: `fetchSeo(googleCall(process.env), { siteUrl,
   ga4Property, period: lastFull("week", 1, zone, { lag: 3 }) })`, render
   `<ReportDocument><SeoReport data notes /></ReportDocument>`, `printToPdf`
   to `out/seo-<to>.pdf`, and print the path. Where the app has a database
   (the Website, the CRM), also `saveSnapshot(db, "seo", data)` for step 4.
   The deliverable needs none: Marketing makes this report with no
   database at all.
3. Schedule it as a prompt job on a weekday from Thursday, when last week is
   final: the job runs the script, writes two or three sentences of notes
   from the figures (what moved, and the likely reason), re-renders with
   them, and makes the deliverable. Notes need judgment; the numbers do not.
4. With a database, `/reports/seo` renders `loadSnapshot(db, "seo")` for
   the team in between.
