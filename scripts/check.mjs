#!/usr/bin/env node
// The CRM's own checks, run with `npm run check` before showing work:
//   - crm.config.json and every example are valid (the server's validator)
//   - schema.sql only adds (the same rule applySchema enforces)
//   - no markup carries what DESIGN.md refuses: hex colours, default
//     Tailwind colours, gradients, blur, animations, tracking/leading
//     overrides, weights above semibold
//   - no em dashes in the interface copy
//   - only the dev-only files under src/ import a Node built-in, so the
//     code production runs on Cloudflare stays portable
//   - the manifest, the skill and its adapter, the vendored scripts are there
//   - the typecheck passes
// Exit 1 with the findings when something is off.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const findings = [];

// crm.config.json, the examples and schema.sql, through the app's own code (needs tsx)
const cfgCheck = spawnSync("node_modules/.bin/tsx", ["-e", `
  import { validate } from "./src/config-schema";
  import { additiveProblems } from "./src/data/migrate";
  import { readFileSync, readdirSync } from "node:fs";
  const files = ["crm.config.json", ...readdirSync("examples").filter((f) => f.endsWith(".json")).map((f) => "examples/" + f)];
  for (const f of files) {
    let raw; try { raw = JSON.parse(readFileSync(f, "utf8")); } catch (e) { console.log(f + " is not valid JSON: " + e.message); continue; }
    for (const p of validate(raw)) console.log(f + ": " + p);
    if (f === "crm.config.json" && typeof raw.business === "string" && raw.business.includes("to fill")) console.error("note: crm.config.json's business line is still to fill; the CRM is a template until the AI shapes it");
  }
  for (const p of additiveProblems(readFileSync("schema.sql", "utf8"))) console.log("schema.sql: " + p);
`], { encoding: "utf8" });
for (const line of (cfgCheck.stdout || "").split("\n").filter(Boolean)) findings.push(line);
if (cfgCheck.status !== 0) findings.push("the config could not be validated:\n" + (cfgCheck.stderr || "").trim().split("\n").slice(0, 6).join("\n"));
else if (cfgCheck.stderr) process.stderr.write(cfgCheck.stderr);

// the refuse list, in markup
function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const refuse = [
  [/\b(bg|text|border|from|to|via|ring|outline|fill|stroke)-\[#/, "a hex colour in markup: add a role token in styles/theme.css instead"],
  [/\b(bg|text|border|ring|outline)-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/, "a Tailwind default colour: the palette is the theme's tokens only"],
  [/\b(bg-gradient-|bg-linear-|bg-radial-|bg-conic-)/, "a gradient"],
  [/\b(backdrop-blur|blur-|drop-shadow-)/, "blur or glass"],
  [/\banimate-/, "an animation utility"],
  [/\b(tracking|leading)-/, "a tracking/leading override: the size token carries both"],
  [/\bfont-(bold|extrabold|black)\b/, "a weight above semibold"],
  [/\btext-\[(?!clamp)/, "an arbitrary text size: add a --text-* token"],
];
const isTest = (f) => f.includes("/test/");
for (const file of walk("src").filter((f) => f.endsWith(".tsx") && !isTest(f))) {
  const src = readFileSync(file, "utf8");
  for (const [rx, why] of refuse) {
    const m = src.match(rx);
    if (m) findings.push(`${file}: "${m[0]}" is ${why}`);
  }
  src.split("\n").forEach((line, i) => {
    if (line.includes("—")) findings.push(`${file}:${i + 1}: an em dash in interface copy; write a comma, a colon, or a new sentence`);
  });
}

// production runs the same app on Cloudflare: Node built-ins only in the
// files that run in dev alone
const nodeOnly = new Set(["src/server.ts", "src/db/client.ts", "src/db/setup.ts", "src/booking/sync.ts"]);
for (const file of walk("src").filter((f) => /\.tsx?$/.test(f) && !nodeOnly.has(f) && !isTest(f))) {
  // Imports only: a comment that shows a Node import (src/data/migrate.ts) is not one.
  const code = readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const m = code.match(/from "(node:[a-z_/]+)"/);
  if (m) findings.push(`${file} imports ${m[1]}: production on Cloudflare runs this file; only ${[...nodeOnly].join(", ")} may`);
}

// the conventions the platform reads
if (!existsSync("starter-app.json")) findings.push("starter-app.json is missing");
if (!existsSync(".claude/skills/crm/SKILL.md")) findings.push(".claude/skills/crm/SKILL.md is missing");
if (!existsSync(".agents/skills/crm/SKILL.md")) findings.push(".agents/skills/crm/SKILL.md (the Codex adapter) is missing");
if (!existsSync("static/vendor/htmx.min.js") || !existsSync("static/vendor/Sortable.min.js")) findings.push("static/vendor is missing: run npm run vendor");

// typecheck
const tc = spawnSync("node_modules/.bin/tsc", ["--noEmit", "-p", "."], { encoding: "utf8" });
if (tc.status !== 0) findings.push("typecheck failed:\n" + tc.stdout);

if (findings.length) {
  console.error("check: " + findings.length + " finding(s)\n  - " + findings.join("\n  - "));
  process.exit(1);
}
console.log("check: ok");
