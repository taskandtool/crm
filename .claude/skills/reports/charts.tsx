// The pieces of a report page, server-rendered: KPI tiles, and line, bar and
// funnel charts. A chart is a <canvas> that client.js draws, the chart's data
// as a JSON <script> beside it, and a "View data" table under it, so the
// numbers are there for a screen reader, a printout and a page without
// JavaScript.
//
//   <AdminLayout title="Leads" css="/site.css" nav={NAV} current="/reports" user={user} head={<ChartScripts src="/reports.js" />}>
//     <KpiRow>
//       <KpiTile label="Leads" value={42} previous={35} />
//       <KpiTile label="Average position" value={8.2} previous={9.1} lowerIsBetter change="absolute" format={{ digits: 1 }} />
//     </KpiRow>
//     <LineChart title="Leads per week" labels={labels} series={[{ label: "This period", data }, { label: "Previous period", data: prev, previous: true }]} />
//   </AdminLayout>
//
// Styled with the theme tokens only, so a report takes on the app's brand
// (and so the client's, when brand/ is filled) with no change here.
import type { Child } from "hono/jsx";
import type { Grain } from "./sql";

export const CHARTJS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js";
export const CHARTJS_SRI = "sha512-WoViKhKD4qI2WruSZqv9+kvM4WfFhUMQCLN4QlDTt5aU56fLQy2gYoxWIqlEnXqJy/+Ac5q/hk1oWfqnMDhwMA==";

/** Chart.js and client.js, for AdminLayout's `head`. `src` is where the app serves client.js. */
export function ChartScripts(props: { src: string }) {
  return (
    <>
      <script src={CHARTJS_SRC} integrity={CHARTJS_SRI} crossorigin="anonymous" referrerpolicy="no-referrer" defer></script>
      <script src={props.src} defer></script>
    </>
  );
}

// ---- Numbers ----------------------------------------------------------------

export type NumberFormat = {
  style?: "number" | "currency" | "percent";
  /** ISO code, with style "currency"; values are in major units (fromMinor) */
  currency?: string;
  /** 1.2K, 3.4M */
  compact?: boolean;
  /** maximum fraction digits */
  digits?: number;
};

export function formatNumber(v: number | null | undefined, f: NumberFormat = {}, locale = "en-US"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const o: Intl.NumberFormatOptions = { style: f.style === "currency" || f.style === "percent" ? f.style : "decimal" };
  if (f.style === "currency") o.currency = f.currency ?? "USD";
  if (f.compact) o.notation = "compact";
  if (f.digits !== undefined) {
    o.maximumFractionDigits = f.digits;
    if (f.style === "currency") o.minimumFractionDigits = Math.min(f.digits, 2);
  } else if (f.style === "percent") o.maximumFractionDigits = 1;
  else if (f.compact) o.maximumFractionDigits = 1;
  return new Intl.NumberFormat(locale, o).format(v);
}

// Stripe's own minor units (docs.stripe.com/currencies), as payments/money.ts
// stores them. Not Intl's digits: Intl gives ISK and UGX none, but Stripe
// takes ISK in hundredths, so Intl would show 100 kr as 10,000 kr.
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Minor units (as Stripe counts them) to major for display: 1999 USD is 19.99, 1999 JPY is 1999, 1999 KWD is 1.999. */
export function fromMinor(amount: number, currency: string): number {
  const c = currency.toLowerCase();
  return amount / 10 ** (ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2);
}

/**
 * A bucket's label. Buckets are local dates ("2026-11-01"); they are
 * formatted as UTC calendar dates because `new Date("2026-11-01")` is UTC
 * midnight, which any zone west of Greenwich would show as October 31.
 */
export function bucketLabel(bucket: string, grain: Grain, locale = "en-US"): string {
  const d = new Date(bucket + "T00:00:00Z");
  if (grain === "month") return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", year: "numeric" }).format(d);
  const day = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
  return grain === "week" ? `Week of ${day}` : day;
}

// ---- KPI tiles --------------------------------------------------------------

export type ChangeAs = "percent" | "points" | "absolute";
export type Trend = "good" | "bad" | "flat" | "none";

/**
 * How `value` moved from `previous`. `percent` is relative; `points` is the
 * difference of two fractions in percentage points (a CTR from 2.1% to 2.5%
 * is +0.4 points, not +19%); `absolute` is the plain difference (a position).
 * Percent from a previous zero has no size, only a direction. `digits` is
 * how an absolute change is shown; less than that rounds to no change.
 */
export function kpiChange(value: number | null, previous: number | null | undefined, how: ChangeAs = "percent", lowerIsBetter = false, digits = 1) {
  if (value === null || previous === null || previous === undefined) return { delta: null, direction: "none" as const, trend: "none" as Trend };
  let delta: number | null;
  if (how === "percent") delta = previous === 0 ? null : (value - previous) / Math.abs(previous);
  else if (how === "points") delta = (value - previous) * 100;
  else delta = value - previous;
  // Flat when the change would print as zero: "down 0, better" is not a change.
  const tiny = how === "percent" ? 0.0005 : how === "points" ? 0.05 : 0.5 * 10 ** -digits;
  const diff = value - previous;
  const direction = (delta === null ? diff === 0 : Math.abs(delta) < tiny) ? ("flat" as const) : diff > 0 ? ("up" as const) : ("down" as const);
  const trend: Trend = direction === "flat" ? "flat" : (direction === "up") !== lowerIsBetter ? "good" : "bad";
  return { delta, direction, trend };
}

/**
 * The class for each trend. The theme tokens have no green and red, so good
 * takes the accent and bad stays ink; the arrow and the words carry the
 * meaning either way. An app with signal tokens (the Board's `late`) changes
 * it here.
 */
export const TREND_CLASS: Record<Trend, string> = {
  good: "text-accent",
  bad: "text-ink",
  flat: "text-ink-3",
  none: "text-ink-3",
};

export function KpiRow(props: { label?: string; children?: Child }) {
  return (
    <dl aria-label={props.label} class="grid grid-cols-2 gap-3 md:grid-cols-4">
      {props.children}
    </dl>
  );
}

export function KpiTile(props: {
  label: string;
  value: number | null;
  previous?: number | null;
  format?: NumberFormat;
  change?: ChangeAs;
  lowerIsBetter?: boolean;
  /** what the change is measured against, for the sentence: "the previous 28 days" */
  against?: string;
  locale?: string;
}) {
  const { label, value, previous, format = {}, change = "percent", lowerIsBetter = false, against = "the previous period", locale = "en-US" } = props;
  const { delta, direction, trend } = kpiChange(value, previous, change, lowerIsBetter, format.digits ?? 1);
  const shown = formatNumber(value, format, locale);
  let size = "";
  if (delta !== null && direction !== "flat") {
    const abs = Math.abs(delta);
    size =
      change === "percent"
        ? formatNumber(abs, { style: "percent" }, locale)
        : change === "points"
          ? `${formatNumber(abs, { digits: 1 }, locale)} pts`
          : formatNumber(abs, { ...format, compact: false, digits: format.digits ?? 1 }, locale);
  }
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : direction === "flat" ? "■" : "";
  const words =
    direction === "none"
      ? "no earlier figure to compare"
      : direction === "flat"
        ? `no change on ${against}`
        : `${direction}${size ? " " + size : ""} on ${against}, ${trend === "good" ? "better" : "worse"}`;
  return (
    <div class="rounded-card border border-line bg-surface p-4" data-trend={trend}>
      <dt class="text-label text-ink-3">{label}</dt>
      <dd class="mt-1 text-title font-semibold tabular-nums">{shown}</dd>
      <dd class={"mt-1 text-label tabular-nums " + TREND_CLASS[trend]}>
        <span aria-hidden="true">
          {direction === "none" ? "No comparison" : `${arrow} ${size || (direction === "flat" ? "No change" : "")}`.trim()}
          {lowerIsBetter && direction !== "none" ? " (lower is better)" : ""}
        </span>
        <span class="sr-only">{`${label} ${shown}, ${words}.`}</span>
      </dd>
    </div>
  );
}

// ---- Charts -----------------------------------------------------------------

export type Series = { label: string; data: (number | null)[]; previous?: boolean };

/** What client.js reads from the JSON script beside each canvas. */
export type ChartSpec = {
  kind: "line" | "bar" | "funnel";
  labels: string[];
  series: Series[];
  format?: NumberFormat;
  /** draw the value axis upside down: rank 1 at the top (Search Console position) */
  reverse?: boolean;
  locale?: string;
};

/**
 * JSON for inside a <script> element. The HTML parser ends the element at
 * the first "</script" whatever JSON thinks, so every "<" is written as
 * \u003c (JSON.parse reads it back unchanged); U+2028 and U+2029 likewise.
 * It has to go in through dangerouslySetInnerHTML: JSX escapes text
 * children to &lt; and &quot;, which a script element does not decode.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

type ChartProps = {
  title: string;
  labels: string[];
  series: Series[];
  format?: NumberFormat;
  /** the canvas's text alternative; a range-and-peak summary is written when omitted */
  summary?: string;
  reverse?: boolean;
  /** the box the canvas fills; Chart.js needs a sized parent of its own */
  box?: string;
  locale?: string;
};

function summarise(kind: string, p: ChartProps): string {
  const fmt = (v: number | null) => formatNumber(v, p.format, p.locale);
  const range = p.labels.length ? `, ${p.labels[0]} to ${p.labels[p.labels.length - 1]}` : "";
  const parts = p.series
    .filter((s) => !s.previous)
    .map((s) => {
      let hi = -1;
      let lo = -1;
      s.data.forEach((v, i) => {
        if (v === null) return;
        if (hi < 0 || v > (s.data[hi] as number)) hi = i;
        if (lo < 0 || v < (s.data[lo] as number)) lo = i;
      });
      if (hi < 0) return `${s.label}: no data`;
      const [best, worst] = p.reverse ? [lo, hi] : [hi, lo];
      return `${s.label}: highest ${fmt(s.data[best])} (${p.labels[best]}), lowest ${fmt(s.data[worst])} (${p.labels[worst]})`;
    });
  return `${kind} chart of ${p.title}${range}. ${parts.join("; ")}. The table below has every value.`;
}

function Chart(props: ChartProps & { kind: ChartSpec["kind"]; table: Child }) {
  const { kind, title, labels, series, format, reverse, locale, box = "h-64" } = props;
  const spec: ChartSpec = { kind, labels, series, format, reverse, locale };
  const name = kind === "line" ? "Line" : kind === "bar" ? "Bar" : "Funnel";
  return (
    <figure class="break-inside-avoid rounded-card border border-line bg-surface p-4" data-report-chart>
      <figcaption class="mb-3 text-label font-semibold text-ink-2">{title}</figcaption>
      <div class={"relative " + box}>
        <canvas role="img" aria-label={props.summary ?? summarise(name, props)}></canvas>
      </div>
      <script type="application/json" data-chart dangerouslySetInnerHTML={{ __html: jsonForScript(spec) }}></script>
      <details class="mt-3 text-label">
        <summary class="cursor-pointer text-ink-2">View data</summary>
        <div class="mt-2 overflow-x-auto">{props.table}</div>
      </details>
    </figure>
  );
}

function SeriesTable(p: ChartProps) {
  return (
    <table class="w-full text-left tabular-nums">
      <thead>
        <tr class="border-b border-line">
          <th scope="col" class="py-1 pr-4 font-semibold">{p.title}</th>
          {p.series.map((s) => (
            <th scope="col" class="py-1 pr-4 text-right font-semibold">{s.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {p.labels.map((l, i) => (
          <tr class="border-b border-line">
            <th scope="row" class="py-1 pr-4 font-normal">{l}</th>
            {p.series.map((s) => (
              <td class="py-1 pr-4 text-right">{formatNumber(s.data[i] ?? null, p.format, p.locale)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A trend over buckets. Put the previous period second with `previous:
 * true`; its points line up with this period's by position (bucket 1 with
 * bucket 1), which is why the periods are the same length.
 */
export function LineChart(props: ChartProps) {
  return <Chart {...props} kind="line" table={<SeriesTable {...props} />} />;
}

export function BarChart(props: ChartProps) {
  return <Chart {...props} kind="bar" table={<SeriesTable {...props} />} />;
}

/** Steps that only narrow (lead, booked, showed, paid), with each step's share of the first and of the one before. */
export function FunnelChart(props: { title: string; steps: { label: string; value: number }[]; summary?: string; box?: string; locale?: string }) {
  const { steps, locale } = props;
  const first = steps[0]?.value ?? 0;
  const pct = (a: number, b: number) => (b === 0 ? "–" : formatNumber(a / b, { style: "percent" }, locale));
  const labels = steps.map((s) => s.label);
  const summary =
    props.summary ??
    `Funnel of ${props.title}: ${steps.map((s, i) => `${s.label} ${formatNumber(s.value, {}, locale)}${i ? ` (${pct(s.value, steps[i - 1].value)} of ${steps[i - 1].label})` : ""}`).join(", ")}.`;
  const table = (
    <table class="w-full text-left tabular-nums">
      <thead>
        <tr class="border-b border-line">
          <th scope="col" class="py-1 pr-4 font-semibold">Step</th>
          <th scope="col" class="py-1 pr-4 text-right font-semibold">People</th>
          <th scope="col" class="py-1 pr-4 text-right font-semibold">Of the step before</th>
          <th scope="col" class="py-1 pr-4 text-right font-semibold">Of {steps[0]?.label ?? "the first"}</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s, i) => (
          <tr class="border-b border-line">
            <th scope="row" class="py-1 pr-4 font-normal">{s.label}</th>
            <td class="py-1 pr-4 text-right">{formatNumber(s.value, {}, locale)}</td>
            <td class="py-1 pr-4 text-right">{i ? pct(s.value, steps[i - 1].value) : "–"}</td>
            <td class="py-1 pr-4 text-right">{pct(s.value, first)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <Chart
      kind="funnel"
      title={props.title}
      labels={labels}
      series={[{ label: "People", data: steps.map((s) => s.value) }]}
      summary={summary}
      box={props.box ?? "h-48"}
      locale={locale}
      table={table}
    />
  );
}

// ---- Report pieces ----------------------------------------------------------

/** A titled section of a report, with an optional note under the heading (a data lag, a missing table). */
export function ReportSection(props: { title: string; note?: string; children?: Child }) {
  return (
    <section class="mt-8 first:mt-0" aria-label={props.title}>
      <h2 class="text-copy font-semibold">{props.title}</h2>
      {props.note ? <p class="mt-1 text-label text-ink-3">{props.note}</p> : null}
      <div class="mt-3 grid gap-4">{props.children}</div>
    </section>
  );
}

/**
 * A report as a standalone document, for printing to PDF (print.ts): no
 * private navigation, the stylesheet and scripts by absolute or file:// URL,
 * and `data-print` so client.js draws without animation and marks the page
 * `data-charts-ready` when every chart is drawn.
 */
export function ReportDocument(props: { title: string; css: string; script: string; subtitle?: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href={props.css} />
        <ChartScripts src={props.script} />
      </head>
      <body class="bg-canvas font-body text-copy text-ink" data-print>
        <main class="mx-auto max-w-5xl px-6 py-8">
          <h1 class="text-title font-semibold">{props.title}</h1>
          {props.subtitle ? <p class="mt-1 text-label text-ink-3">{props.subtitle}</p> : null}
          <div class="mt-6">{props.children}</div>
        </main>
      </body>
    </html>
  );
}
