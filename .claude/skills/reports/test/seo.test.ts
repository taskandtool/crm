import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { fetchSeo, googleCall, gscTotals, loadSnapshot, saveSnapshot, type SeoData } from "../seo";
import { SeoReport } from "../seo-report";
import { chromeArgs, findChrome, printToPdf } from "../print";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { tmpdir } from "node:os";
import { join } from "node:path";

const period = { from: "2026-09-01", to: "2026-09-03" };

// A fake gateway: records each request and answers like Google does.
function fakeFetch() {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    const u = String(url);
    let json: unknown = {};
    if (u.includes("/google-gsc/")) {
      const dim = body.dimensions?.[0];
      if (dim === "date" && body.startDate === "2026-09-01")
        json = {
          rows: [
            { keys: ["2026-09-01"], clicks: 10, impressions: 1000, ctr: 0.01, position: 5 },
            // 2 Sep: no row at all (no impressions that day)
            { keys: ["2026-09-03"], clicks: 30, impressions: 1000, ctr: 0.03, position: 9 },
          ],
        };
      else if (dim === "date") json = { rows: [{ keys: ["2026-08-29"], clicks: 20, impressions: 4000, ctr: 0.005, position: 12 }] };
      else if (dim === "query") json = { rows: [{ keys: ["plumber near me"], clicks: 7, impressions: 70, ctr: 0.1, position: 3.2 }] };
      else json = {}; // pages: Google omits rows when there are none
    } else if (u.includes(":runReport")) {
      if (body.dimensions[0].name === "landingPage")
        json = { rows: [{ dimensionValues: [{ value: "/services" }], metricValues: [{ value: "12" }, { value: "2" }] }] };
      else
        json = {
          rows: [
            { dimensionValues: [{ value: body.dateRanges[0].startDate.replace(/-/g, "") }], metricValues: [{ value: "6" }, { value: "1" }] },
            { dimensionValues: [{ value: "20260902" }], metricValues: [{ value: "5" }, { value: "0" }] },
          ],
          totals: [{ metricValues: [{ value: "10" }, { value: "1" }] }], // a session across midnight is in two date rows
        };
    }
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

test("the SEO figures come through the gateway and their ratios from the totals", async () => {
  const f = fakeFetch();
  const call = googleCall({ PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt_1" }, f.impl);
  const data = await fetchSeo(call, { siteUrl: "sc-domain:acme.com", ga4Property: "properties/123", period, now: new Date("2026-09-07T00:00:00Z") });

  assert.equal(f.calls.length, 7);
  for (const c of f.calls) assert.equal(c.auth, "Bearer mt_1");
  assert.ok(f.calls.some((c) => c.url === "https://tt.example/api/machine/gateway/google-gsc/webmasters/v3/sites/sc-domain%3Aacme.com/searchAnalytics/query"));
  assert.ok(f.calls.some((c) => c.url === "https://tt.example/api/machine/gateway/google-ga4/v1beta/properties/123:runReport"));
  const prevCall = f.calls.find((c) => c.url.includes("google-gsc") && c.body.dimensions?.[0] === "date" && c.body.startDate !== period.from)!;
  assert.deepEqual([prevCall.body.startDate, prevCall.body.endDate], ["2026-08-29", "2026-08-31"]);

  const g = data.gsc;
  assert.deepEqual(g.current, { clicks: 40, impressions: 2000, ctr: 0.02, position: 7 });
  // averaging each day's CTR would say 0.02 here too, but over the days with rows only; the position is impression-weighted
  assert.deepEqual(
    g.days.map((d) => [d.date, d.clicks, d.position]),
    [
      ["2026-09-01", 10, 5],
      ["2026-09-02", 0, null],
      ["2026-09-03", 30, 9],
    ],
  );
  assert.equal(g.previous.position, 12);
  assert.equal(g.queries[0].ctr, 0.1);
  assert.deepEqual(g.pages, []);

  assert.deepEqual(data.ga4?.current, { sessions: 10, keyEvents: 1 });
  assert.deepEqual(data.ga4?.days.map((d) => d.sessions), [6, 5, 0]);
  assert.deepEqual(data.ga4?.landingPages, [{ page: "/services", sessions: 12, keyEvents: 2 }]);

  const out = String(await SeoReport({ data, notes: "Rankings rose after the new service pages.\n\nNext: reviews." }).toString());
  assert.match(out, /Average position 7, down 5 on the previous 3 days, better\./);
  assert.match(out, /plumber near me/);
  assert.match(out, /<p>Next: reviews\.<\/p>/);
});

test("a day Search Console has not finished is flagged, not charted as a quiet day", async () => {
  const f = fakeFetch();
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const res = await f.impl(url, init);
    const body = JSON.parse(String(init?.body));
    if (!String(url).includes("google-gsc") || body.dimensions?.[0] !== "date" || body.startDate !== period.from) return res;
    // Search Console sends 1 Sep and 3 Sep, but 3 Sep is still being counted
    return new Response(JSON.stringify({ ...(await res.json()), metadata: { firstIncompleteDate: "2026-09-03" } }), { status: 200 });
  }) as typeof fetch;
  const data = await fetchSeo(googleCall({ PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "x" }, impl), { siteUrl: "sc-domain:acme.com", period });
  for (const c of f.calls.filter((c) => c.url.includes("google-gsc"))) assert.equal(c.body.dataState, "all");
  assert.equal(data.gsc.incompleteFrom, "2026-09-03");
  const out = String(await SeoReport({ data }).toString());
  assert.match(out, /had not finished counting from Sep 3, 2026/);

  const final = await fetchSeo(googleCall({ PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "x" }, fakeFetch().impl), { siteUrl: "sc-domain:acme.com", period });
  assert.equal(final.gsc.incompleteFrom, null);
  assert.doesNotMatch(String(await SeoReport({ data: final }).toString()), /had not finished/);
});

test("printing makes the output folder, passes the paths as arguments, and leaves no temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "print-test-"));
  try {
    // a stand-in browser: writes a PDF where --print-to-pdf says and records the page it was given
    const chrome = join(dir, "chrome; touch pwned");
    await writeFile(
      chrome,
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --print-to-pdf=*) printf '%%PDF' > "\${a#--print-to-pdf=}";; file://*) echo "$a" > "${dir}/page";; esac; done\n`,
    );
    await chmod(chrome, 0o755);
    const pdf = join(dir, "out $(touch pwned)", "seo.pdf");
    assert.equal(await printToPdf("<p>hi</p>", pdf, { chrome }), pdf);
    assert.equal(await readFile(pdf, "utf8"), "%PDF");
    const page = decodeURIComponent(new URL((await readFile(join(dir, "page"), "utf8")).trim()).pathname);
    assert.equal(existsSync(page), false); // the rendered page's temp folder is gone
    assert.equal(existsSync(join(dir, "pwned")), false);
    assert.equal(existsSync("pwned"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CTR over unequal days differs from the average of daily CTRs", () => {
  const rows = [
    { clicks: 50, impressions: 100, position: 2 },
    { clicks: 10, impressions: 10_000, position: 20 },
  ];
  const naive = (0.5 + 0.001) / 2;
  const t = gscTotals(rows);
  assert.equal(t.ctr, 60 / 10_100);
  assert.notEqual(t.ctr, naive);
  assert.ok(Math.abs((t.position as number) - (2 * 100 + 20 * 10_000) / 10_100) < 1e-12);
});

test("a failing call names the vendor and the status; GA4 is optional", async () => {
  const bad = (async () => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 })) as typeof fetch;
  await assert.rejects(
    fetchSeo(googleCall({ PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "x" }, bad), { siteUrl: "https://acme.com/", period }),
    /google-gsc\/webmasters.*403 .*PERMISSION_DENIED/,
  );
  const f = fakeFetch();
  const data = await fetchSeo(googleCall({ PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "x" }, f.impl), { siteUrl: "https://acme.com/", period });
  assert.equal(data.ga4, null);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls[0].url.includes("/sites/https%3A%2F%2Facme.com%2F/"));
  await assert.rejects(googleCall({})("google-gsc", "/x", {}), /machine/);
});

test("printing finds the crawler's browser and passes a file URL", () => {
  assert.equal(findChrome({}, () => false), null);
  assert.match(findChrome({}, (p) => p.endsWith("chrome-headless-shell")) ?? "", /\.local\/bin\/chrome-headless-shell$/);
  assert.equal(findChrome({ CHROME_PATH: "/x/chrome" }, () => true), "/x/chrome");
  const args = chromeArgs("/tmp/r/report.html", "/tmp/out.pdf");
  assert.equal(args.at(-1), "file:///tmp/r/report.html");
  assert.ok(args.includes("--print-to-pdf=/tmp/out.pdf"));
});

let t: Scratch | null = null;
before(async () => {
  t = await scratch();
});
after(async () => t?.drop());

test("a snapshot round-trips, and none saved yet is null", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  assert.equal(await loadSnapshot(t!.db, "seo"), null, "no table yet is no snapshot");
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  await applySchema(t!.db, schema);
  await applySchema(t!.db, schema); // setup runs on every start
  assert.equal(await loadSnapshot(t!.db, "seo"), null);
  await saveSnapshot(t!.db, "seo", { a: 1 });
  await saveSnapshot(t!.db, "seo", { a: 2, s: "</script>" });
  const snap = await loadSnapshot<Partial<SeoData> & { a: number; s: string }>(t!.db, "seo");
  assert.equal(snap?.data.a, 2);
  assert.equal(snap?.data.s, "</script>");
});
