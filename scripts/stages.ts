// The deal pipeline's stages, or with --statuses a customer's statuses, from
// chat: the same changes as the /stages page. `node scripts/stages.mjs --help`.
import { dealsCfg, vocab } from "../src/config";
import { STAGE_KINDS } from "../src/config-schema";
import { addStage, archiveStage, editStage, moveStage, pickKind, resolveStage, restoreStage, stagesWithCounts, KIND_LABELS, type StageResult } from "../src/crm/stages";
import { done, fail, flag, has, misused, noMore, out, parseArgs, run, usage, who, withDb } from "./lib";

const HELP = `stages.mjs <command> [--statuses] [--json] [--as <email>]

  list                              stages in order, with their kind and how many each holds
  add "<label>" [--kind open|won|lost]
  rename <stage> "<label>"
  kind <stage> <open|won|lost>
  move <stage> up|down
  archive <stage> [--move-to <stage>]   refused while anything is in it, unless --move-to
  restore <stage>

Without --statuses these are the ${dealsCfg.one.toLowerCase()} pipeline's stages; with it, a
${vocab.one.toLowerCase()}'s statuses (Lead, Customer, Not a fit). <stage> is a key or a
label. Each list keeps at least one open stage: new ones land in the first.

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const COMMON = ["statuses", "as"];
const FLAGS: Record<string, string[]> = {
  list: ["statuses"], add: ["kind", ...COMMON], rename: COMMON, kind: COMMON, move: COMMON, archive: ["move-to", ...COMMON], restore: COMMON,
};
const WORDS: Record<string, number> = { list: 0, kind: 2, move: 2, archive: 1, restore: 1 };

const a = parseArgs(process.argv.slice(2), { bare: ["statuses"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "stages", FLAGS);
const at = `stages ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const json = has(a, "json");
const p = has(a, "statuses") ? "customers" : "deals";
const opt = p === "customers" ? " --statuses" : "";
const LIST = `node scripts/stages.mjs list${opt}`;
const [one, many] = p === "customers" ? [vocab.one.toLowerCase(), vocab.many.toLowerCase()] : [dealsCfg.one.toLowerCase(), dealsCfg.many.toLowerCase()];
const thing = p === "customers" ? "status" : "stage";

const WHY: Record<string, string> = {
  missing: `no such ${thing}`,
  "last-open": `that would leave no open ${thing}; new ${many} need one to land in`,
  "in-use": `${many} are still in it; pass --move-to <${thing}>`,
  "bad-target": `--move-to must name another active ${thing}`,
  label: `a ${thing} needs a label`,
};

await withDb(async (db) => {
  const user = who(a);
  const all = await stagesWithCounts(db, p);
  const names = all.map((s) => `${s.key} (${s.label})`).join(", ");
  const find = (v: string | undefined) => resolveStage(all, v) ?? (v ? fail(`${at}: no ${thing} ${v}; ${thing === "status" ? "statuses" : "stages"}: ${names}`, LIST) : misused(`${at}: name a ${thing} by key or label; ${thing === "status" ? "statuses" : "stages"}: ${names}`, LIST));
  const said = (what: string) => (json ? out(true, { ok: true, message: what }, String) : done(at, what, { next: LIST }));
  const result = (r: StageResult, what: string) => (r.ok ? said(what) : fail(`${at}: ${WHY[r.reason]}${r.count ? ` (${r.count})` : ""}`, r.reason === "in-use" ? `${run(at)} ${rest[0]} --move-to <${thing}>${opt}` : LIST));
  switch (cmd) {
    case "list":
      if (json) return out(true, all, String);
      return done(at, `${all.filter((s) => !s.archived).length} ${p === "customers" ? `${one} statuses` : `${one} stages`} in order, then any archived`, {
        lines: all.map((s) => `${s.archived ? "archived" : String(s.position).padStart(3)}  ${s.key}  ${s.label}  [${KIND_LABELS[s.kind]}]  ${s.count} ${s.count === 1 ? one : many}`),
      });
    case "add": {
      const label = rest.join(" ").trim() || misused(`${at}: it needs a label`, `node scripts/stages.mjs add "Quoted"${opt}`);
      const kind = pickKind(flag(a, "kind") ?? "open") ?? misused(`${at}: --kind must be ${STAGE_KINDS.join(", ")}`, `node scripts/stages.mjs add "${label}" --kind open${opt}`);
      const same = resolveStage(all, label);
      if (same) return said(`${same.key} (${same.label}) is already a ${thing}${same.archived ? ", archived; restore it instead" : ""}; left alone`);
      const r = await addStage(db, p, label, kind, user);
      return result(r, `added ${r.ok ? `${r.stage?.key} (${r.stage?.label})` : ""}`);
    }
    case "rename": {
      const s = find(rest[0]);
      const label = rest.slice(1).join(" ").trim() || misused(`${at}: rename to what?`, `node scripts/stages.mjs rename ${s.key} "New label"${opt}`);
      if (label === s.label) return said(`${s.key} is already ${label}; left alone`);
      return result(await editStage(db, p, s.key, { label }, user), `renamed ${s.key}: ${s.label} -> ${label}`);
    }
    case "kind": {
      const s = find(rest[0]);
      const kind = pickKind(rest[1]) ?? misused(`${at}: kind must be ${STAGE_KINDS.join(", ")}`, `node scripts/stages.mjs kind ${s.key} won${opt}`);
      if (kind === s.kind) return said(`${s.key} is already ${kind}; left alone`);
      return result(await editStage(db, p, s.key, { kind }, user), `${s.key} is now ${kind}`);
    }
    case "move": {
      const s = find(rest[0]);
      const dir = rest[1];
      if (dir !== "up" && dir !== "down") misused(`${at}: up or down?`, `node scripts/stages.mjs move ${s.key} up${opt}`);
      const active = all.filter((x) => !x.archived);
      if (s.archived || active[dir === "up" ? 0 : active.length - 1]?.key === s.key) return said(`${s.key} is already ${s.archived ? "archived" : dir === "up" ? "first" : "last"}; left alone`);
      return result(await moveStage(db, p, s.key, dir, user), `moved ${s.key} ${dir}`);
    }
    case "archive": {
      const s = find(rest[0]);
      if (s.archived) return said(`${s.key} is already archived; left alone`);
      const to = flag(a, "move-to");
      const target = to ? find(to).key : null;
      return result(await archiveStage(db, p, s.key, target, user), `archived ${s.key}${target ? `; its ${many} moved to ${target}` : ""}`);
    }
    case "restore": {
      const s = find(rest[0]);
      if (!s.archived) return said(`${s.key} is already active; left alone`);
      return result(await restoreStage(db, p, s.key, user), `restored ${s.key}`);
    }
  }
});
