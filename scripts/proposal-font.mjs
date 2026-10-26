#!/usr/bin/env node
// A Google Fonts family into the proposal page, which loads nothing: its
// latin WOFF2 files in static/fonts/, its @font-face in styles/proposal.css
// (between the fonts markers, which this owns), the --font-display or
// --font-body token set to it, then the proposal build.
//
//   node scripts/proposal-font.mjs "Caladea" --for display
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { done, fail, flag, misused, parseArgs, plain } from "../src/data/cli.mjs";

const CSS = "styles/proposal.css";
const DIR = "static/fonts";
export const START = "/* fonts: written by scripts/proposal-font.mjs */";
export const END = "/* end fonts */";
const ROLES = { display: ["display"], body: ["body"], both: ["display", "body"] };
// Display text is set bold; body text is regular, with bold labels.
const WANT = { display: [700], body: [400, 700] };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HELP = `usage: node scripts/proposal-font.mjs "<Family>" [--for display|body|both]

Puts a Google Fonts family (brand/visual-identity.md names the business's) in
the proposal page: downloads its latin WOFF2 into ${DIR}/, writes its
@font-face between the fonts markers in ${CSS}, sets the token to it, and
runs the proposal build. A family no longer used by either token loses its
@font-face; its file stays.

  --for   display (titles), body (everything else) or both; default both

Prints "proposal-font: <Family> for <role>", each file written and the
family it replaced. Exit 1 when Google Fonts does not have the family or
cannot be reached, or the build fails; 2 when misused.`;

/** The latin faces in a css2 stylesheet: each file once, with the weights it covers. */
export function latinFaces(css) {
  const files = new Map();
  for (const m of css.matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const url = /src:\s*url\(([^)]+\.woff2)\)/.exec(m[1])?.[1];
    const w = /font-weight:\s*(\d+)(?:\s+(\d+))?/.exec(m[1]);
    if (!url || !w || /font-style:\s*italic/.test(m[1])) continue;
    const f = files.get(url) ?? { url, weights: [] };
    f.weights.push(Number(w[1]), Number(w[2] ?? w[1]));
    files.set(url, f);
  }
  return [...files.values()].map((f) => ({ url: f.url, min: Math.min(...f.weights), max: Math.max(...f.weights) }));
}

/** The faces the roles use: a variable file whole, else the static weight nearest each one wanted. */
export function chooseFaces(faces, roles) {
  const want = [...new Set(roles.flatMap((r) => WANT[r]))];
  const near = (w) => faces.reduce((best, f) => (Math.abs(f.min - w) < Math.abs(best.min - w) ? f : best));
  return faces.some((f) => f.max > f.min) ? faces.filter((f) => f.max > f.min) : [...new Set(want.map(near))];
}

/** Each weight a role wants that no chosen face has, with the nearest one shown instead. */
export function missingWeights(faces, roles) {
  const has = (w) => faces.some((f) => w >= f.min && w <= f.max);
  const nearest = (w) => faces.map((f) => Math.min(Math.max(w, f.min), f.max)).reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
  return roles.flatMap((role) => WANT[role].filter((w) => !has(w)).map((w) => ({ role, want: w, shown: nearest(w) })));
}

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const fileOf = (family, f) => `${slug(family)}-latin-${f.max > f.min ? "wght" : f.min}-normal.woff2`;
const face = (family, f) =>
  `@font-face {\n  font-family: "${family}";\n  font-style: normal;\n  font-weight: ${f.max > f.min ? `${f.min} ${f.max}` : f.min};\n  font-display: swap;\n  src: url("/fonts/${fileOf(family, f)}") format("woff2");\n}`;

/** The token's first family, or null. */
const tokenFamily = (css, role) => new RegExp(`--font-${role}:\\s*"([^"]+)"`).exec(css)?.[1] ?? null;

/** The roles `family` serves once set for `roles`: those, and any other token already naming it (its weights are kept). */
export const rolesFor = (css, family, roles) => [...roles, ...["display", "body"].filter((r) => !roles.includes(r) && tokenFamily(css, r) === family)];

/**
 * styles/proposal.css with `family` set for `roles`: the token's first family
 * replaced (its fallbacks kept), the fonts block holding this family's faces
 * and those of any family a token still names.
 */
export function rewrite(css, family, roles, faces) {
  const at = css.indexOf(START), end = css.indexOf(END);
  if (at < 0 || end < at) return null;
  let out = css;
  // the first family replaced, quoted or not; the fallbacks after it kept
  for (const r of roles) out = out.replace(new RegExp(`(--font-${r}:\\s*)("[^"]+"|[^,;"]+)`), `$1"${family}"`);
  const used = new Set(["display", "body"].map((r) => tokenFamily(out, r)));
  const kept = (css.slice(at + START.length, end).match(/@font-face\s*\{[^}]*\}/g) ?? [])
    .filter((f) => { const n = /font-family:\s*"([^"]+)"/.exec(f)?.[1]; return n !== family && used.has(n); });
  const block = [START, ...kept, ...faces.map((f) => face(family, f)), END].join("\n");
  return out.slice(0, out.indexOf(START)) + block + out.slice(out.indexOf(END) + END.length);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  plain(a, HELP, "proposal-font", { flags: ["for"], args: true });
  const tryCmd = 'node scripts/proposal-font.mjs "Caladea" --for display';
  if (a._.length !== 1) misused(`proposal-font: name one family (given ${a._.length})`, tryCmd);
  const family = a._[0].trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/.test(family)) misused(`proposal-font: "${family}" is not a font family name`, tryCmd);
  const role = flag(a, "for") ?? "both";
  if (!ROLES[role]) misused(`proposal-font: --for ${role}; valid: display, body, both`, tryCmd);
  const roles = ROLES[role];

  const css = readFileSync(CSS, "utf8");
  if (css.indexOf(START) < 0 || css.indexOf(END) < css.indexOf(START)) {
    fail(`proposal-font: ${CSS} has no fonts block`, `put "${START}" and "${END}" around its @font-face rules`);
  }
  const before = roles.map((r) => tokenFamily(css, r));
  const all = Array.from({ length: 9 }, (_, i) => (i + 1) * 100).join(";");
  let sheet;
  try {
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${all}&display=swap`, {
      headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000),
    });
    if (res.status === 400) fail(`proposal-font: Google Fonts has no family "${family}"`, `check the name at fonts.google.com, or put its WOFF2 in ${DIR}/ with an @font-face in ${CSS}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sheet = await res.text();
  } catch (e) {
    fail(`proposal-font: Google Fonts could not be reached (${e.message})`, tryCmd);
  }
  const faces = latinFaces(sheet);
  if (!faces.length) fail(`proposal-font: Google Fonts serves "${family}" with no latin upright face`, `choose another family, or put its WOFF2 in ${DIR}/`);
  const chosen = chooseFaces(faces, rolesFor(css, family, roles));

  mkdirSync(DIR, { recursive: true });
  const written = [];
  for (const f of chosen) {
    const path = join(DIR, fileOf(family, f));
    if (existsSync(path)) continue;
    const res = await fetch(f.url, { signal: AbortSignal.timeout(20000) }).catch((e) => fail(`proposal-font: ${f.url} could not be fetched (${e.message})`, tryCmd));
    if (!res.ok) fail(`proposal-font: ${f.url} answered ${res.status}`, tryCmd);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    written.push(path);
  }
  const next = rewrite(css, family, roles, chosen);
  const changed = next !== css;
  if (changed) writeFileSync(CSS, next);
  const build = spawnSync("node", ["scripts/proposal-build.mjs"], { encoding: "utf8" });
  if (build.status !== 0) fail(`proposal-font: the proposal build failed\n${(build.stderr || build.stdout).trim()}`, "npm run css");

  const was = before.filter((b) => b && b !== family);
  done("proposal-font", `${family} for ${roles.join(" and ")}`, {
    lines: [
      ...written.map((p) => `wrote ${p}`),
      changed ? `${CSS}: @font-face and --font-${roles.join(", --font-")}${was.length ? ` (was ${[...new Set(was)].join(", ")})` : ""}` : `${CSS}: already set, left alone`,
      ...missingWeights(chosen, roles).map((m) => `${family} has no ${m.want} weight: ${m.role} text set at ${m.want} shows at ${m.shown} (the page never fakes a bold)`),
      build.stdout.trim(),
    ],
    next: "npm run check, then Preview a quote",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
