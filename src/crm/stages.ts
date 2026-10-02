// The pipeline's stages are rows in `pipeline_stages`, edited by the owner on
// /stages or by the AI with scripts/stages.mjs. crm.config.json seeds them on
// the very first run only; after that the rows are the truth. A stage is
// never deleted, only archived, and only once no customer is in it. There
// is always at least one open stage, where new people land.
import { q, type Db } from "../data/db";
import type { StageConfig, StageKind } from "../config-schema";
import { STAGE_KINDS } from "../config-schema";
import { slugify } from "./text";

export type Stage = { key: string; label: string; position: number; kind: StageKind; archived: boolean };
export type StageWithCount = Stage & { customers: number };

export const KIND_LABELS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };
export const pickKind = (v: unknown): StageKind | null => (STAGE_KINDS.includes(v as StageKind) ? (v as StageKind) : null);

export async function listStages(db: Db, opts: { archived?: boolean } = {}): Promise<Stage[]> {
  return db.sql<Stage>`
    select key, label, position, kind, archived from pipeline_stages
    where (${opts.archived ?? false}::boolean or not archived)
    order by archived, position, key`;
}

/** Every stage, archived ones last, with how many customers (archived ones too) are in each. */
export async function stagesWithCounts(db: Db): Promise<StageWithCount[]> {
  return db.sql<StageWithCount>`
    select s.key, s.label, s.position, s.kind, s.archived, count(c.id)::int as customers
    from pipeline_stages s left join customers c on c.stage = s.key
    group by s.key
    order by s.archived, s.position, s.key`;
}

/** The stage a new person lands in: the first open one. */
export async function firstOpenStage(db: Db): Promise<Stage | null> {
  const [s] = await db.sql<Stage>`
    select key, label, position, kind, archived from pipeline_stages
    where not archived and kind = 'open' order by position, key limit 1`;
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
// the config's stages later does nothing to a running CRM: that is lever 2.
export async function seedStages(db: Db, stages: StageConfig[]): Promise<number> {
  const rows = await db.sql`
    insert into pipeline_stages (key, label, position, kind)
    select s.key, s.label, s.position, s.kind
    from unnest(${stages.map((s) => s.key)}::text[], ${stages.map((s) => s.label)}::text[],
                ${stages.map((_, i) => i)}::int[], ${stages.map((s) => s.kind ?? "open")}::text[]) as s(key, label, position, kind)
    where not exists (select 1 from pipeline_stages)
    on conflict (key) do nothing
    returning key`;
  return rows.length;
}

// Every change that could leave no open stage runs behind this lock.
const STAGE_LOCK = q`select pg_advisory_xact_lock(hashtext('crm.pipeline_stages'))`;

export type StageResult = { ok: true; stage?: Stage } | { ok: false; reason: "missing" | "last-open" | "in-use" | "bad-target" | "label"; count?: number };

export async function addStage(db: Db, label: string, kind: StageKind, user: string): Promise<StageResult> {
  const name = label.trim().slice(0, 60);
  if (!name) return { ok: false, reason: "label" };
  const taken = new Set((await db.sql<{ key: string }>`select key from pipeline_stages`).map((r) => r.key));
  const base = slugify(name);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  const [stage] = await db.sql<Stage>`
    insert into pipeline_stages (key, label, position, kind, updated_by)
    values (${key}, ${name}, (select coalesce(max(position), -1) + 1 from pipeline_stages), ${kind}, ${user})
    on conflict (key) do nothing
    returning key, label, position, kind, archived`;
  return stage ? { ok: true, stage } : addStage(db, `${name} ${Date.now() % 1000}`, kind, user);
}

/** Rename and/or change a stage's kind. Refuses to leave no open stage. */
export async function editStage(db: Db, key: string, patch: { label?: string | null; kind?: StageKind | null }, user: string): Promise<StageResult> {
  const label = patch.label?.trim().slice(0, 60) || null;
  const kind = patch.kind ?? null;
  // Under the stages lock (STAGE_LOCK), so two edits at once cannot each
  // see the other's open stage and leave none.
  const [, [stage]] = (await db.transaction([
    STAGE_LOCK,
    q`update pipeline_stages set
        label = coalesce(${label}::text, label),
        kind = coalesce(${kind}::text, kind),
        updated_by = ${user}, updated_at = now()
      where key = ${key}
        and (coalesce(${kind}::text, kind) = 'open' or archived
             or exists (select 1 from pipeline_stages o where o.key <> ${key} and not o.archived and o.kind = 'open'))
      returning key, label, position, kind, archived`,
  ])) as [unknown, Stage[]];
  if (stage) return { ok: true, stage };
  return (await exists(db, key)) ? { ok: false, reason: "last-open" } : { ok: false, reason: "missing" };
}

/** Swap a stage with its neighbour among the active stages. */
export async function moveStage(db: Db, key: string, dir: "up" | "down", user: string): Promise<StageResult> {
  if (!(await exists(db, key))) return { ok: false, reason: "missing" };
  // Positions are compacted first, so a swap always has two distinct numbers
  // to trade even if another app wrote duplicates.
  await db.transaction([
    q`update pipeline_stages p set position = r.n
      from (select key, (row_number() over (order by archived, position, key))::int - 1 as n from pipeline_stages) r
      where p.key = r.key and p.position <> r.n`,
    q`with cur as (select key, position from pipeline_stages where key = ${key} and not archived),
      nb as (
        select s.key, s.position from pipeline_stages s, cur
        where not s.archived and s.key <> cur.key
          and ((${dir} = 'up' and s.position < cur.position) or (${dir} = 'down' and s.position > cur.position))
        order by case when ${dir} = 'up' then -s.position else s.position end
        limit 1)
      update pipeline_stages p
      set position = case when p.key = (select key from cur) then (select position from nb) else (select position from cur) end,
          updated_by = ${user}, updated_at = now()
      where p.key in ((select key from cur), (select key from nb))
        and exists (select 1 from nb)`,
  ]);
  return { ok: true };
}

/**
 * Archive a stage. Refused while customers are in it, unless `moveTo` names
 * another active stage to move them to first (in the same transaction), and
 * refused when it is the last open stage.
 */
export async function archiveStage(db: Db, key: string, moveTo: string | null, user: string): Promise<StageResult> {
  const all = await stagesWithCounts(db);
  const stage = all.find((s) => s.key === key && !s.archived);
  if (!stage) return { ok: false, reason: "missing" };
  if (stage.kind === "open" && !all.some((s) => s.key !== key && !s.archived && s.kind === "open")) return { ok: false, reason: "last-open" };
  const target = moveTo ? all.find((s) => s.key === moveTo && !s.archived && s.key !== key) : null;
  if (moveTo && !target) return { ok: false, reason: "bad-target" };
  if (stage.customers > 0 && !target) return { ok: false, reason: "in-use", count: stage.customers };
  // The checks above are for the message; these statements decide, under the
  // stages lock, so a stage archived or turned won meanwhile (another tab,
  // a script) cannot leave the pipeline with no open stage, and customers
  // are only moved when the archive is still allowed.
  const [, , archived] = await db.transaction([
    STAGE_LOCK,
    q`update customers set stage = ${target?.key ?? key}, updated_at = now(), updated_by = ${user}
      where stage = ${key} and ${target?.key ?? null}::text is not null
        and exists (select 1 from pipeline_stages where key = ${target?.key ?? null}::text and not archived)
        and ((select kind from pipeline_stages where key = ${key}) <> 'open'
             or exists (select 1 from pipeline_stages o where o.key <> ${key} and not o.archived and o.kind = 'open'))`,
    // Guarded again in SQL: a customer moved in since the count keeps it open.
    q`update pipeline_stages set archived = true, updated_by = ${user}, updated_at = now()
      where key = ${key} and not archived and not exists (select 1 from customers where stage = ${key})
        and (kind <> 'open' or exists (select 1 from pipeline_stages o where o.key <> ${key} and not o.archived and o.kind = 'open'))
      returning key`,
  ]);
  if (archived.length) return { ok: true };
  const now = await stagesWithCounts(db);
  const lastOpen = now.find((s) => s.key === key)?.kind === "open" && !now.some((s) => s.key !== key && !s.archived && s.kind === "open");
  return { ok: false, reason: lastOpen ? "last-open" : "in-use" };
}

/** Bring an archived stage back, at the end. */
export async function restoreStage(db: Db, key: string, user: string): Promise<StageResult> {
  const rows = await db.sql`
    update pipeline_stages
    set archived = false, position = (select coalesce(max(position), -1) + 1 from pipeline_stages where not archived),
        updated_by = ${user}, updated_at = now()
    where key = ${key} and archived
    returning key`;
  return rows.length ? { ok: true } : { ok: false, reason: "missing" };
}

async function exists(db: Db, key: string): Promise<boolean> {
  return (await db.sql`select 1 from pipeline_stages where key = ${key}`).length > 0;
}
