// Applies a skill's schema.sql to the project's database. Every app that
// carries the skill runs it at setup and when its service starts, so it must
// be safe to run again, by any app, at any version of the skill.
//
// Two apps can carry different versions of the same skill, so tables only
// grow. A schema file may hold nothing but:
//
//   create table if not exists <name> (...)
//   create [unique] index if not exists <name> on <table> (...)
//   alter table <name> add column if not exists <column> ...
//   comment on ...
//
// Table names are plain, never schema-qualified, so every table lands in the
// one namespace every app reads. No drop, rename, type change, or added
// constraint (Postgres has no `add constraint if not exists`): a newer skill
// adds a column an older app ignores, and an older one never removes what a
// newer one needs. `applySchema` refuses a file that breaks this before
// running any of it.
//
// Machine only: run it from the app's setup or start script, never per request
// and never at the edge.
//
//   import { readFileSync } from "node:fs";
//   await applySchema(db, readFileSync("src/booking/schema.sql", "utf8"));
import { q, type Db, type Query } from "./db";

const ALLOWED = [
  /^create\s+table\s+if\s+not\s+exists\s+\w+\s*\(/i,
  /^create\s+(unique\s+)?index\s+if\s+not\s+exists\s+\w+\s+on\s+\w+(\s|\()/i,
  /^alter\s+table\s+(if\s+exists\s+)?\w+\s+add\s+column\s+if\s+not\s+exists\s+\w+\s/i,
  /^comment\s+on\s+/i,
];

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

/** Why a schema file is not additive; empty when it is. */
export function additiveProblems(text: string): string[] {
  let list: string[];
  try {
    list = statements(text);
  } catch (e) {
    return [(e as Error).message];
  }
  const problems: string[] = [];
  for (const s of list) {
    const head = s.replace(/\s+/g, " ").slice(0, 80);
    if (!ALLOWED.some((re) => re.test(s))) problems.push(`not additive: ${head}`);
    else if (/\b(drop|rename)\b/i.test(s) || /\balter\s+column\b/i.test(s)) problems.push(`changes what exists: ${head}`);
  }
  return problems;
}

/** Apply a schema file in one transaction, behind a lock every app shares. */
export async function applySchema(db: Db, text: string): Promise<void> {
  const problems = additiveProblems(text);
  if (problems.length) throw new Error("schema refused:\n  " + problems.join("\n  "));
  const run: Query[] = [q`select pg_advisory_xact_lock(hashtext('taskandtool.schema'))`];
  for (const s of statements(text)) run.push({ text: s, values: [] });
  await db.transaction(run);
}
