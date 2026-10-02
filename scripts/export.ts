// CSV out: customers (the same columns as the page's export, which
// scripts/import.mjs reads back), to stdout or --out. Formula cells are
// defused. `node scripts/export.mjs --help`.
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { csvCell, csvLine } from "../src/admin/csv";
import { everyPage } from "../src/admin/keyset";
import { cfg } from "../src/config";
import { csvColumns } from "../src/crm/columns";
import { listPage, NO_FILTER } from "../src/crm/customers";
import { listStages, resolveStage } from "../src/crm/stages";
import { fail, flag, has, parseArgs, withDb } from "./lib";

const HELP = `export.mjs [--out customers.csv] [--stage s] [--tag t] [--owner o] [--archived] [--search text]

Writes customers as CSV (UTF-8 with a BOM, so Excel reads it), active ones
unless --archived, filtered like the list. Without --out it prints to stdout.`;

const a = parseArgs(process.argv.slice(2));
if (has(a, "help")) {
  console.log(HELP);
  process.exit(0);
}

// `export.mjs | head` closes the pipe early: that is the reader's choice, not a failure.
process.stdout.on("error", (e: NodeJS.ErrnoException) => process.exit(e.code === "EPIPE" ? 0 : 1));

await withDb(async (db) => {
  const stages = await listStages(db, { archived: true });
  const stageArg = flag(a, "stage");
  const st = stageArg ? resolveStage(stages, stageArg) : undefined;
  if (stageArg && !st) fail(`no stage ${stageArg}`);
  const f = { ...NO_FILTER, q: flag(a, "search") ?? null, stage: st?.key ?? null, tag: flag(a, "tag") ?? null, owner: flag(a, "owner") ?? null, archived: has(a, "archived") };
  const columns = csvColumns(new Map(stages.map((s) => [s.key, s.label])), cfg.fields);
  const target = flag(a, "out");
  const sink = target ? createWriteStream(resolve(process.env.CALLER_CWD ?? ".", target)) : process.stdout;
  const write = (s: string) => new Promise<void>((ok) => (sink.write(s) ? ok() : sink.once("drain", () => ok())));
  await write("\uFEFF" + columns.map((c) => csvCell(c.label)).join(",") + "\r\n");
  let n = 0;
  for await (const row of everyPage((after, size) => listPage(db, f, after, size))) {
    await write(csvLine(columns, row));
    n++;
  }
  if (target) {
    await new Promise<void>((ok) => (sink as ReturnType<typeof createWriteStream>).end(() => ok()));
    console.error(`wrote ${n} customers to ${target}`);
  }
});
