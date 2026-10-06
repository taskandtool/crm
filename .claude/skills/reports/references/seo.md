# Search Console, GA4 and the weekly SEO report

## The Google data

Through the `google` connection: endpoints `google-gsc` and `google-ga4` on
the gateway (`googleCall` in `seo.ts`). If the app does not hold it, ask with
`python3 ~/tools/taskandtool.py request-connection google --why "…"`; the owner also needs
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
  is this skill's `schema.sql`, applied at setup.

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
