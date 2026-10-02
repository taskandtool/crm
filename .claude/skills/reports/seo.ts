// Search Console and GA4 figures for the SEO report, fetched through the
// Google connection on the platform's gateway. Machine only: the gateway
// answers only the machine's token, so a report served from the edge reads
// a snapshot a job saved (saveSnapshot / loadSnapshot), never Google.
//
//   const call = googleCall(process.env);                                // through the gateway (data/gateway.ts)
//   const period = lastFull("day", 28, zone, { lag: 3 });                // Search Console is final after ~3 days
//   const data = await fetchSeo(call, { siteUrl: "sc-domain:acme.com", ga4Property: "123456789", period });
//   await saveSnapshot(db, "seo", data);                                 // the table is made once, by createSnapshotTable at setup
//
// The figures that are easy to get wrong:
// - Totals come from the rows by date, never from the top-queries rows:
//   Search Console leaves anonymised queries out of query rows, so those
//   rows add up to less than the site's total.
// - CTR is total clicks over total impressions. Average position is each
//   day's position weighted by that day's impressions. Neither is a plain
//   average of rows.
// - A day with no impressions has no position (null), not position 0, which
//   would chart as the best rank there is.
// - A day Search Console has not finished is not a quiet day. The query asks
//   for dataState "all", which reports the first unfinished date; the default
//   ("final") just leaves those days out, and they would chart as zero.
//   `gsc.incompleteFrom` says when the period ran into one.
// - GA4 totals come from the API's TOTAL aggregation: a session that spans
//   midnight is in two date rows, so summing them counts it twice.
import type { Db } from "../data/db";
import type { Env } from "../data/env";
import { gatewayFetch } from "../data/gateway";
import { addDays, days, previousPeriod, ratioOfSums, weightedMean, type Period } from "./sql";

/** One call through the gateway: POST a JSON body to a vendor path, get JSON back. */
export type Call = (slug: string, path: string, body: unknown) => Promise<any>;

/** Google's report APIs through the gateway on this machine (`google-gsc`, `google-ga4`). Pass a fetch to test. */
export function googleCall(env: Env, fetchImpl: typeof fetch = fetch): Call {
  return async (slug, path, body) => {
    const res = await gatewayFetch(env, slug, path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }, fetchImpl);
    const text = await res.text();
    if (!res.ok) throw new Error(`${slug}${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
}

export type Totals = { clicks: number; impressions: number; ctr: number | null; position: number | null };
export type Day = { date: string; clicks: number; impressions: number; position: number | null };
export type TopRow = { key: string; clicks: number; impressions: number; ctr: number | null; position: number | null };
export type Ga4Totals = { sessions: number; keyEvents: number };

export type SeoData = {
  siteUrl: string;
  period: Period;
  previous: Period;
  fetchedAt: string;
  gsc: {
    current: Totals;
    previous: Totals;
    days: Day[];
    previousDays: Day[];
    queries: TopRow[];
    pages: TopRow[];
    /** the first date of the period Search Console had not finished, so its figures are partial; null when all were final */
    incompleteFrom?: string | null;
  };
  ga4: null | {
    property: string;
    current: Ga4Totals;
    previous: Ga4Totals;
    days: { date: string; sessions: number; keyEvents: number }[];
    previousDays: { date: string; sessions: number; keyEvents: number }[];
    landingPages: { page: string; sessions: number; keyEvents: number }[];
  };
};

type GscRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
type GscReply = { rows?: GscRow[]; metadata?: { firstIncompleteDate?: string } };

/** Search Console totals from rows by date (or with no dimension): sums, and the ratios from the sums. */
export function gscTotals(rows: readonly { clicks: number; impressions: number; position: number | null }[]): Totals {
  let clicks = 0;
  let impressions = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: ratioOfSums(rows, "clicks", "impressions"),
    position: weightedMean(rows, "position", "impressions"),
  };
}

/** Every date of the period, zero where Search Console sent no row, and no position on a day without impressions. */
export function gscDays(rows: readonly GscRow[], p: Period): Day[] {
  const by = new Map(rows.map((r) => [r.keys?.[0] ?? "", r]));
  const out: Day[] = [];
  for (let i = 0; i < days(p); i++) {
    const date = addDays(p.from, i);
    const r = by.get(date);
    out.push(
      r && r.impressions > 0
        ? { date, clicks: r.clicks, impressions: r.impressions, position: r.position }
        : { date, clicks: r?.clicks ?? 0, impressions: 0, position: null },
    );
  }
  return out;
}

const top = (rows: readonly GscRow[] = []): TopRow[] =>
  rows.map((r) => ({
    key: r.keys?.[0] ?? "",
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions ? r.clicks / r.impressions : null,
    position: r.impressions ? r.position : null,
  }));

const ORGANIC = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } };
const METRICS = [{ name: "sessions" }, { name: "keyEvents" }];

type Ga4Report = {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  totals?: { metricValues: { value: string }[] }[];
};

const ga4Date = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

function ga4Days(r: Ga4Report, p: Period) {
  const by = new Map((r.rows ?? []).map((row) => [ga4Date(row.dimensionValues[0].value), row.metricValues]));
  return Array.from({ length: days(p) }, (_, i) => {
    const date = addDays(p.from, i);
    const m = by.get(date);
    return { date, sessions: Number(m?.[0]?.value ?? 0), keyEvents: Number(m?.[1]?.value ?? 0) };
  });
}

function ga4Totals(r: Ga4Report): Ga4Totals {
  const t = r.totals?.[0]?.metricValues;
  if (t) return { sessions: Number(t[0]?.value ?? 0), keyEvents: Number(t[1]?.value ?? 0) };
  let sessions = 0;
  let keyEvents = 0;
  for (const row of r.rows ?? []) {
    sessions += Number(row.metricValues[0]?.value ?? 0);
    keyEvents += Number(row.metricValues[1]?.value ?? 0);
  }
  return { sessions, keyEvents };
}

/**
 * Fetch the SEO report's figures for a period and the one before it.
 * `siteUrl` is the Search Console property exactly as Search Console names
 * it: "sc-domain:acme.com" for a domain property, "https://acme.com/" (with
 * its slash) for a URL-prefix one. `ga4Property` is the numeric property id;
 * without it the report has no GA4 section. GA4 days are in the property's
 * own time zone, Search Console's in Pacific time; neither is the business
 * zone, and neither can be re-bucketed from outside.
 */
export async function fetchSeo(call: Call, opts: { siteUrl: string; ga4Property?: string | null; period: Period; previous?: Period; top?: number; now?: Date }): Promise<SeoData> {
  const { siteUrl, period } = opts;
  const previous = opts.previous ?? previousPeriod(period);
  const limit = opts.top ?? 25;
  const sc = (p: Period, dimension: string | null, rowLimit: number) =>
    call("google-gsc", `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      startDate: p.from,
      endDate: p.to,
      type: "web",
      ...(dimension ? { dimensions: [dimension] } : {}),
      rowLimit,
      dataState: "all",
    }) as Promise<GscReply>;
  const property = opts.ga4Property ? String(opts.ga4Property).replace(/^properties\//, "") : null;
  if (property !== null && !/^\d+$/.test(property)) throw new Error(`a GA4 property id is digits: ${property}`);
  const ga = (body: object) => call("google-ga4", `/v1beta/properties/${property}:runReport`, body) as Promise<Ga4Report>;
  const ga4ByDate = (p: Period) =>
    ga({
      dateRanges: [{ startDate: p.from, endDate: p.to }],
      dimensions: [{ name: "date" }],
      metrics: METRICS,
      dimensionFilter: ORGANIC,
      metricAggregations: ["TOTAL"],
      limit: 1000,
    });

  const [cur, prev, queries, pages, g] = await Promise.all([
    sc(period, "date", 1000),
    sc(previous, "date", 1000),
    sc(period, "query", limit),
    sc(period, "page", limit),
    property
      ? Promise.all([
          ga4ByDate(period),
          ga4ByDate(previous),
          ga({
            dateRanges: [{ startDate: period.from, endDate: period.to }],
            dimensions: [{ name: "landingPage" }],
            metrics: METRICS,
            dimensionFilter: ORGANIC,
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit,
          }),
        ])
      : null,
  ]);

  const curDays = gscDays(cur.rows ?? [], period);
  const prevDays = gscDays(prev.rows ?? [], previous);
  const unfinished = [cur, prev]
    .map((r) => r.metadata?.firstIncompleteDate)
    .filter((d): d is string => !!d && d <= period.to)
    .sort()[0];
  return {
    siteUrl,
    period,
    previous,
    fetchedAt: (opts.now ?? new Date()).toISOString(),
    gsc: {
      current: gscTotals(curDays),
      previous: gscTotals(prevDays),
      days: curDays,
      previousDays: prevDays,
      queries: top(queries.rows),
      pages: top(pages.rows),
      incompleteFrom: unfinished ?? null,
    },
    ga4:
      g && property
        ? {
            property,
            current: ga4Totals(g[0]),
            previous: ga4Totals(g[1]),
            days: ga4Days(g[0], period),
            previousDays: ga4Days(g[1], previous),
            landingPages: (g[2].rows ?? []).map((r) => ({
              page: r.dimensionValues[0]?.value ?? "",
              sessions: Number(r.metricValues[0]?.value ?? 0),
              keyEvents: Number(r.metricValues[1]?.value ?? 0),
            })),
          }
        : null,
  };
}

// ---- Snapshots ----------------------------------------------------------------
//
// The latest figures per key, in report_snapshots. The job
// on the machine saves; the page, wherever it runs, loads. The table is made
// once, by createSnapshotTable in the app's setup script, not on every save.

/** Make the snapshot table if it is not there. Run it from setup (machine only). */
export async function createSnapshotTable(db: Db): Promise<void> {
  await db.sql`create table if not exists report_snapshots (
    key text primary key, data jsonb not null, fetched_at timestamptz not null default now())`;
}

/** Save the figures under a key ("seo", "seo:acme"), replacing the last ones. */
export async function saveSnapshot(db: Db, key: string, data: unknown): Promise<void> {
  await db.sql`insert into report_snapshots (key, data) values (${key}, ${JSON.stringify(data)}::jsonb)
    on conflict (key) do update set data = excluded.data, fetched_at = now()`;
}

/** The saved figures for a key, or null when there are none yet. */
export async function loadSnapshot<T = unknown>(db: Db, key: string): Promise<{ data: T; fetched_at: string } | null> {
  try {
    const rows = await db.sql<{ data: T; fetched_at: string }>`
      select data, fetched_at::text as fetched_at from report_snapshots where key = ${key}`;
    return rows[0] ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return null; // no snapshot has ever been saved
    throw e;
  }
}
