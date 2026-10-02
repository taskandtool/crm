// Draws the report charts on a page. A plain browser script, no build step:
// serve this file as a static asset and load it after Chart.js
// (`<ChartScripts src="/reports.js" />` in charts.tsx does both, deferred).
//
// The data contract, which charts.tsx writes:
//
//   <figure data-report-chart>
//     <canvas role="img" aria-label="…"></canvas>     inside a sized box of its own
//     <script type="application/json" data-chart>{ "kind": "line" | "bar" | "funnel",
//       "labels": [...], "series": [{ "label", "data": [number|null], "previous"? }],
//       "format"?: { "style", "currency", "compact", "digits" }, "reverse"?, "locale"? }</script>
//     <details>… View data table …</details>
//   </figure>
//
// Colours and the font come from the theme's CSS custom properties, read at
// draw time, because a canvas cannot use CSS classes: the first series is
// --color-accent, further ones --color-chart-2… when the theme defines them
// (else --color-ink-2), a previous-period series --color-ink-3 and dashed,
// gridlines --color-line, text --color-ink-3, the font --font-body. They are
// read again when the theme changes (prefers-color-scheme, or a data-theme,
// class or style change on <html>).
//
// htmx: a chart is destroyed when htmx cleans up its canvas, and charts in
// new content are drawn on htmx:load. No animation under reduced motion or on
// a page marked data-print; a print resizes every chart to the paper first.
// When the charts on the page are drawn, <html> gets data-charts-ready, which
// a headless printer waits for.
(function () {
  "use strict";

  var FALLBACK = {
    accent: "#2f5bea",
    ink: "#1c1a17",
    ink2: "#4f4a43",
    ink3: "#6f6960",
    line: "rgba(28, 26, 23, 0.12)",
    canvas: "#ffffff",
    font: "ui-sans-serif, system-ui, sans-serif",
  };

  function numberFormat(f, locale) {
    f = f || {};
    var o = { style: f.style === "currency" ? "currency" : f.style === "percent" ? "percent" : "decimal" };
    if (o.style === "currency") o.currency = f.currency || "USD";
    if (f.compact) o.notation = "compact";
    if (f.digits != null) o.maximumFractionDigits = f.digits;
    else if (o.style === "percent" || f.compact) o.maximumFractionDigits = 1;
    var nf = new Intl.NumberFormat(locale || "en-US", o);
    return function (v) {
      return v == null || !isFinite(v) ? "–" : nf.format(v);
    };
  }

  // A Chart.js config from a spec and the theme's tokens. Pure, so it can be
  // tested without a browser.
  function config(spec, t, opts) {
    var fmt = numberFormat(spec.format, spec.locale);
    var horizontal = spec.kind === "funnel";
    var type = spec.kind === "line" ? "line" : "bar";
    var n = 0;
    var datasets = spec.series.map(function (s) {
      var c = s.previous ? t.ink3 : n++ === 0 ? t.accent : t.chart[n - 1] || t.ink2;
      return {
        label: s.label,
        data: s.data,
        borderColor: c,
        backgroundColor: c,
        borderWidth: type === "line" ? 2 : 0,
        borderDash: s.previous ? [4, 4] : [],
        pointRadius: type === "line" ? (s.data.length > 31 ? 0 : 2) : 0,
        pointHoverRadius: type === "line" ? 4 : 0,
        tension: 0,
        maxBarThickness: 48,
      };
    });
    var value = {
      beginAtZero: !spec.reverse,
      reverse: !!spec.reverse,
      grid: { color: t.line },
      border: { display: false },
      ticks: { color: t.ink3, font: { family: t.font }, callback: function (v) { return fmt(v); } },
    };
    var category = {
      grid: { display: false },
      border: { color: t.line },
      ticks: { color: t.ink3, font: { family: t.font }, autoSkip: true, maxRotation: 0 },
    };
    return {
      type: type,
      data: { labels: spec.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: opts.animate ? {} : false,
        devicePixelRatio: opts.print ? 2 : undefined,
        indexAxis: horizontal ? "y" : "x",
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: spec.series.length > 1,
            labels: { color: t.ink2, font: { family: t.font }, boxWidth: 12, boxHeight: 2 },
          },
          tooltip: {
            backgroundColor: t.ink,
            titleColor: t.canvas,
            bodyColor: t.canvas,
            titleFont: { family: t.font },
            bodyFont: { family: t.font },
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ": " + fmt(horizontal ? ctx.parsed.x : ctx.parsed.y);
              },
            },
          },
        },
        scales: horizontal ? { x: value, y: category } : { x: category, y: value },
      },
    };
  }

  var api = { config: config, numberFormat: numberFormat };
  (typeof window !== "undefined" ? window : globalThis).ReportCharts = api;
  if (typeof document === "undefined") return;

  var root = document.documentElement;
  var live = new Set();
  var probe, pixel;

  // Any CSS colour the browser understands (a var() chain, color-mix(),
  // oklch) to an rgba() string a canvas takes everywhere.
  function color(name, fallback) {
    var raw = getComputedStyle(root).getPropertyValue(name).trim();
    if (!raw) return fallback;
    if (!probe) {
      probe = document.createElement("span");
      probe.style.display = "none";
      pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    }
    if (!probe.isConnected) (document.body || root).appendChild(probe);
    probe.style.color = "";
    probe.style.color = raw;
    if (!probe.style.color) return fallback;
    var css = getComputedStyle(probe).color;
    if (/^rgba?\(/.test(css) || !pixel) return css;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = fallback;
    pixel.fillStyle = css;
    pixel.fillRect(0, 0, 1, 1);
    var d = pixel.getImageData(0, 0, 1, 1).data;
    return "rgba(" + d[0] + ", " + d[1] + ", " + d[2] + ", " + Math.round((d[3] / 255) * 100) / 100 + ")";
  }

  function tokens() {
    var chart = [];
    for (var i = 2; i <= 6; i++) chart[i - 1] = color("--color-chart-" + i, "");
    return {
      accent: color("--color-accent", FALLBACK.accent),
      ink: color("--color-ink", FALLBACK.ink),
      ink2: color("--color-ink-2", FALLBACK.ink2),
      ink3: color("--color-ink-3", FALLBACK.ink3),
      line: color("--color-line", FALLBACK.line),
      canvas: color("--color-surface", color("--color-canvas", FALLBACK.canvas)),
      font: getComputedStyle(root).getPropertyValue("--font-body").trim() || FALLBACK.font,
      chart: chart,
    };
  }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var printing = window.matchMedia("print");
  function opts() {
    var print = printing.matches || !!(document.body && document.body.hasAttribute("data-print"));
    return { animate: !reduced.matches && !print, print: print };
  }

  function charts(el) {
    var found = [];
    if (el.matches && el.matches("[data-report-chart]")) found.push(el);
    if (el.querySelectorAll) found.push.apply(found, el.querySelectorAll("[data-report-chart]"));
    return found;
  }

  function draw(el) {
    if (!window.Chart) return;
    var t = tokens();
    var o = opts();
    charts(el).forEach(function (fig) {
      var canvas = fig.querySelector("canvas");
      var data = fig.querySelector("script[data-chart]");
      if (!canvas || !data || window.Chart.getChart(canvas)) return;
      var spec;
      try {
        spec = JSON.parse(data.textContent);
      } catch (e) {
        return;
      }
      var chart = new window.Chart(canvas, config(spec, t, o));
      chart.$spec = spec;
      live.add(chart);
    });
    root.setAttribute("data-charts-ready", "");
  }

  function destroyWithin(el) {
    live.forEach(function (chart) {
      if (el === chart.canvas || (el.contains && el.contains(chart.canvas))) {
        chart.destroy();
        live.delete(chart);
      }
    });
  }

  // Charts whose canvas left the page by any route (an out-of-band swap, a
  // script) are let go too, so nothing keeps drawing to a detached canvas.
  function sweep() {
    live.forEach(function (chart) {
      if (!chart.canvas || !chart.canvas.isConnected) {
        chart.destroy();
        live.delete(chart);
      }
    });
  }

  var pending = 0;
  function restyle() {
    if (pending) return;
    pending = requestAnimationFrame(function () {
      pending = 0;
      var t = tokens();
      var o = opts();
      live.forEach(function (chart) {
        var c = config(chart.$spec, t, o);
        chart.data.datasets = c.data.datasets;
        chart.options = c.options;
        chart.update("none");
      });
    });
  }

  function resizeAll() {
    live.forEach(function (chart) {
      chart.resize();
    });
  }

  document.addEventListener("htmx:beforeCleanupElement", function (e) {
    destroyWithin(e.target);
  });
  document.addEventListener("htmx:load", function (e) {
    sweep();
    draw(e.target);
  });
  document.addEventListener("htmx:afterSettle", sweep);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", restyle);
  reduced.addEventListener("change", restyle);
  new MutationObserver(restyle).observe(root, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

  window.addEventListener("beforeprint", resizeAll);
  window.addEventListener("afterprint", resizeAll);
  printing.addEventListener("change", resizeAll);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      draw(document);
    });
  } else {
    draw(document);
  }

  api.draw = draw;
  api.destroyWithin = destroyWithin;
})();
