// What came in, from chat: submissions, bookings and payments across the
// project, who they matched, and the two actions the page has.
// `node scripts/inbox.mjs --help`.
import { cfg } from "../src/config";
import { addFromInbox, inboxPage, markDone, sinceDays, sourceOf, type InboxKind, type InboxRow } from "../src/crm/inbox";
import { firstOpenStage } from "../src/crm/stages";
import { missingSentence } from "../src/crm/tables";
import { money, wallTime, wallToInstant } from "../src/crm/text";
import { fail, flag, has, local, out, parseArgs, who, withDb } from "./lib";

const HELP = `inbox.mjs [list] [--since 7d|YYYY-MM-DD (in the business's zone)] [--unmatched] [--limit 50] [--json]
inbox.mjs add <submission|booking|payment> <id>     make a customer from it (or find the one it matches)
inbox.mjs done <submission id>                      mark a form submission done

Newest first across form submissions (not spam), bookings and payments
(paid or refunded), as crm.config.json's "inbox" says. Each row shows the
customer it matched by email (then phone), or "not a customer yet".
--unmatched lists only people who are not customers yet. Times print in
${cfg.time_zone}. --as records who acted (default CRM_USER, else AI).`;

const a = parseArgs(process.argv.slice(2));
if (has(a, "help")) {
  console.log(HELP);
  process.exit(0);
}
const [cmd = "list", ...rest] = a._;
const json = has(a, "json");

function since(v: string | undefined): Date | null {
  if (!v) return null;
  const m = v.match(/^(\d+)d$/);
  if (m) return sinceDays(Number(m[1]));
  // A date is that day's midnight in the business's zone, the zone every time prints in.
  const wall = /^\d{4}-\d{2}-\d{2}$/.test(v) ? wallTime(`${v} 00:00`) : null;
  if (wall) return wallToInstant(wall, cfg.time_zone);
  fail(`--since ${v}: write 7d or YYYY-MM-DD`);
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
      const limit = Math.min(Number(flag(a, "limit") ?? 50) || 50, 500);
      const { rows, next, present } = await inboxPage(db, { inbox: cfg.inbox, since: since(flag(a, "since")), unmatched: has(a, "unmatched") }, null, limit);
      const missing = missingSentence(present, { submissions: true, bookings: cfg.inbox.bookings !== false, payments: cfg.inbox.payments !== false });
      return out(json, { rows, more: !!next, missing }, () =>
        [missing ?? "", rows.length ? rows.map(line).join("\n") : "nothing came in", next ? "... more; raise --limit or narrow --since" : ""].filter(Boolean).join("\n"),
      );
    }
    case "add": {
      const [kind, id] = rest;
      if (!["submission", "booking", "payment"].includes(kind) || !id) fail("add <submission|booking|payment> <id>");
      const stage = await firstOpenStage(db);
      if (!stage) fail("there is no open stage; add one with node scripts/stages.mjs add");
      const r = await addFromInbox(db, kind as InboxKind, id, stage.key, user, cfg.fields);
      if (!r) fail(`no ${kind} ${id} (or it is spam)`);
      return out(json, r, () => `${r.created ? "added" : "already a customer"}: #${r.customer.id} ${r.customer.name}`);
    }
    case "done": {
      if (!rest[0]) fail("done <submission id>");
      const ok = await markDone(db, rest[0], user);
      return out(json, { ok }, () => (ok ? `submission ${rest[0]} marked done` : `submission ${rest[0]} is not new or read (or does not exist)`));
    }
    default:
      fail(`unknown command ${cmd}\n\n${HELP}`);
  }
});
