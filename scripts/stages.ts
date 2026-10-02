// The pipeline's stages from chat: the same changes as the /stages page.
// `node scripts/stages.mjs --help`.
import { STAGE_KINDS } from "../src/config-schema";
import { addStage, archiveStage, editStage, moveStage, pickKind, resolveStage, restoreStage, stagesWithCounts, KIND_LABELS, type StageResult } from "../src/crm/stages";
import { fail, flag, has, out, parseArgs, who, withDb } from "./lib";

const HELP = `stages.mjs <command> [--json] [--as <email>]

  list                              stages in order, with their kind and how many customers each holds
  add "<label>" [--kind open|won|lost]
  rename <stage> "<label>"
  kind <stage> <open|won|lost>
  move <stage> up|down
  archive <stage> [--move-to <stage>]   refused while customers are in it, unless --move-to
  restore <stage>

<stage> is a key or a label. There is always at least one open stage: new
customers land in the first one.`;

const a = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = a._;
if (!cmd || has(a, "help")) {
  console.log(HELP);
  process.exit(cmd || has(a, "help") ? 0 : 1);
}
const json = has(a, "json");

const WHY: Record<string, string> = {
  missing: "no such stage",
  "last-open": "that would leave no open stage; new customers need one to land in",
  "in-use": "customers are still in that stage; pass --move-to <stage>",
  "bad-target": "--move-to must name another active stage",
  label: "a stage needs a label",
};
const done = (r: StageResult, msg: string) => (r.ok ? msg : fail(WHY[r.reason] + (r.count ? ` (${r.count})` : "")));

await withDb(async (db) => {
  const user = who(a);
  const all = await stagesWithCounts(db);
  const find = (v: string | undefined) => resolveStage(all, v) ?? fail(`no stage ${v ?? ""}; stages: ${all.map((s) => `${s.key} (${s.label})`).join(", ")}`);
  switch (cmd) {
    case "list":
      return out(json, all, () =>
        all.map((s) => `${s.archived ? "  archived" : String(s.position).padStart(10)}  ${s.key}  ${s.label}  [${KIND_LABELS[s.kind]}]  ${s.customers}`).join("\n"),
      );
    case "add": {
      const kind = pickKind(flag(a, "kind") ?? "open") ?? fail(`--kind must be ${STAGE_KINDS.join(", ")}`);
      const r = await addStage(db, rest.join(" "), kind, user);
      return console.log(done(r, r.ok ? `added ${r.stage?.key} (${r.stage?.label})` : ""));
    }
    case "rename": {
      const s = find(rest[0]);
      return console.log(done(await editStage(db, s.key, { label: rest.slice(1).join(" ") || fail("rename to what?") }, user), `renamed ${s.key}`));
    }
    case "kind": {
      const s = find(rest[0]);
      const kind = pickKind(rest[1]) ?? fail(`kind must be ${STAGE_KINDS.join(", ")}`);
      return console.log(done(await editStage(db, s.key, { kind }, user), `${s.key} is now ${kind}`));
    }
    case "move": {
      const s = find(rest[0]);
      if (rest[1] !== "up" && rest[1] !== "down") fail("move <stage> up|down");
      return console.log(done(await moveStage(db, s.key, rest[1], user), `moved ${s.key} ${rest[1]}`));
    }
    case "archive": {
      const s = find(rest[0]);
      const to = flag(a, "move-to");
      const target = to ? find(to).key : null;
      return console.log(done(await archiveStage(db, s.key, target, user), `archived ${s.key}${target ? `; its customers moved to ${target}` : ""}`));
    }
    case "restore": {
      const s = find(rest[0]);
      return console.log(done(await restoreStage(db, s.key, user), `restored ${s.key}`));
    }
    default:
      fail(`unknown command ${cmd}\n\n${HELP}`);
  }
});
