// Two ordered lists of stages, the same shape and the same rules: a
// customer's statuses (`pipeline_stages`, read by customers.stage) and the
// deal pipeline (`deal_stages`, read by deals.stage). Both are rows the owner
// edits on /stages or the AI with scripts/stages.mjs; crm.config.json seeds
// each on the very first run only, and after that the rows are the truth. A
// stage is never deleted, only archived, and only once nothing is in it.
// Each list always keeps at least one open stage, where new rows land.
import { q, type Db, type Query } from "../data/db";
import type { StageConfig, StageKind } from "../config-schema";
import { STAGE_KINDS } from "../config-schema";
import { slugify } from "./text";

/** Which list: a customer's statuses, or the deal pipeline. */
export type Pipeline = "customers" | "deals";
export const PIPELINES: Pipeline[] = ["customers", "deals"];

export type Stage = { key: string; label: string; position: number; kind: StageKind; archived: boolean };
export type StageWithCount = Stage & { count: number };

export const KIND_LABELS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };
export const pickKind = (v: unknown): StageKind | null => (STAGE_KINDS.includes(v as StageKind) ? (v as StageKind) : null);
export const pickPipeline = (v: unknown): Pipeline | null => (PIPELINES.includes(v as Pipeline) ? (v as Pipeline) : null);

// The two lists differ only in their tables, so each statement is written
// once with `{stages}` and `{items}` in its text, filled from this fixed
// pair, never from input. Values stay parameters.
const TABLES: Record<Pipeline, { stages: string; items: string }> = {
  customers: { stages: "pipeline_stages", items: "customers" },
  deals: { stages: "deal_stages", items: "deals" },
};

function fill(p: Pipeline, strings: TemplateStringsArray): TemplateStringsArray {
  const t = TABLES[p];
  const out = strings.map((s) => s.replaceAll("{stages}", t.stages).replaceAll("{items}", t.items));
  return Object.assign(out, { raw: out });
}
const sqlOn = (db: Db, p: Pipeline) => <T extends Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]) => db.sql<T>(fill(p, strings), ...values);
const qOn = (p: Pipeline) => (strings: TemplateStringsArray, ...values: unknown[]): Query => q(fill(p, strings), ...values);

export async function listStages(db: Db, p: Pipeline, opts: { archived?: boolean } = {}): Promise<Stage[]> {
  return sqlOn(db, p)<Stage>`
    select key, label, position, kind, archived from {stages}
    where (${opts.archived ?? false}::boolean or not archived)
    order by archived, position, key`;
}

/** Every stage, archived ones last, with how many rows (archived ones too) are in each. */
export async function stagesWithCounts(db: Db, p: Pipeline): Promise<StageWithCount[]> {
  return sqlOn(db, p)<StageWithCount>`
    select s.key, s.label, s.position, s.kind, s.archived, count(i.id)::int as count
    from {stages} s left join {items} i on i.stage = s.key
    group by s.key
    order by s.archived, s.position, s.key`;
}

/** The stage a new row lands in: the first open one. */
export async function firstOpenStage(db: Db, p: Pipeline): Promise<Stage | null> {
  const [s] = await sqlOn(db, p)<Stage>`
    select key, label, position, kind, archived from {stages}
    where not archived and kind = 'open' order by position, key limit 1`;
  return s ?? null;
}

/** The first active stage of a kind: where a won deal's customer goes, where a quote's yes takes its deal. */
export async function firstOfKind(db: Db, p: Pipeline, kind: StageKind): Promise<Stage | null> {
  const [s] = await sqlOn(db, p)<Stage>`
    select key, label, position, kind, archived from {stages}
    where not archived and kind = ${kind} order by position, key limit 1`;
  return s ?? null;
}

/** A stage by key or by label, case-blind, from a list. */
export function resolveStage(list: Stage[], v: string | null | undefined): Stage | undefined {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return list.find((x) => x.key === s) ?? list.find((x) => x.label.toLowerCase() === s);
}

// Seeds the configured stages into an empty table, once. A table that has
// any row (even archived ones) is the owner's and is left alone, so editing
// the config's stages later does nothing to a running CRM.
export async function seedStages(db: Db, p: Pipeline, stages: StageConfig[]): Promise<number> {
  const rows = await sqlOn(db, p)`
    insert into {stages} (key, label, position, kind)
    select s.key, s.label, s.position, s.kind
    from unnest(${stages.map((s) => s.key)}::text[], ${stages.map((s) => s.label)}::text[],
                ${stages.map((_, i) => i)}::int[], ${stages.map((s) => s.kind ?? "open")}::text[]) as s(key, label, position, kind)
    where not exists (select 1 from {stages})
    on conflict (key) do nothing
    returning key`;
  return rows.length;
}

// Every change that could leave a list with no open stage runs behind its lock.
const lockOf = (p: Pipeline) => q`select pg_advisory_xact_lock(hashtext(${"crm." + TABLES[p].stages}::text))`;

export type StageResult = { ok: true; stage?: Stage } | { ok: false; reason: "missing" | "last-open" | "in-use" | "bad-target" | "label"; count?: number };

export async function addStage(db: Db, p: Pipeline, label: string, kind: StageKind, user: string): Promise<StageResult> {
  const name = label.trim().slice(0, 60);
  if (!name) return { ok: false, reason: "label" };
  const taken = new Set((await sqlOn(db, p)<{ key: string }>`select key from {stages}`).map((r) => r.key));
  const base = slugify(name);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  const [stage] = await sqlOn(db, p)<Stage>`
    insert into {stages} (key, label, position, kind, updated_by)
    values (${key}, ${name}, (select coalesce(max(position), -1) + 1 from {stages}), ${kind}, ${user})
    on conflict (key) do nothing
    returning key, label, position, kind, archived`;
  return stage ? { ok: true, stage } : addStage(db, p, `${name} ${Date.now() % 1000}`, kind, user);
}

/** Rename and/or change a stage's kind. Refuses to leave no open stage. */
export async function editStage(db: Db, p: Pipeline, key: string, patch: { label?: string | null; kind?: StageKind | null }, user: string): Promise<StageResult> {
  const label = patch.label?.trim().slice(0, 60) || null;
  const kind = patch.kind ?? null;
  // Under the list's lock, so two edits at once cannot each see the other's
  // open stage and leave none.
  const [, [stage]] = (await db.transaction([
    lockOf(p),
    qOn(p)`update {stages} set
        label = coalesce(${label}::text, label),
        kind = coalesce(${kind}::text, kind),
        updated_by = ${user}, updated_at = now()
      where key = ${key}
        and (coalesce(${kind}::text, kind) = 'open' or archived
             or exists (select 1 from {stages} o where o.key <> ${key} and not o.archived and o.kind = 'open'))
      returning key, label, position, kind, archived`,
  ])) as [unknown, Stage[]];
  if (stage) return { ok: true, stage };
  return (await exists(db, p, key)) ? { ok: false, reason: "last-open" } : { ok: false, reason: "missing" };
}

/** Swap a stage with its neighbour among the active stages. */
export async function moveStage(db: Db, p: Pipeline, key: string, dir: "up" | "down", user: string): Promise<StageResult> {
  if (!(await exists(db, p, key))) return { ok: false, reason: "missing" };
  // Positions are compacted first, so a swap always has two distinct numbers
  // to trade even if another app wrote duplicates.
  await db.transaction([
    qOn(p)`update {stages} s set position = r.n
      from (select key, (row_number() over (order by archived, position, key))::int - 1 as n from {stages}) r
      where s.key = r.key and s.position <> r.n`,
    qOn(p)`with cur as (select key, position from {stages} where key = ${key} and not archived),
      nb as (
        select s.key, s.position from {stages} s, cur
        where not s.archived and s.key <> cur.key
          and ((${dir} = 'up' and s.position < cur.position) or (${dir} = 'down' and s.position > cur.position))
        order by case when ${dir} = 'up' then -s.position else s.position end
        limit 1)
      update {stages} s
      set position = case when s.key = (select key from cur) then (select position from nb) else (select position from cur) end,
          updated_by = ${user}, updated_at = now()
      where s.key in ((select key from cur), (select key from nb))
        and exists (select 1 from nb)`,
  ]);
  return { ok: true };
}

/**
 * Archive a stage. Refused while rows are in it, unless `moveTo` names
 * another active stage to move them to first (in the same transaction), and
 * refused when it is the last open stage.
 */
export async function archiveStage(db: Db, p: Pipeline, key: string, moveTo: string | null, user: string): Promise<StageResult> {
  const all = await stagesWithCounts(db, p);
  const stage = all.find((s) => s.key === key && !s.archived);
  if (!stage) return { ok: false, reason: "missing" };
  if (stage.kind === "open" && !all.some((s) => s.key !== key && !s.archived && s.kind === "open")) return { ok: false, reason: "last-open" };
  const target = moveTo ? all.find((s) => s.key === moveTo && !s.archived && s.key !== key) : null;
  if (moveTo && !target) return { ok: false, reason: "bad-target" };
  if (stage.count > 0 && !target) return { ok: false, reason: "in-use", count: stage.count };
  // The checks above are for the message; these statements decide, under the
  // list's lock, so a stage archived or turned won meanwhile (another tab,
  // a script) cannot leave the list with no open stage, and rows are only
  // moved when the archive is still allowed.
  const [, , archived] = await db.transaction([
    lockOf(p),
    qOn(p)`update {items} set stage = ${target?.key ?? key}, updated_at = now(), updated_by = ${user}
      where stage = ${key} and ${target?.key ?? null}::text is not null
        and exists (select 1 from {stages} where key = ${target?.key ?? null}::text and not archived)
        and ((select kind from {stages} where key = ${key}) <> 'open'
             or exists (select 1 from {stages} o where o.key <> ${key} and not o.archived and o.kind = 'open'))`,
    // Guarded again in SQL: a row moved in since the count keeps it open.
    qOn(p)`update {stages} set archived = true, updated_by = ${user}, updated_at = now()
      where key = ${key} and not archived and not exists (select 1 from {items} where stage = ${key})
        and (kind <> 'open' or exists (select 1 from {stages} o where o.key <> ${key} and not o.archived and o.kind = 'open'))
      returning key`,
  ]);
  if (archived.length) return { ok: true };
  const now = await stagesWithCounts(db, p);
  const lastOpen = now.find((s) => s.key === key)?.kind === "open" && !now.some((s) => s.key !== key && !s.archived && s.kind === "open");
  return { ok: false, reason: lastOpen ? "last-open" : "in-use" };
}

/** Bring an archived stage back, at the end. */
export async function restoreStage(db: Db, p: Pipeline, key: string, user: string): Promise<StageResult> {
  const rows = await sqlOn(db, p)`
    update {stages}
    set archived = false, position = (select coalesce(max(position), -1) + 1 from {stages} where not archived),
        updated_by = ${user}, updated_at = now()
    where key = ${key} and archived
    returning key`;
  return rows.length ? { ok: true } : { ok: false, reason: "missing" };
}

async function exists(db: Db, p: Pipeline, key: string): Promise<boolean> {
  return (await sqlOn(db, p)`select 1 from {stages} where key = ${key}`).length > 0;
}
