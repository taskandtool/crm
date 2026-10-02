import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { bucketLabel, formatNumber, fromMinor, jsonForScript, KpiTile, kpiChange, LineChart, FunnelChart } from "../charts";

const html = async (node: unknown) => String(await (node as { toString(): string | Promise<string> }).toString());

test("JSON in a script tag cannot end the tag, and parses back unchanged", async () => {
  const evil = "</script><script>alert(1)</script>";
  const out = await html(LineChart({ title: "Leads", labels: [evil, "b"], series: [{ label: "x y", data: [1, null] }] }));
  assert.equal(out.includes("</script><script>alert"), false);
  const json = out.match(/<script type="application\/json" data-chart[^>]*>([\s\S]*?)<\/script>/)![1];
  const spec = JSON.parse(json);
  assert.equal(spec.labels[0], evil);
  assert.equal(spec.series[0].label, "x y");
  assert.deepEqual(spec.series[0].data, [1, null]);
  assert.equal(jsonForScript({ a: "<!--" }), '{"a":"\\u003c!--"}');
  // the canvas has a text alternative and the data is in a table
  assert.match(out, /<canvas role="img" aria-label="Line chart of Leads[^"]*"/);
  assert.match(out, /<summary[^>]*>View data<\/summary>/);
  assert.match(out, /&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("lower is better turns a fall into an improvement", async () => {
  assert.deepEqual(kpiChange(4.2, 6, "absolute", true), { delta: 4.2 - 6, direction: "down", trend: "good" });
  assert.equal(kpiChange(7, 6, "absolute", true).trend, "bad");
  assert.equal(kpiChange(90, 100, "percent").trend, "bad");
  assert.equal(kpiChange(5, 0, "percent").delta, null);
  assert.equal(kpiChange(5, 0, "percent").direction, "up");
  assert.equal(kpiChange(0, 0, "percent").trend, "flat");
  assert.equal(kpiChange(5, null).trend, "none");
  assert.ok(Math.abs((kpiChange(0.025, 0.021, "points").delta as number) - 0.4) < 1e-9);

  const pos = await html(KpiTile({ label: "Average position", value: 4.2, previous: 6, change: "absolute", lowerIsBetter: true, format: { digits: 1 } }));
  assert.match(pos, /data-trend="good"/);
  assert.match(pos, /class="[^"]*text-accent/);
  assert.match(pos, /▼ 1\.8 \(lower is better\)/);
  assert.match(pos, /Average position 4\.2, down 1\.8 on the previous period, better\./);

  // a change smaller than the digits shown is no change, not "down 0, better"
  assert.equal(kpiChange(7.02, 7.04, "absolute", true, 1).direction, "flat");
  assert.equal(kpiChange(7.0, 7.1, "absolute", true, 1).direction, "down");
  const tiny = await html(KpiTile({ label: "Average position", value: 7.02, previous: 7.04, change: "absolute", lowerIsBetter: true, format: { digits: 1 } }));
  assert.match(tiny, /data-trend="flat"/);
  assert.doesNotMatch(tiny, /down 0/);

  const clicks = await html(KpiTile({ label: "Clicks", value: 900, previous: 1000 }));
  assert.match(clicks, /data-trend="bad"/);
  assert.match(clicks, /▼ 10%/);
  assert.match(clicks, /down 10% on the previous period, worse/);
});

test("numbers format by style, and minor units follow the currency", () => {
  assert.equal(formatNumber(1234567, { compact: true }), "1.2M");
  assert.equal(formatNumber(0.0345, { style: "percent" }), "3.5%");
  assert.equal(formatNumber(fromMinor(199900, "USD"), { style: "currency", currency: "USD" }), "$1,999.00");
  assert.equal(fromMinor(1999, "JPY"), 1999);
  // Stripe's minor units, not Intl's: ISK is in hundredths at Stripe though Intl gives it none
  assert.equal(fromMinor(10000, "ISK"), 100);
  assert.equal(fromMinor(10000, "isk"), 100);
  assert.equal(fromMinor(1999, "KWD"), 1.999);
  assert.equal(fromMinor(5000, "UGX"), 5000);
  assert.equal(fromMinor(150000, "HUF"), 1500);
  assert.equal(formatNumber(null), "–");
});

test("a bucket's date is the same calendar day in any zone", () => {
  assert.equal(bucketLabel("2026-11-01", "day"), "Nov 1");
  assert.equal(bucketLabel("2026-10-26", "week"), "Week of Oct 26");
  assert.equal(bucketLabel("2026-10-01", "month"), "Oct 2026");
});

test("a funnel's table gives each step's share of the one before", async () => {
  const out = await html(FunnelChart({ title: "Lead to paid", steps: [{ label: "Leads", value: 40 }, { label: "Booked", value: 10 }, { label: "Paid", value: 5 }] }));
  assert.match(out, /Booked 10 \(25% of Leads\), Paid 5 \(50% of Booked\)/);
  assert.match(out, /"kind":"funnel"/);
});

test("client.js maps the theme's tokens and a reversed axis into the Chart.js config", () => {
  const ctx: Record<string, any> = { Intl };
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), ctx);
  const t = { accent: "rgb(1, 2, 3)", ink: "rgb(0, 0, 0)", ink2: "rgb(4, 4, 4)", ink3: "rgb(9, 9, 9)", line: "rgba(0, 0, 0, 0.1)", canvas: "rgb(255, 255, 255)", font: "Inter", chart: [] };
  const spec = {
    kind: "line",
    labels: ["a", "b"],
    series: [
      { label: "This period", data: [3, 1] },
      { label: "Previous period", data: [4, null], previous: true },
    ],
    format: { digits: 1 },
    reverse: true,
  };
  const c = ctx.ReportCharts.config(spec, t, { animate: false, print: false });
  assert.equal(c.type, "line");
  assert.equal(c.options.animation, false);
  assert.equal(c.data.datasets[0].borderColor, "rgb(1, 2, 3)");
  assert.equal(c.data.datasets[1].borderColor, "rgb(9, 9, 9)");
  assert.deepEqual([...c.data.datasets[1].borderDash], [4, 4]);
  assert.equal(c.options.scales.y.reverse, true);
  assert.equal(c.options.scales.y.beginAtZero, false);
  assert.equal(c.options.scales.y.grid.color, "rgba(0, 0, 0, 0.1)");
  assert.equal(c.options.scales.y.ticks.callback(8.25), "8.3");
  const f = ctx.ReportCharts.config({ kind: "funnel", labels: ["x"], series: [{ label: "People", data: [1] }] }, t, { animate: true, print: false });
  assert.equal(f.type, "bar");
  assert.equal(f.options.indexAxis, "y");
  assert.equal(f.options.scales.x.beginAtZero, true);
});
