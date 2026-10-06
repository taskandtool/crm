// Jobs, visits, appointments or events from chat: the same changes as the
// pages. `node scripts/visits.mjs --help`.
import { cut } from "../src/admin/keyset";
import { cfg, visitsCfg } from "../src/config";
import { readFields } from "../src/crm/fields";
import { clean, nowIn, relativeWall, wallTime } from "../src/crm/text";
import {
  addVisit, amountText, customerVisits, getVisit, parseAmount, pickVisitStatus, saveVisit, setVisitStatus, visitsPage,
  VISIT_STATUSES, type Visit, type VisitInput,
} from "../src/crm/visits";
import { done, fail, flag, flags, has, limitOf, local, misused, noMore, out, parseArgs, resolveCustomer, usage, who, withDb } from "./lib";

const OFF = 'visits are off: crm.config.json has "visits": false (or none). Turn them on with { "one": "Job", "many": "Jobs", "fields": [] }.';
const HELP = ((v) => !v ? OFF : `visits.mjs <command> [...] [--json] [--as <email>]      ${v.many} in this CRM

  list [--done | --all] [--owner o] [--find text] [--limit 50]
                                       coming up (planned, soonest first), done, or all (newest first)
  list --customer <who>                one customer's
  show <id>
  add <who> "<what>" [--at "YYYY-MM-DD HH:MM"] [--status ${VISIT_STATUSES.join("|")}]
               [--owner o] [--amount 245.00] [--notes n] [--field key=value]...
  update <id> [--what w] [--at "YYYY-MM-DD HH:MM"] [--owner o] [--amount a] [--notes n] [--field key=value]...
                                       "" clears a value (--at "" is not scheduled)
  done <id> | cancel <id> | plan <id>  done with no time, or one still to come, happened now

<who> is a customer's id, email or phone. --at also takes "next friday 9:30", "tomorrow 2pm"; it is in the business's zone
(${cfg.time_zone}). --amount is in ${v.currency}. Custom fields (--field):
${v.fields.length ? v.fields.map((f) => `  ${f.key} (${f.type}${f.options ? ": " + f.options.join(", ") : ""})`).join("\n") : "  none declared in crm.config.json's visits"}
--as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`)(visitsCfg);

const FIELDS = ["at", "owner", "amount", "notes", "field", "as"];
const FLAGS: Record<string, string[]> = {
  list: ["done", "all", "owner", "find", "limit", "customer"], show: [], add: [...FIELDS, "status"], update: [...FIELDS, "what"],
  done: ["as"], cancel: ["as"], plan: ["as"],
};
const WORDS: Record<string, number> = { list: 0, show: 1, update: 1, done: 1, cancel: 1, plan: 1 };

const a = parseArgs(process.argv.slice(2), { bare: ["done", "all"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "visits", FLAGS);
if (!visitsCfg) fail(OFF, "node scripts/visits.mjs --help");
const at = `visits ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const v = visitsCfg;
const one = v.one.toLowerCase();
const json = has(a, "json");
const show = (id: string) => `node scripts/visits.mjs show ${id}`;

function fieldFlags() {
  const input: Record<string, string> = {};
  for (const kv of flags(a, "field")) {
    const i = kv.indexOf("=");
    const k = i > 0 ? kv.slice(0, i).trim() : "";
    if (!v.fields.some((f) => f.key === k)) misused(`${at}: --field ${kv}: no ${one} field ${k}; declared: ${v.fields.map((f) => f.key).join(", ") || "none"}`, "node scripts/visits.mjs --help");
    input[k] = kv.slice(i + 1);
  }
  const r = readFields(v.fields, input);
  if (r.errors.length) misused(`${at}: ${r.errors.join("; ")}`, "node scripts/visits.mjs --help");
  return r;
}

function atFlag(current: string | null): string | null {
  if (!has(a, "at")) return current;
  const when = flag(a, "at") ?? "";
  if (!when.trim()) return null;
  const wall = wallTime(when) ?? relativeWall(when, cfg.time_zone);
  if (!wall) misused(`${at}: --at ${when}: write it as "YYYY-MM-DD HH:MM", or "next friday 9:30", "tomorrow 2pm", in ${cfg.time_zone}`, "node scripts/visits.mjs --help");
  return wall;
}

function amountFlag(current: number | null): number | null {
  if (!has(a, "amount")) return current;
  const r = parseAmount(flag(a, "amount") ?? "", v.currency);
  if (r === "invalid") misused(`${at}: --amount ${flag(a, "amount")}: a plain amount in ${v.currency}, such as 245.00`, "node scripts/visits.mjs --help");
  return r;
}

const fmt = (r: Visit) =>
  [
    `#${r.id}`,
    r.starts_at ? local(r.starts_at) : "not scheduled",
    `[${r.status}]`,
    r.title,
    `for ${r.customer_name} (#${r.customer_id})`,
    r.owner ? `@${r.owner}` : "",
    r.amount_cents !== null ? `${amountText(r.amount_cents, r.currency ?? v.currency)} ${r.currency ?? v.currency}` : "",
    ...v.fields.map((f) => (r.fields?.[f.key] !== undefined ? `${f.label}: ${String(r.fields[f.key])}` : "")),
  ]
    .filter(Boolean)
    .join("  ");

async function visitOr(db: Parameters<typeof getVisit>[0], id: string | undefined): Promise<Visit> {
  if (!id || !/^\d{1,18}$/.test(id)) misused(`${at}: name a ${one} by its id (#12 is 12)`, "node scripts/visits.mjs list");
  return (await getVisit(db, id)) ?? fail(`${at}: no ${one} ${id}`, "node scripts/visits.mjs list --all");
}

await withDb(async (db) => {
  const user = who(a);
  const result = (data: unknown, what: string, opts: Parameters<typeof done>[2] = {}) => (json ? out(true, data, String) : done(at, what, opts));
  switch (cmd) {
    case "list": {
      const limit = limitOf(a, at);
      const more = (n: number) => (n > limit ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : []);
      if (has(a, "customer")) {
        const c = await resolveCustomer(db, flag(a, "customer"), at);
        const rows = await customerVisits(db, c.id, limit + 1);
        const page = rows.slice(0, limit);
        return result(page, page.length ? `${page.length} ${v.many.toLowerCase()} for ${c.name}` : `no ${v.many.toLowerCase()} for ${c.name}`, { lines: [...page.map(fmt), ...more(rows.length)] });
      }
      const view = has(a, "all") ? "all" : has(a, "done") ? "done" : "upcoming";
      const { page, next } = cut(await visitsPage(db, { view, owner: flag(a, "owner") ?? null, q: flag(a, "find") ?? null }, null, limit), limit);
      const what = view === "upcoming" ? "coming up, soonest first" : view === "done" ? "done, newest first" : "newest first";
      return result(page, page.length ? `${page.length} ${v.many.toLowerCase()} ${what}` : `no ${v.many.toLowerCase()} ${what.split(",")[0]}`, {
        lines: [...page.map(fmt), ...(next ? more(limit + 1) : [])],
      });
    }

    case "show": {
      const r = await visitOr(db, rest[0]);
      return result(r, fmt(r), { lines: [r.notes ? `notes: ${r.notes}` : "", `added ${local(r.created_at)}${r.created_by ? " by " + r.created_by : ""}`].filter(Boolean) });
    }

    case "add": {
      const c = await resolveCustomer(db, rest[0], at);
      const title = clean(rest.slice(1).join(" "), 200) ?? misused(`${at}: it needs what it is`, `node scripts/visits.mjs add ${rest[0]} "Annual tune-up"`);
      const status = pickVisitStatus(flag(a, "status") ?? "planned") ?? misused(`${at}: --status must be one of ${VISIT_STATUSES.join(", ")}`, `node scripts/visits.mjs add ${rest[0]} "${title}" --status planned`);
      const fr = fieldFlags();
      const input: VisitInput = {
        title, status, at: atFlag(null), timeZone: cfg.time_zone, owner: clean(flag(a, "owner"), 200) ?? c.owner,
        amount_cents: amountFlag(null), currency: v.currency, notes: clean(flag(a, "notes"), 10_000), fields: fr.set,
      };
      const r = (await addVisit(db, c.id, input, user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(r, `added ${fmt(r)}`, { next: show(r.id) });
    }

    case "update": {
      const r = await visitOr(db, rest[0]);
      const fr = fieldFlags();
      if (!["what", "at", "owner", "amount", "notes", "field"].some((k) => has(a, k))) misused(`${at}: nothing to change; name a flag such as --amount`, "node scripts/visits.mjs --help");
      const current = r.starts_at ? wallTime(nowIn(cfg.time_zone, new Date(r.starts_at))) : null;
      const amount = amountFlag(r.amount_cents === null ? null : Number(r.amount_cents));
      const input: VisitInput = {
        title: has(a, "what") ? (clean(flag(a, "what"), 200) ?? misused(`${at}: --what cannot be empty`, `node scripts/visits.mjs update ${r.id} --what "Annual tune-up"`)) : r.title,
        status: r.status,
        at: atFlag(current),
        timeZone: cfg.time_zone,
        owner: has(a, "owner") ? clean(flag(a, "owner"), 200) : r.owner,
        amount_cents: amount,
        currency: (amount !== null && r.currency) || v.currency,
        notes: has(a, "notes") ? clean(flag(a, "notes"), 10_000) : r.notes,
        fields: fr.set,
      };
      const saved = (await saveVisit(db, r.id, { ...input, unset: fr.unset }, user)) ?? fail(`${at}: no ${one} ${r.id}`, "node scripts/visits.mjs list --all");
      return result(saved, `updated ${fmt(saved)}`, { next: show(r.id) });
    }

    case "done":
    case "cancel":
    case "plan": {
      const r = await visitOr(db, rest[0]);
      const status = cmd === "done" ? "done" : cmd === "cancel" ? "cancelled" : "planned";
      if (r.status === status) return result(r, `${one} #${r.id} is already ${status}; left alone`, { lines: [fmt(r)] });
      const changed = (await setVisitStatus(db, r.id, status, user)) ?? fail(`${at}: no ${one} ${r.id}`, "node scripts/visits.mjs list --all");
      return result(changed, `${one} #${r.id} ${r.status} -> ${status}`, { lines: [fmt(changed)], next: show(r.id) });
    }
  }
});
