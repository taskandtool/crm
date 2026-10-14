// Tasks from chat: the same changes as the pages. `node scripts/tasks.mjs --help`.
import { cfg, dealsCfg, vocab } from "../src/config";
import { getDeal } from "../src/crm/deals";
import {
  addTask, customerTasks, doneTask, getTask, listTasks, moveTask, nothingPlanned, pickTaskKind, readTime, relativeDay,
  TASK_KINDS, type Task,
} from "../src/crm/tasks";
import { clean } from "../src/crm/text";
import { todayIn } from "../src/reports/sql";
import { done, fail, flag, has, limitOf, misused, noMore, out, parseArgs, ownerOf, resolveCustomer, usage, who, withDb } from "./lib";

const HELP = `tasks.mjs <command> [...] [--json] [--as <email>]      what to do next, for whom, by when

  list [--all | --none] [--owner o] [--customer <who>] [--limit 50]
                                       due (today and overdue, overdue first); --all: every open one, soonest first;
                                       or --none: ${vocab.many.toLowerCase()} in play with nothing planned, quietest first
  add <who> "<what>" --on <day> [--at HH:MM] [--kind ${TASK_KINDS.join("|")}] [--owner o] [--deal <id>]
  done <id> [--outcome "what came of it"]   noted on their timeline; a call, email, meeting or text is contact
  move <id> --on <day> [--at HH:MM]    --at "" is any time that day

<who> is a customer's id, email or phone. <day> is YYYY-MM-DD, today, tomorrow, friday,
next friday, "in 3 days" or "in 2 weeks", in the business's zone (${cfg.time_zone}).
--owner is whose it is (default: --as, else CRM_USER). --deal names one of their ${dealsCfg.many.toLowerCase()}.
--as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = {
  list: ["all", "none", "owner", "customer", "limit"],
  add: ["on", "at", "kind", "owner", "deal", "as"],
  done: ["outcome", "as"],
  move: ["on", "at", "as"],
};
const WORDS: Record<string, number> = { list: 0, done: 1, move: 1 };

const a = parseArgs(process.argv.slice(2), { bare: ["all", "none"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "tasks", FLAGS);
const at = `tasks ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const json = has(a, "json");
const today = todayIn(cfg.time_zone);
if ((cmd === "done" || cmd === "move") && !/^#?\d{1,18}$/.test(rest[0] ?? "")) misused(`${at}: name a task by its id (#12 is 12)`, "node scripts/tasks.mjs list");
if (cmd === "list" && has(a, "all") && has(a, "none")) misused(`${at}: one of --all or --none`, "node scripts/tasks.mjs list --none");

function dayFlag(): string {
  const v = flag(a, "on");
  if (!v) misused(`${at}: --on <day> is needed: YYYY-MM-DD, today, tomorrow, friday, "in 3 days"`, `node scripts/tasks.mjs ${cmd} ${rest.join(" ") || "<who>"} --on tomorrow`);
  return relativeDay(v, today) ?? misused(`${at}: --on ${v}: write the day as YYYY-MM-DD, today, tomorrow, a weekday, or "in 3 days"`, "node scripts/tasks.mjs --help");
}

function timeFlag(): string | null | undefined {
  if (!has(a, "at")) return undefined;
  const v = (flag(a, "at") ?? "").trim();
  if (!v) return null;
  return readTime(v) ?? misused(`${at}: --at ${v}: a time like 09:30 or 14:00, in ${cfg.time_zone}`, "node scripts/tasks.mjs --help");
}

const when = (f: Pick<Task, "due_on" | "due_time">) => `${f.due_on === today ? "today" : f.due_on < today ? `${f.due_on} (overdue)` : f.due_on}${f.due_time ? " " + f.due_time : ""}`;
const fmt = (f: Task) =>
  [`#${f.id}`, when(f), `${f.kind}: ${f.title}`, `for ${f.customer_name} (#${f.customer_id})`, f.deal_title ? `re ${f.deal_title} (#${f.deal_id})` : "", f.owner ? `@${f.owner}` : "", f.done_at ? `(done${f.done_by ? " by " + f.done_by : ""})` : ""]
    .filter(Boolean).join("  ");

await withDb(async (db) => {
  const user = who(a);
  const result = (data: unknown, what: string, opts: Parameters<typeof done>[2] = {}) => (json ? out(true, data, String) : done(at, what, opts));
  const taskOr = async (id: string | undefined) => {
    if (!id || !/^#?\d{1,18}$/.test(id)) misused(`${at}: name a task by its id (#12 is 12)`, "node scripts/tasks.mjs list");
    return (await getTask(db, id.replace(/^#/, ""))) ?? fail(`${at}: no task ${id}`, "node scripts/tasks.mjs list");
  };

  switch (cmd) {
    case "list": {
      const owner = clean(flag(a, "owner"), 200);
      const limit = limitOf(a, at);
      if (has(a, "customer")) {
        if (has(a, "all") || has(a, "none") || owner) misused(`${at}: --customer lists everything open for one person; leave out the other flags`, `node scripts/tasks.mjs list --customer ${flag(a, "customer")}`);
        const c = await resolveCustomer(db, flag(a, "customer"), at);
        const r = await customerTasks(db, c.id);
        if (!r.open.length) return result(r, `nothing planned for ${c.name}`, { next: `node scripts/tasks.mjs add ${c.id} "Call ${c.name}" --on tomorrow` });
        return result(r, `${r.open.length} open for ${c.name}, soonest first`, { lines: r.open.map(fmt) });
      }
      if (has(a, "none")) {
        const rows = await nothingPlanned(db, owner, limit, cfg.time_zone);
        const page = rows.slice(0, limit);
        if (!page.length) return result(page, "everyone in play has something planned");
        return result(page, `${page.length} in play with nothing planned, quietest first`, {
          lines: [
            ...page.map((u) => [`#${u.id}`, u.name, u.phone ?? u.email ?? "", u.contacted ? `quiet ${u.quiet_days} days` : `added ${u.quiet_days} days ago, no contact yet`, u.deals.length ? `open: ${u.deals.join(", ")}` : "", u.owner ? `@${u.owner}` : ""].filter(Boolean).join("  ")),
            ...(rows.length > limit ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : []),
          ],
          next: `node scripts/tasks.mjs add ${page[0].id} "Call ${page[0].name}" --on tomorrow`,
        });
      }
      const every = has(a, "all");
      const rows = await listTasks(db, owner, limit, every ? null : today);
      const page = rows.slice(0, limit);
      const what = every ? "open" : "due today or overdue";
      if (!page.length) return result(page, `nothing ${what}${owner ? ` for ${owner}` : ""}`, { next: every ? undefined : "node scripts/tasks.mjs list --none" });
      return result(page, `${page.length} ${what}${owner ? ` for ${owner}` : ""}, soonest first`, {
        lines: [...page.map(fmt), ...(rows.length > limit ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : [])],
      });
    }

    case "add": {
      const c = await resolveCustomer(db, rest[0], at);
      const title = clean(rest.slice(1).join(" "), 200) ?? misused(`${at}: say what to do`, `node scripts/tasks.mjs add ${c.id} "Call about the quote" --on tomorrow`);
      const on = dayFlag();
      const time = timeFlag() ?? null;
      const kind = pickTaskKind(flag(a, "kind") ?? "call") ?? misused(`${at}: --kind must be one of ${TASK_KINDS.join(", ")}`, `node scripts/tasks.mjs add ${c.id} "${title}" --on ${on} --kind call`);
      let dealId: string | null = null;
      if (has(a, "deal")) {
        const d = await getDeal(db, (flag(a, "deal") ?? "").replace(/^#/, ""));
        if (!d || d.customer_id !== c.id) fail(`${at}: ${c.name} has no ${dealsCfg.one.toLowerCase()} ${flag(a, "deal")}`, `node scripts/deals.mjs list --customer ${c.id}`);
        dealId = d.id;
      }
      // The same thing, for the same person, on the same day, still open, is already there.
      const same = (await customerTasks(db, c.id)).open.find((f) => f.title.toLowerCase() === title.toLowerCase() && f.due_on === on);
      if (same) return result(same, `already planned, not added: ${fmt(same)}`, { next: `node scripts/tasks.mjs list --customer ${c.id}` });
      const f = (await addTask(db, c.id, { kind, title, due_on: on, due_time: time, owner: ownerOf(a), deal_id: dealId }, user))
        ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(f, `added ${fmt(f)}`, { lines: [`say back the day: ${on}${time ? " at " + time : ""} (${cfg.time_zone})`], next: `node scripts/tasks.mjs list --customer ${c.id}` });
    }

    case "done": {
      const f = await taskOr(rest[0]);
      const r = (await doneTask(db, f.id, clean(flag(a, "outcome"), 10_000), user)) ?? fail(`${at}: no task ${f.id}`, "node scripts/tasks.mjs list");
      if (r.already) return result(r.task, `#${f.id} was already done; left alone`, { next: `node scripts/tasks.mjs list --customer ${f.customer_id}` });
      return result(r.task, `done: ${f.kind}: ${f.title} for ${f.customer_name}; noted on their timeline`, {
        next: `node scripts/tasks.mjs list --customer ${f.customer_id}`,
      });
    }

    case "move": {
      const f = await taskOr(rest[0]);
      if (f.done_at) fail(`${at}: #${f.id} is done; add a new one instead`, `node scripts/tasks.mjs add ${f.customer_id} "${f.title}" --on tomorrow`);
      const on = dayFlag();
      const time = timeFlag();
      if (on === f.due_on && (time === undefined || time === f.due_time)) return result(f, `#${f.id} is already on ${when(f)}; left alone`);
      await moveTask(db, f.id, on, time, user);
      const now = (await getTask(db, f.id))!;
      return result(now, `moved #${f.id} ${f.title}: ${when(f)} -> ${when(now)}`, { next: `node scripts/tasks.mjs list --customer ${f.customer_id}` });
    }
  }
});
