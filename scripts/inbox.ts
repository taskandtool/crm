// The Inbox, from chat: submissions, bookings and payments across the
// project, whose they are, and Done. Everyone in it is a customer already
// (the forms and booking skills save each person as they arrive); a deal is deals.mjs add.
// `node scripts/inbox.mjs --help`.
import { cfg } from "../src/config";
import { inboxPage, markDone, markHandled, sinceDays, sourceOf, submissionStatus, type InboxRow } from "../src/crm/inbox";
import { missingSentence } from "../src/crm/tables";
import { dayBounds } from "../src/booking/slots";
import { wallTime } from "../src/customers/notes";
import { formatMoney } from "../src/payments/money";
import { done, fail, flag, has, limitOf, local, misused, noMore, out, parseArgs, usage, who, withDb } from "./lib";

const HELP = `inbox.mjs [list] [--since 7d|YYYY-MM-DD (in the business's zone)] [--unmatched] [--limit 50] [--json]
inbox.mjs done [booking|payment] <id>              mark a form submission (or a booking or payment) done: off To do

Newest first across form submissions (not spam), bookings and payments
(paid or refunded), as crm.config.json's "inbox" says. Everyone who gets in
touch is saved as a customer as they do, matched by email, else by phone,
never by name; each row shows theirs. --unmatched lists the rows
with neither an email nor a phone to know them by. Times print in
${cfg.time_zone}. --as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = { list: ["since", "unmatched", "limit"], done: ["as"] };
const KINDS = ["submission", "booking", "payment"];

const a = parseArgs(process.argv.slice(2), { bare: ["unmatched"] });
const [cmd = "list", ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "inbox", FLAGS);
const at = `inbox ${cmd}`;
noMore(rest, { list: 0, done: 2 }[cmd] ?? 0, at);
const doneKind = cmd === "done" && rest.length === 2 ? rest[0] : "submission";
const doneId = cmd === "done" ? rest[rest.length - 1] ?? "" : "";
if (cmd === "done" && (!KINDS.includes(doneKind) || !/^\d{1,18}$/.test(doneId))) misused(`${at}: name a submission by its id (submission 12 is 12), or a booking or payment as "booking 12"`, "node scripts/inbox.mjs");
const json = has(a, "json");

function since(v: string | undefined): Date | null {
  if (!v) return null;
  const m = v.match(/^(\d+)d$/);
  if (m) return sinceDays(Number(m[1]));
  // A date is that day's midnight in the business's zone, the zone every time prints in.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && wallTime(`${v} 00:00`)) return dayBounds(v, cfg.time_zone).start;
  misused(`${at}: --since ${v}: write 7d or YYYY-MM-DD`, "node scripts/inbox.mjs --since 7d");
}

function line(r: InboxRow): string {
  const person = [r.name, r.email, r.phone].filter(Boolean).join(" ");
  const what =
    r.kind === "booking" ? `booked for ${local(r.starts_at)}${r.resource_name ? " with " + r.resource_name : ""}` : r.kind === "payment" ? formatMoney(r.amount_cents, r.currency) : "";
  const match = r.customer_id ? `-> #${r.customer_id} ${r.customer_name}${r.customer_archived_at ? " (archived)" : ""}` : "-> no email or phone to know them by";
  return [`${r.kind} ${r.id}`, local(r.created_at), sourceOf(r), `(${r.status})`, person, what, match].filter(Boolean).join("  ");
}

await withDb(async (db) => {
  const user = who(a);
  switch (cmd) {
    case "list": {
      const limit = limitOf(a, at, { max: 500 });
      const { rows, next, present } = await inboxPage(db, { inbox: cfg.inbox, since: since(flag(a, "since")), unmatched: has(a, "unmatched") }, null, limit);
      const missing = missingSentence(present, { payments: cfg.inbox.payments !== false });
      if (json) return out(true, { rows, more: !!next, missing }, String);
      const extra = [missing ?? "", next ? `the first ${limit}; --limit ${Math.min(limit * 4, 500)} or a narrower --since for more` : ""].filter(Boolean);
      if (!rows.length) return done(at, `nothing came in${has(a, "unmatched") ? " without an email or a phone" : ""}`, { lines: extra });
      return done(at, `${rows.length} came in, newest first`, { lines: [...rows.map(line), ...extra] });
    }
    case "done": {
      const id = doneId;
      if (doneKind === "booking" || doneKind === "payment") {
        const r = await markHandled(db, doneKind, id, user);
        if (r === "missing") return fail(`${at}: no ${doneKind} ${id}`, "node scripts/inbox.mjs");
        if (r === "done") return json ? out(true, { ok: true, kind: doneKind, id }, String) : done(at, `${doneKind} ${id} marked done`, { next: "node scripts/inbox.mjs" });
        return json ? out(true, { ok: true, kind: doneKind, id, already: true }, String) : done(at, `${doneKind} ${id} is already done; left alone`);
      }
      if (await markDone(db, id, user)) return json ? out(true, { ok: true, id }, String) : done(at, `submission ${id} marked done`, { next: "node scripts/inbox.mjs" });
      const status = (await submissionStatus(db, id)) ?? fail(`${at}: no submission ${id}`, "node scripts/inbox.mjs");
      if (status === "done") return json ? out(true, { ok: true, id, already: true }, String) : done(at, `submission ${id} is already done; left alone`);
      return fail(`${at}: submission ${id} is ${status}; only a new or read one is marked done`, "node scripts/inbox.mjs");
    }
  }
});
