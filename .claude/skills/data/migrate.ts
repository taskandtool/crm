// Applies a skill's schema.sql to the project's database: its create tables
// and indexes, each written to run again harmlessly (`if not exists`), since
// every app that carries the skill runs it at setup and when its service
// starts. Table names are plain, never schema-qualified, so every table lands
// in the one namespace every app reads.
//
// Machine only: run it from the app's setup or start script, never per request
// and never at the edge.
//
//   import { readFileSync } from "node:fs";
//   await applySchema(db, readFileSync("src/booking/schema.sql", "utf8"));
import { q, type Db, type Query } from "./db";

/** The statements in a schema file: comments dropped, split on semicolons outside quotes. */
export function statements(text: string): string[] {
  if (text.includes("$$")) throw new Error("schema files may not contain $$ bodies (functions, DO blocks)");
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        if (text[i + 1] === quote) cur += text[++i]; // a doubled quote stays inside
        else quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      cur += "\n";
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error("schema file has an unclosed quote");
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Apply a schema file in one transaction, behind a lock every app shares. */
export async function applySchema(db: Db, text: string): Promise<void> {
  const run: Query[] = [q`select pg_advisory_xact_lock(hashtext('taskandtool.schema'))`];
  for (const s of statements(text)) run.push({ text: s, values: [] });
  await db.transaction(run);
}
