// What came in, from chat: submissions, bookings and payments across the
// project, who they matched, and the two actions the page has.
// `node scripts/inbox.mjs --help`.
import { cfg } from "../src/config";
import { addFromInbox, inboxPage, markDone, sinceDays, sourceOf, submissionStatus, type InboxKind, type InboxRow } from "../src/crm/inbox";
import { firstOpenStage } from "../src/crm/stages";
import { missingSentence } from "../src/crm/tables";
import { money, wallTime, wallToInstant } from "../src/crm/text";
import { done, fail, flag, has, limitOf, local, misused, noMore, out, parseArgs, usage, who, withDb } from "./lib";

const HELP = `inbox.mjs [list] [--since 7d|YYYY-MM-DD (in the business's zone)] [--unmatched] [--limit 50] [--json]
inbox.mjs add <submission|booking|payment> <id>     make a customer from it (or find the one it matches)
inbox.mjs done <submission id>                      mark a form submission done

Newest first across form submissions (not spam), bookings and payments
(paid or refunded), as crm.config.json's "inbox" says. Each row shows the
customer it matched by email (then phone), or "not a customer yet".
--unmatched lists only people who are not customers yet. Times print in
${cfg.time_zone}. --as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = { list: ["since", "unmatched", "limit"], add: ["as"], done: ["as"] };
const KINDS = ["submission", "booking", "payment"];

const a = parseArgs(process.argv.slice(2), { bare: ["unmatched"] });
const [cmd = "list", ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "inbox", FLAGS);
const at = `inbox ${cmd}`;
noMore(rest, { list: 0, add: 2, done: 1 }[cmd] ?? 0, at);
if (cmd === "add" && (!KINDS.includes(rest[0]) || !rest[1])) misused(`${at}: name what came in: ${KINDS.join(", ")}, then its id`, "node scripts/inbox.mjs add submission 12");
if (cmd === "done" && !/^\d{1,18}$/.test(rest[0] ?? "")) misused(`${at}: name the submission by its id (submission 12 is 12)`, "node scripts/inbox.mjs");
const json = has(a, "json");

function since(v: string | undefined): Date | null {
  if (!v) return null;
  const m = v.match(/^(\d+)d$/);
  if (m) return sinceDays(Number(m[1]));
  // A date is that day's midnight in the business's zone, the zone every time prints in.
  const wall = /^\d{4}-\d{2}-\d{2}$/.test(v) ? wallTime(`${v} 00:00`) : null;
  if (wall) return wallToInstant(wall, cfg.time_zone);
  misused(`${at}: --since ${v}: write 7d or YYYY-MM-DD`, "node scripts/inbox.mjs --since 7d");
}

function line(r: InboxRow): string {
  const person = [r.name, r.email, r.phone].filter(Boolean).join(" ");
  const what =
    r.kind === "booking" ? `booked for ${local(r.starts_at)}${r.resource_name ? " with " + r.resource_name : ""}` : r.kind === "payment" ? money(r.amount_cents, r.currency) : "";
  const match = r.customer_id ? `-> #${r.customer_id} ${r.customer_name}${r.customer_archived_at ? " (archived)" : ""}` : "-> not a customer yet";
  return [`${r.kind} ${r.id}`, local(r.created_at), sourceOf(r), `(${r.status})`, person, what, match].filter(Boolean).join("  ");
}

await withDb(async (db) => {
  const user = who(a);
  switch (cmd) {
    case "list": {
      const limit = limitOf(a, at, { max: 500 });
      const { rows, next, present } = await inboxPage(db, { inbox: cfg.inbox, since: since(flag(a, "since")), unmatched: has(a, "unmatched") }, null, limit);
      const missing = missingSentence(present, { submissions: true, bookings: cfg.inbox.bookings !== false, payments: cfg.inbox.payments !== false });
      if (json) return out(true, { rows, more: !!next, missing }, String);
      const extra = [missing ?? "", next ? `the first ${limit}; --limit ${Math.min(limit * 4, 500)} or a narrower --since for more` : ""].filter(Boolean);
      if (!rows.length) return done(at, `nothing came in${has(a, "unmatched") ? " from anyone who is not a customer yet" : ""}`, { lines: extra });
      return done(at, `${rows.length} came in, newest first`, {
        lines: [...rows.map(line), ...extra],
        next: rows.some((r) => !r.customer_id) ? "node scripts/inbox.mjs add <kind> <id>" : undefined,
      });
    }
    case "add": {
      const [kind, id] = rest;
      const stage = (await firstOpenStage(db, "customers")) ?? fail(`${at}: there is no open status for a new customer to land in`, 'node scripts/stages.mjs add "Lead" --statuses');
      const r = (await addFromInbox(db, kind as InboxKind, id, stage.key, user, cfg.fields)) ?? fail(`${at}: no ${kind} ${id} (or it is spam)`, "node scripts/inbox.mjs --unmatched");
      if (json) return out(true, r, String);
      return done(at, r.created ? `added #${r.customer.id} ${r.customer.name}` : `#${r.customer.id} ${r.customer.name} is already a customer; left alone`, {
        next: `node scripts/customers.mjs show ${r.customer.id}`,
      });
    }
    case "done": {
      const id = rest[0];
      if (await markDone(db, id, user)) return json ? out(true, { ok: true, id }, String) : done(at, `submission ${id} marked done`, { next: "node scripts/inbox.mjs" });
      const status = (await submissionStatus(db, id)) ?? fail(`${at}: no submission ${id}`, "node scripts/inbox.mjs");
      if (status === "done") return json ? out(true, { ok: true, id, already: true }, String) : done(at, `submission ${id} is already done; left alone`);
      return fail(`${at}: submission ${id} is ${status}; only a new or read one is marked done`, "node scripts/inbox.mjs");
    }
  }
});
