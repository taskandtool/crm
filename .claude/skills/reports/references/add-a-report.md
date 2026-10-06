# Add a report to an app

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
`bucketLabel` labels. A money source names its `currency` column and is
charted one currency at a time: `seriesQuery("invoices_paid", p, "month",
zone, "usd")`, one series per currency in `select distinct currency`.
