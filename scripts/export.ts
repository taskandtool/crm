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
import { done, fail, flag, has, misused, parseArgs, plain, withDb } from "./lib";

const HELP = `export.mjs [--out customers.csv] [--stage s] [--tag t] [--owner o] [--archived] [--search text]

Writes customers as CSV (UTF-8 with a BOM, so Excel reads it), active ones
unless --archived, filtered like the list. Without --out it prints the CSV
to stdout; with it, "export: wrote N customers to <path>". Errors go to
stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const a = parseArgs(process.argv.slice(2), { bare: ["archived"] });
plain(a, HELP, "export", { flags: ["out", "stage", "tag", "owner", "archived", "search"] });

// `export.mjs | head` closes the pipe early: that is the reader's choice, not a failure.
process.stdout.on("error", (e: NodeJS.ErrnoException) => process.exit(e.code === "EPIPE" ? 0 : 1));

await withDb(async (db) => {
  const stages = await listStages(db, { archived: true });
  const stageArg = flag(a, "stage");
  const st = stageArg ? resolveStage(stages, stageArg) : undefined;
  if (stageArg && !st) misused(`export: no stage ${stageArg}; stages: ${stages.map((s) => s.key).join(", ")}`, "node scripts/stages.mjs list");
  const f = { ...NO_FILTER, q: flag(a, "search") ?? null, stage: st?.key ?? null, tag: flag(a, "tag") ?? null, owner: flag(a, "owner") ?? null, archived: has(a, "archived") };
  const columns = csvColumns(new Map(stages.map((s) => [s.key, s.label])), cfg.fields);
  const target = flag(a, "out");
  const path = target ? resolve(process.env.CALLER_CWD ?? ".", target) : "";
  const sink = target ? createWriteStream(path) : process.stdout;
  if (target) sink.on("error", (e: NodeJS.ErrnoException) => fail(`export: cannot write ${path}: ${e.code ?? e.message}`, "node scripts/export.mjs --out customers.csv"));
  const write = (s: string) => new Promise<void>((ok) => (sink.write(s) ? ok() : sink.once("drain", () => ok())));
  await write("﻿" + columns.map((c) => csvCell(c.label)).join(",") + "\r\n");
  let n = 0;
  for await (const row of everyPage((after, size) => listPage(db, f, after, size))) {
    await write(csvLine(columns, row));
    n++;
  }
  if (target) {
    await new Promise<void>((ok) => (sink as ReturnType<typeof createWriteStream>).end(() => ok()));
    done("export", `wrote ${n} customers to ${path}`, { next: `head -3 ${path}` });
  }
});
