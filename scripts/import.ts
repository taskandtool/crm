// CSV or .xlsx in: the customer list a business keeps today. Always
// --dry-run first and show the owner the mapping. `node scripts/import.mjs --help`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cfg } from "../src/config";
import { decodeCsv, parseCsv } from "../src/crm/csv-read";
import { readXlsx } from "../src/crm/xlsx-read";
import { guessMap, IMPORT_FIELDS, planRows, runImport } from "../src/crm/importer";
import { firstOpenStage, listStages, resolveStage } from "../src/crm/stages";
import { clean, parseTags } from "../src/crm/text";
import { done, fail, flag, flags, has, misused, noMore, parseArgs, plain, who, withDb } from "./lib";

const HELP = `import.mjs <file.csv|file.xlsx> [--dry-run] [--map field=Header,...] [--status s] [--source s] [--tag t]... [--overwrite]

Reads a CSV, or the first sheet of an .xlsx, with a header row. Headers
are matched to fields by name (${IMPORT_FIELDS.join(", ")},
and each custom field's key or label); --map fixes a miss as field=Header.
First name and last name columns are joined into the name.

Each row is matched to an existing customer by email, then by phone, and
to earlier rows of the same file the same way, so nobody is added twice. A
match only gains: empty fields are filled, tags are added, the last contact
moves later. A field that already has a value is kept unless --overwrite
(which also lets the file's status replace the current one). New customers
take the row's status, else --status, else the first open status; --source
applies to new rows that do not say, and --tag is added to every row.
Anyone left without a last contact gets the time of their latest form
submission, booking or payment, by email. All or nothing: one transaction.

--dry-run prints the mapping and what would happen, and writes nothing.
A second run of the same file changes nothing new. Errors go to stderr with a
Try: line; exit 1 when refused, 2 when misused.`;

// --dry-run and --overwrite take no value: `--dry-run customers.csv` keeps the file.
const a = parseArgs(process.argv.slice(2), { bare: ["dry-run", "overwrite"] });
const [file, ...extra] = a._;
plain(a, HELP, "import", { flags: ["dry-run", "map", "status", "source", "tag", "overwrite", "as"], args: true });
if (!file) misused("import: name the CSV or .xlsx file", "node scripts/import.mjs customers.csv --dry-run");
noMore(extra, 0, "import");
const again = `node scripts/import.mjs ${file} --dry-run`;

const path = resolve(process.env.CALLER_CWD ?? ".", file);
const xlsx = /\.xlsx$/i.test(file);
let bytes!: Buffer;
try {
  bytes = readFileSync(path);
} catch (e) {
  fail(`import: cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, `ls ${dirname(path)}`);
}
const decoded = xlsx ? { text: "", encoding: "utf-8" } : decodeCsv(bytes);
let rows: string[][] = [];
try {
  rows = xlsx ? readXlsx(bytes) : parseCsv(decoded.text);
} catch (e) {
  if (xlsx) fail(`import: ${file}: ${(e as Error).message}; save it from the spreadsheet as CSV and import that`, `node scripts/import.mjs ${file.replace(/\.xlsx$/i, ".csv")} --dry-run`);
  fail(`import: ${file}: ${(e as Error).message}; fix it in the spreadsheet and save as CSV again`, again);
}
if (rows.length < 2) fail(`import: ${file} has no data rows under a header row`, again);
const headers = rows[0].map((h) => h.trim());
const map = guessMap(headers, cfg.fields);
for (const kv of (flag(a, "map") ?? "").split(",").filter(Boolean)) {
  const i = kv.indexOf("=");
  if (i < 1) misused(`import: --map ${kv}: write field=Header`, `${again} --map name=Name`);
  const field = kv.slice(0, i).trim();
  const header = kv.slice(i + 1).trim();
  if (!IMPORT_FIELDS.includes(field) && !cfg.fields.some((f) => f.key === field)) misused(`import: --map ${kv}: no field ${field}; fields: ${[...IMPORT_FIELDS, ...cfg.fields.map((f) => f.key)].join(", ")}`, again);
  if (!headers.includes(header)) misused(`import: --map ${kv}: no header "${header}"; headers are ${headers.join(", ")}`, again);
  for (const [f, h] of Object.entries(map)) if (h === header && f !== field) delete map[f];
  map[field] = header;
}
if (!map.name && !map.first_name && !map.email && !map.phone) fail(`import: no name, email or phone column found (headers: ${headers.join(", ")})`, `${again} --map name=<Header>`);

await withDb(async (db) => {
  const stages = await listStages(db, "customers");
  const stageArg = flag(a, "status");
  const def = (stageArg ? resolveStage(stages, stageArg) : await firstOpenStage(db, "customers")) ?? misused(`import: no status ${stageArg ?? ""}; statuses: ${stages.map((s) => s.key).join(", ")}`, "node scripts/stages.mjs list --statuses");
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
  done("import", dry ? `dry run of ${file}: nothing written` : `imported ${file}`, {
    lines: [
      ...(decoded.encoding !== "utf-8" ? [`note: the file is not UTF-8; read it as ${decoded.encoding}. Check the names with accents below.`] : []),
      "mapping: " + Object.entries(map).map(([f, h]) => `${f} <- "${h}"`).join(", "),
      ...(unmapped.length ? [`not imported: ${unmapped.map((h) => `"${h}"`).join(", ")} (--map field=Header to use one)`] : []),
      ...plan.warnings.map((w) => "note: " + w),
      ...(summary.skipped ? [`skipped ${summary.skipped} row(s) with no name, email or phone`] : []),
      `${summary.rows} rows: ${summary.created} new, ${summary.updated} existing updated, ${summary.unchanged} existing unchanged, ${summary.merged} folded into another row of the file`,
      ...summary.examples.map((e) => "  " + e),
    ],
    next: dry ? `show the owner the mapping, then: node scripts/import.mjs ${file}` : "node scripts/customers.mjs list",
  });
});
