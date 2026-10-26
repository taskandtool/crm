# Search Console, GA4 and the weekly SEO report

## The Google data

Through two connections, each on the gateway (`googleCall` in `seo.ts`):
`google-search-console` (endpoint `google-search-console`) and
`google-analytics` (endpoint `google-analytics-data`). Ask for whichever the
app does not hold with `python3 ~/tools/taskandtool.py request-connection
google-search-console --why "…"` (or `google-analytics`); on their own Google
Cloud app the owner also needs the Search Console and Analytics Data APIs
enabled.

`siteUrl` is the property exactly as Search Console names it
(`sc-domain:acme.com`, or `https://acme.com/` with the slash). GA4 takes the
numeric property id. A report page renders `loadSnapshot` of what a job
fetched and `saveSnapshot`ed, never Google itself: the figures are slow to
fetch and change daily. The figures that are easy to get wrong are in `seo.ts`'s
header; `fetchSeo` and `SeoReport` keep them.

## The weekly SEO report for a client

1. Hold both connections; note the client's Search Console property
   and GA4 property id in the app's settings.
2. `scripts/seo-report.tsx`: `fetchSeo(googleCall(process.env), { siteUrl,
   ga4Property, period: lastFull("week", 1, zone, { lag: 3 }) })`, render
   `<ReportDocument><SeoReport data notes /></ReportDocument>`, `printToPdf`
   to `out/seo-<to>.pdf`, and print the path. Where the app has a database
   (the Website, the CRM), also `saveSnapshot(db, "seo", data)` for step 4.
   The deliverable needs no database: Marketing makes this report with no
   database at all.
3. Schedule it as a prompt job on a weekday from Thursday, when last week is
   final: the job runs the script, writes two or three sentences of notes
   from the figures (what moved, and the likely reason), re-renders with
   them, and makes the deliverable. Notes need judgment; the numbers do not.
4. With a database, `/reports/seo` renders `loadSnapshot(db, "seo")` for
   the team in between.
