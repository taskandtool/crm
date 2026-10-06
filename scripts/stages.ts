// The pipeline's stages from chat: the same changes as the /stages page.
// `node scripts/stages.mjs --help`.
import { STAGE_KINDS } from "../src/config-schema";
import { addStage, archiveStage, editStage, moveStage, pickKind, resolveStage, restoreStage, stagesWithCounts, KIND_LABELS, type StageResult } from "../src/crm/stages";
import { done, fail, flag, has, misused, noMore, out, parseArgs, run, usage, who, withDb } from "./lib";

const HELP = `stages.mjs <command> [--json] [--as <email>]

  list                              stages in order, with their kind and how many customers each holds
  add "<label>" [--kind open|won|lost]
  rename <stage> "<label>"
  kind <stage> <open|won|lost>
  move <stage> up|down
  archive <stage> [--move-to <stage>]   refused while customers are in it, unless --move-to
  restore <stage>

<stage> is a key or a label. There is always at least one open stage: new
customers land in the first one.

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = { list: [], add: ["kind", "as"], rename: ["as"], kind: ["as"], move: ["as"], archive: ["move-to", "as"], restore: ["as"] };
const WORDS: Record<string, number> = { list: 0, kind: 2, move: 2, archive: 1, restore: 1 };

const a = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "stages", FLAGS);
const at = `stages ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const json = has(a, "json");
const LIST = "node scripts/stages.mjs list";

const WHY: Record<string, string> = {
  missing: "no such stage",
  "last-open": "that would leave no open stage; new customers need one to land in",
  "in-use": "customers are still in that stage; pass --move-to <stage>",
  "bad-target": "--move-to must name another active stage",
  label: "a stage needs a label",
};

await withDb(async (db) => {
  const user = who(a);
  const all = await stagesWithCounts(db);
  const names = all.map((s) => `${s.key} (${s.label})`).join(", ");
  const find = (v: string | undefined) => resolveStage(all, v) ?? (v ? fail(`${at}: no stage ${v}; stages: ${names}`, LIST) : misused(`${at}: name a stage by key or label; stages: ${names}`, LIST));
  const said = (what: string) => (json ? out(true, { ok: true, message: what }, String) : done(at, what, { next: LIST }));
  const result = (r: StageResult, what: string) => (r.ok ? said(what) : fail(`${at}: ${WHY[r.reason]}${r.count ? ` (${r.count})` : ""}`, r.reason === "in-use" ? `${run(at)} ${rest[0]} --move-to <stage>` : LIST));
  switch (cmd) {
    case "list":
      if (json) return out(true, all, String);
      return done(at, `${all.filter((s) => !s.archived).length} stages in order, then any archived`, {
        lines: all.map((s) => `${s.archived ? "archived" : String(s.position).padStart(3)}  ${s.key}  ${s.label}  [${KIND_LABELS[s.kind]}]  ${s.customers} customers`),
      });
    case "add": {
      const label = rest.join(" ").trim() || misused(`${at}: it needs a label`, 'node scripts/stages.mjs add "Quoted"');
      const kind = pickKind(flag(a, "kind") ?? "open") ?? misused(`${at}: --kind must be ${STAGE_KINDS.join(", ")}`, `node scripts/stages.mjs add "${label}" --kind open`);
      const same = resolveStage(all, label);
      if (same) return said(`${same.key} (${same.label}) is already a stage${same.archived ? ", archived; restore it instead" : ""}; left alone`);
      const r = await addStage(db, label, kind, user);
      return result(r, `added ${r.ok ? `${r.stage?.key} (${r.stage?.label})` : ""}`);
    }
    case "rename": {
      const s = find(rest[0]);
      const label = rest.slice(1).join(" ").trim() || misused(`${at}: rename to what?`, `node scripts/stages.mjs rename ${s.key} "New label"`);
      if (label === s.label) return said(`${s.key} is already ${label}; left alone`);
      return result(await editStage(db, s.key, { label }, user), `renamed ${s.key}: ${s.label} -> ${label}`);
    }
    case "kind": {
      const s = find(rest[0]);
      const kind = pickKind(rest[1]) ?? misused(`${at}: kind must be ${STAGE_KINDS.join(", ")}`, `node scripts/stages.mjs kind ${s.key} won`);
      if (kind === s.kind) return said(`${s.key} is already ${kind}; left alone`);
      return result(await editStage(db, s.key, { kind }, user), `${s.key} is now ${kind}`);
    }
    case "move": {
      const s = find(rest[0]);
      const dir = rest[1];
      if (dir !== "up" && dir !== "down") misused(`${at}: up or down?`, `node scripts/stages.mjs move ${s.key} up`);
      const active = all.filter((x) => !x.archived);
      if (s.archived || active[dir === "up" ? 0 : active.length - 1]?.key === s.key) return said(`${s.key} is already ${s.archived ? "archived" : dir === "up" ? "first" : "last"}; left alone`);
      return result(await moveStage(db, s.key, dir, user), `moved ${s.key} ${dir}`);
    }
    case "archive": {
      const s = find(rest[0]);
      if (s.archived) return said(`${s.key} is already archived; left alone`);
      const to = flag(a, "move-to");
      const target = to ? find(to).key : null;
      return result(await archiveStage(db, s.key, target, user), `archived ${s.key}${target ? `; its customers moved to ${target}` : ""}`);
    }
    case "restore": {
      const s = find(rest[0]);
      if (!s.archived) return said(`${s.key} is already active; left alone`);
      return result(await restoreStage(db, s.key, user), `restored ${s.key}`);
    }
  }
});
