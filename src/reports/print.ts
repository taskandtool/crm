// A report as a PDF, for a deliverable (a deliverable is a file). Machine
// only: Node built-ins and a local browser. The browser is the one the
// crawler installs (`tt-crawl setup` puts chrome-headless-shell in
// ~/.local/bin); with none, hand over a link to the private report page
// instead.
//
// The job renders the report itself, from figures it has just loaded, into
// a standalone file, so the browser needs no sign-in to see a private page:
//
//   const html = "<!doctype html>" + (
//     <ReportDocument title="SEO report, September" css={fileUrl("static/site.css")} script={fileUrl("src/reports/client.js")}>
//       <SeoReport data={data} />
//     </ReportDocument>
//   ).toString();
//   await printToPdf(html, "out/seo-2026-09.pdf");      // then create_deliverables([{ path, title, status: "info" }], …)
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CHROME_CANDIDATES = [
  join(homedir(), ".local", "bin", "chrome-headless-shell"),
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** The browser to print with: CHROME_PATH, else the first that exists, else null. */
export function findChrome(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (env.CHROME_PATH) return exists(env.CHROME_PATH) ? env.CHROME_PATH : null;
  return CHROME_CANDIDATES.find(exists) ?? null;
}

/** A local file as a URL the report document can load (stylesheet, client.js). */
export const fileUrl = (path: string) => pathToFileURL(resolve(path)).href;

/**
 * The browser's arguments. `--virtual-time-budget` lets the page's scripts
 * (Chart.js from the CDN, client.js) finish before the print; the width is
 * the layout the charts are drawn at, close to an A4 or Letter page.
 */
export function chromeArgs(htmlFile: string, pdfFile: string, width = 1000): string[] {
  return [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=20000",
    `--window-size=${width},1400`,
    `--print-to-pdf=${resolve(pdfFile)}`,
    pathToFileURL(resolve(htmlFile)).href,
  ];
}

/** Print an HTML document to a PDF file. Throws when no browser is found or the PDF is not written. */
export async function printToPdf(html: string, pdfFile: string, opts: { chrome?: string; width?: number; timeoutMs?: number } = {}): Promise<string> {
  const chrome = opts.chrome ?? findChrome();
  if (!chrome) throw new Error("No browser to print with: run `tt-crawl setup`, or hand over a link to the report page instead.");
  const dir = await mkdtemp(join(tmpdir(), "report-"));
  const page = join(dir, "report.html");
  try {
    await writeFile(page, html, "utf8");
    await rm(pdfFile, { force: true });
    await mkdir(dirname(resolve(pdfFile)), { recursive: true }); // the browser does not make out/
    await new Promise<void>((ok, fail) =>
      execFile(chrome, chromeArgs(page, pdfFile, opts.width), { timeout: opts.timeoutMs ?? 60_000 }, (err, _out, errOut) =>
        err ? fail(new Error(`${chrome} failed: ${err.message} ${String(errOut).slice(-500)}`)) : ok(),
      ),
    );
    if (!(await stat(pdfFile).catch(() => null))?.size) throw new Error("the browser wrote no PDF");
    return resolve(pdfFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
