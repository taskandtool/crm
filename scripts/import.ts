// CSV in: the customer list a business keeps today. Always --dry-run first
// and show the owner the mapping. `node scripts/import.mjs --help`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cfg } from "../src/config";
import { decodeCsv, parseCsv } from "../src/crm/csv-read";
import { guessMap, IMPORT_FIELDS, planRows, runImport } from "../src/crm/importer";
import { firstOpenStage, listStages, resolveStage } from "../src/crm/stages";
import { clean, parseTags } from "../src/crm/text";
import { fail, flag, flags, has, parseArgs, who, withDb } from "./lib";

const HELP = `import.mjs <file.csv> [--dry-run] [--map field=Header,...] [--stage s] [--source s] [--tag t]... [--overwrite]

Reads a CSV with a header row. Headers are matched to fields by name
(${IMPORT_FIELDS.join(", ")},
and each custom field's key or label); --map fixes a miss as field=Header.
First name and last name columns are joined into the name.

Each row is matched to an existing customer by email, then by phone, and
to earlier rows of the same file the same way, so nobody is added twice. A
match only gains: empty fields are filled, tags are added, the last contact
moves later. A field that already has a value is kept unless --overwrite
(which also lets the file's stage replace the current one). New customers
take the row's stage, else --stage, else the first open stage; --source
applies to new rows that do not say, and --tag is added to every row.
Anyone left without a last contact gets the time of their latest form
submission, booking or payment, by email. All or nothing: one transaction.

--dry-run prints the mapping and what would happen, and writes nothing.`;

const a = parseArgs(process.argv.slice(2));
const [file] = a._;
if (!file || has(a, "help")) {
  console.log(HELP);
  process.exit(file || has(a, "help") ? 0 : 1);
}

const path = resolve(process.env.CALLER_CWD ?? ".", file);
let decoded: ReturnType<typeof decodeCsv>;
try {
  decoded = decodeCsv(readFileSync(path));
} catch (e) {
  fail(`cannot read ${path}: ${(e as Error).message}`);
}
let rows: string[][] = [];
try {
  rows = parseCsv(decoded.text);
} catch (e) {
  fail(`${file}: ${(e as Error).message}; fix it in the spreadsheet and save as CSV again`);
}
if (rows.length < 2) fail("the file has no data rows under a header row");
const headers = rows[0].map((h) => h.trim());
const map = guessMap(headers, cfg.fields);
for (const kv of (flag(a, "map") ?? "").split(",").filter(Boolean)) {
  const i = kv.indexOf("=");
  if (i < 1) fail(`--map ${kv}: write field=Header`);
  const field = kv.slice(0, i).trim();
  const header = kv.slice(i + 1).trim();
  if (!IMPORT_FIELDS.includes(field) && !cfg.fields.some((f) => f.key === field)) fail(`--map ${kv}: no field ${field}`);
  if (!headers.includes(header)) fail(`--map ${kv}: no header "${header}"; headers are ${headers.join(", ")}`);
  for (const [f, h] of Object.entries(map)) if (h === header && f !== field) delete map[f];
  map[field] = header;
}
if (!map.name && !map.first_name && !map.email && !map.phone) fail(`no name, email or phone column found; pass --map name=<Header> (headers: ${headers.join(", ")})`);

await withDb(async (db) => {
  const stages = await listStages(db);
  const stageArg = flag(a, "stage");
  const def = stageArg ? resolveStage(stages, stageArg) : await firstOpenStage(db);
  if (!def) fail(`no stage ${stageArg ?? ""}; stages: ${stages.map((s) => s.key).join(", ")}`);
  const plan = planRows(rows, map, cfg.fields, stages);
  const dry = has(a, "dry-run");
  const summary = await runImport(db, plan, {
    dryRun: dry,
    overwrite: has(a, "overwrite"),
    defaultStage: def.key,
    source: clean(flag(a, "source"), 100),
    tags: parseTags(flags(a, "tag")),
    user: who(a),
  });
  const unmapped = headers.filter((h) => !Object.values(map).includes(h));
  if (decoded.encoding !== "utf-8") console.log(`note: the file is not UTF-8; read it as ${decoded.encoding}. Check the names with accents below.`);
  console.log("mapping: " + Object.entries(map).map(([f, h]) => `${f} <- "${h}"`).join(", "));
  if (unmapped.length) console.log(`not imported: ${unmapped.map((h) => `"${h}"`).join(", ")} (--map field=Header to use one)`);
  for (const w of plan.warnings) console.log("note: " + w);
  if (summary.skipped) console.log(`skipped ${summary.skipped} row(s) with no name, email or phone`);
  console.log(
    `${summary.rows} rows: ${summary.created} new, ${summary.updated} existing updated, ${summary.unchanged} existing unchanged, ${summary.merged} folded into another row of the file`,
  );
  for (const e of summary.examples) console.log("  " + e);
  console.log(dry ? "dry run: nothing written" : "imported");
});
