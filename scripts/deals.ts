// Deals from chat: the same changes as the pages. `node scripts/deals.mjs --help`.
import { dealsCfg, visitsCfg } from "../src/config";
import { createDeal, customerDeals, getDeal, listDeals, saveDeal, setDealArchived, setDealStage, setLostReason, type Deal, type DealInput } from "../src/crm/deals";
import { firstOfKind, firstOpenStage, listStages, resolveStage } from "../src/crm/stages";
import { clean, money } from "../src/crm/text";
import { readDay } from "../src/crm/follow-ups";
import { amountText, parseAmount, visitFromDeal } from "../src/crm/visits";
import { done, fail, flag, has, limitOf, local, misused, noMore, out, parseArgs, resolveCustomer, usage, who, withDb } from "./lib";

const one = dealsCfg.one.toLowerCase();
const many = dealsCfg.many.toLowerCase();
const HELP = `deals.mjs <command> [...] [--json] [--as <email>]      ${dealsCfg.many} in this CRM

  list [--open | --won | --lost] [--stage s] [--owner o] [--customer <who>] [--limit 50]
                                       most recently changed first; open, won or lost by the stage's kind
  show <id>
  add <who> "<what>" [--value 1200] [--stage s] [--owner o] [--close YYYY-MM-DD] [--notes n]
                                       in the first open stage unless --stage
  update <id> [--what w] [--value v] [--owner o] [--close d] [--notes n]   "" clears a value
  stage <id> <stage> [--reason r]      a stage key or label; --reason when it is a lost one
  won <id> | lost <id> [--reason r]    to the first won or lost stage
  job <id>                             a won ${one}'s ${visitsCfg?.one.toLowerCase() ?? "job"}, once
  archive <id> [--undo]                never deletes

<who> is a customer's id, email or phone. --value is in ${dealsCfg.currency}; blank, the
latest quote made for the ${one} stands in. Winning a ${one} moves its customer from an
open status to the first won one. A quote accepted for a ${one} wins it.
--as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FIELDS = ["value", "owner", "close", "notes", "as"];
const FLAGS: Record<string, string[]> = {
  list: ["open", "won", "lost", "stage", "owner", "customer", "limit"], show: [], add: [...FIELDS, "stage"], update: [...FIELDS, "what"],
  stage: ["reason", "as"], won: ["as"], lost: ["reason", "as"], job: ["as"], archive: ["undo", "as"],
};
const WORDS: Record<string, number> = { list: 0, show: 1, update: 1, stage: 2, won: 1, lost: 1, job: 1, archive: 1 };

const a = parseArgs(process.argv.slice(2), { bare: ["open", "won", "lost", "undo"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "deals", FLAGS);
const at = `deals ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const json = has(a, "json");
const show = (id: string) => `node scripts/deals.mjs show ${id}`;
if (["show", "update", "stage", "won", "lost", "job", "archive"].includes(cmd) && !/^#?\d{1,18}$/.test(rest[0] ?? "")) misused(`${at}: name a ${one} by its id (#12 is 12)`, "node scripts/deals.mjs list");
if (cmd === "stage" && !rest[1]) misused(`${at}: to which stage?`, `node scripts/deals.mjs stage ${rest[0]} won`);
const kinds = (["open", "won", "lost"] as const).filter((k) => has(a, k));
if (kinds.length > 1) misused(`${at}: one of --open, --won, --lost`, "node scripts/deals.mjs list --open");
/** Whose a new deal is: --owner, else whoever is acting (--as, CRM_USER); never "AI". */
const ownerOf = () => clean(flag(a, "owner"), 200) ?? (flag(a, "as") || process.env.CRM_USER || null);

function valueFlag(current: number | null): number | null {
  if (!has(a, "value")) return current;
  const r = parseAmount(flag(a, "value") ?? "", dealsCfg.currency);
  if (r === "invalid") misused(`${at}: --value ${flag(a, "value")}: a plain amount in ${dealsCfg.currency}, such as 1200.00`, "node scripts/deals.mjs --help");
  return r;
}

function closeFlag(current: string | null): string | null {
  if (!has(a, "close")) return current;
  const v = (flag(a, "close") ?? "").trim();
  if (!v) return null;
  return readDay(v) ?? misused(`${at}: --close ${v}: write the day as YYYY-MM-DD`, "node scripts/deals.mjs --help");
}

await withDb(async (db) => {
  const stages = await listStages(db, "deals", { archived: true });
  const active = stages.filter((s) => !s.archived);
  const label = (k: string) => stages.find((s) => s.key === k)?.label ?? k;
  const stageList = active.map((s) => `${s.key} (${s.label})`).join(", ");
  const user = who(a);
  const fmt = (d: Deal) =>
    [`#${d.id}`, d.title, `[${label(d.stage)}]`, d.customer_name, d.shown_cents !== null ? money(d.shown_cents, d.currency ?? dealsCfg.currency) + (d.from_quote ? " (its quote)" : "") : "",
      d.owner ? `@${d.owner}` : "", d.expected_close ? `close ${d.expected_close}` : "", d.archived_at ? "(archived)" : ""].filter(Boolean).join("  ");
  const result = (data: unknown, what: string, opts: Parameters<typeof done>[2] = {}) => (json ? out(true, data, String) : done(at, what, opts));
  const dealOr = async (id: string | undefined) => {
    if (!id || !/^#?\d{1,18}$/.test(id)) misused(`${at}: name a ${one} by its id (#12 is 12)`, "node scripts/deals.mjs list");
    return (await getDeal(db, id.replace(/^#/, ""))) ?? fail(`${at}: no ${one} ${id}`, "node scripts/deals.mjs list");
  };
  const moved = async (d: Deal, stage: string, reason: string | null) => {
    const r = (await setDealStage(db, d.id, stage, user, reason)) ?? fail(`${at}: ${d.title} could not move to ${stage}`, "node scripts/stages.mjs list");
    return result(r, `${r.title}: ${label(d.stage)} -> ${label(r.stage)}${r.lost_reason ? ` (${r.lost_reason})` : ""}`, { next: show(r.id) });
  };

  switch (cmd) {
    case "list": {
      const stageArg = flag(a, "stage");
      const st = stageArg ? resolveStage(stages, stageArg) : undefined;
      if (stageArg && !st) misused(`${at}: no stage ${stageArg}; stages: ${stageList}`, "node scripts/stages.mjs list");
      const customer = has(a, "customer") ? await resolveCustomer(db, flag(a, "customer"), at) : null;
      const limit = limitOf(a, at);
      const rows = customer && !st && !kinds.length && !has(a, "owner")
        ? await customerDeals(db, customer.id, limit + 1)
        : await listDeals(db, { stage: st?.key ?? null, kind: kinds[0] ?? null, owner: flag(a, "owner") ?? null, customerId: customer?.id ?? null }, limit);
      const page = rows.slice(0, limit);
      const what = `${kinds[0] ? kinds[0] + " " : ""}${many}${st ? ` in ${st.label}` : ""}${customer ? ` for ${customer.name}` : ""}`;
      if (!page.length) return result(page, `no ${what}`, { next: `node scripts/deals.mjs add <who> "<what>"` });
      return result(page, `${page.length} ${what}`, {
        lines: [...page.map(fmt), ...(rows.length > limit ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : [])],
      });
    }

    case "show": {
      const d = await dealOr(rest[0]);
      return result(d, fmt(d), {
        lines: [
          `customer: #${d.customer_id} ${d.customer_name}${d.customer_email ? ` <${d.customer_email}>` : ""}`,
          d.closed_at ? `closed ${local(d.closed_at)}${d.lost_reason ? `: ${d.lost_reason}` : ""}` : `in ${label(d.stage)} since ${local(d.stage_changed_at)}`,
          d.notes ? `notes: ${d.notes}` : "",
          `added ${local(d.created_at)}${d.created_by ? " by " + d.created_by : ""}`,
        ].filter(Boolean),
        next: `node scripts/follow-ups.mjs list --customer ${d.customer_id}`,
      });
    }

    case "add": {
      const c = await resolveCustomer(db, rest[0], at);
      const title = clean(rest.slice(1).join(" "), 200) ?? misused(`${at}: say what the ${one} is`, `node scripts/deals.mjs add ${c.id} "New furnace" --value 6500`);
      const stageArg = flag(a, "stage");
      const st = (stageArg ? resolveStage(active, stageArg) : await firstOpenStage(db, "deals")) ?? misused(`${at}: no stage ${stageArg ?? ""}; stages: ${stageList}`, "node scripts/stages.mjs list");
      // A re-run with the same title for the same customer, still open, is the same deal.
      const same = (await customerDeals(db, c.id)).find((d) => !d.closed_at && d.title.toLowerCase() === title.toLowerCase());
      if (same) return result(same, `already here, not added: ${fmt(same)}`, { lines: ["an open one with that title for them; left alone"], next: show(same.id) });
      const input: DealInput = { title, value_cents: valueFlag(null), currency: dealsCfg.currency, owner: ownerOf(), expected_close: closeFlag(null), notes: clean(flag(a, "notes"), 10_000) };
      const d = (await createDeal(db, c.id, input, st.key, user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(d, `added ${fmt(d)}`, { next: `node scripts/follow-ups.mjs add ${c.id} "Call ${c.name}" --on tomorrow --deal ${d.id}` });
    }

    case "update": {
      const d = await dealOr(rest[0]);
      if (!FIELDS.concat("what").some((k) => k !== "as" && has(a, k))) misused(`${at}: nothing to change; name a flag such as --value`, "node scripts/deals.mjs --help");
      const title = has(a, "what") ? clean(flag(a, "what"), 200) ?? misused(`${at}: --what cannot be empty`, `node scripts/deals.mjs update ${d.id} --what "New furnace"`) : d.title;
      const input: DealInput = {
        title,
        value_cents: valueFlag(d.value_cents === null ? null : Number(d.value_cents)),
        currency: d.currency ?? dealsCfg.currency,
        owner: has(a, "owner") ? clean(flag(a, "owner"), 200) : d.owner,
        expected_close: closeFlag(d.expected_close),
        notes: has(a, "notes") ? clean(flag(a, "notes"), 10_000) : d.notes,
      };
      const r = (await saveDeal(db, d.id, input, user)) ?? fail(`${at}: no ${one} ${d.id}`, "node scripts/deals.mjs list");
      return result(r, `updated ${fmt(r)}`, { lines: r.value_cents !== null ? [`value ${amountText(r.value_cents, r.currency ?? dealsCfg.currency)} ${(r.currency ?? dealsCfg.currency).toUpperCase()}`] : [], next: show(r.id) });
    }

    case "stage": {
      const d = await dealOr(rest[0]);
      const want = rest[1] ?? misused(`${at}: to which stage? stages: ${stageList}`, `node scripts/deals.mjs stage ${d.id} ${active[0]?.key ?? "new"}`);
      const st = resolveStage(active, want) ?? misused(`${at}: no active stage ${want}; stages: ${stageList}`, "node scripts/stages.mjs list");
      const reason = clean(flag(a, "reason"), 200);
      if (d.stage === st.key) {
        if (reason && st.kind === "lost" && reason !== d.lost_reason) {
          await setLostReason(db, d.id, reason, user);
          return result(await getDeal(db, d.id), `${d.title}: lost because ${reason}`, { next: show(d.id) });
        }
        return result(d, `${d.title} is already in ${st.label}; left alone`, { next: show(d.id) });
      }
      return moved(d, st.key, st.kind === "lost" ? reason : null);
    }

    case "won":
    case "lost": {
      const d = await dealOr(rest[0]);
      const st = (await firstOfKind(db, "deals", cmd)) ?? fail(`${at}: there is no ${cmd} stage`, `node scripts/stages.mjs add "${cmd === "won" ? "Won" : "Lost"}" --kind ${cmd}`);
      if (stages.find((s) => s.key === d.stage)?.kind === cmd) return result(d, `${d.title} is already ${cmd} (${label(d.stage)}); left alone`, { next: show(d.id) });
      return moved(d, st.key, cmd === "lost" ? clean(flag(a, "reason"), 200) : null);
    }

    case "job": {
      if (!visitsCfg) fail(`${at}: jobs are off in crm.config.json ("visits": false)`, "node scripts/deals.mjs --help");
      const d = await dealOr(rest[0]);
      if (stages.find((s) => s.key === d.stage)?.kind !== "won") fail(`${at}: ${d.title} is ${label(d.stage)}; only a won ${one} becomes a ${visitsCfg.one.toLowerCase()}`, `node scripts/deals.mjs won ${d.id}`);
      const r = (await visitFromDeal(db, d.id, user)) ?? fail(`${at}: no ${one} ${d.id}`, "node scripts/deals.mjs list");
      const v = r.visit;
      return result(v, `${r.created ? "" : "already made: "}${visitsCfg.one.toLowerCase()} #${v.id} ${v.title} for ${v.customer_name}${r.created ? "" : "; left alone"}`, { next: `node scripts/visits.mjs show ${v.id}` });
    }

    case "archive": {
      const d = await dealOr(rest[0]);
      const archive = !has(a, "undo");
      if (!!d.archived_at === archive) return result(d, `${d.title} is already ${archive ? "archived" : "active"}; left alone`);
      await setDealArchived(db, d.id, archive, user);
      return result(await getDeal(db, d.id), `${d.title}: ${archive ? "archived" : "active again"}`, { next: show(d.id) });
    }
  }
});
