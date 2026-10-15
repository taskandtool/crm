// Leads from chat: the same as the Leads pages. `node scripts/leads.mjs --help`.
import { dealsCfg } from "../src/config";
import { saveLead, type LeadSource } from "../src/customers/customer";
import { ARCHIVE_REASONS, archiveLead, getLead, listLeads, MANUAL_SOURCES, reopenLead, SOURCE_LABELS, sourceText, type Lead, type LeadStatus } from "../src/crm/leads";
import { clean } from "../src/crm/text";
import { done, fail, flag, has, limitOf, local, misused, noMore, out, parseArgs, ownerOf, resolveCustomer, usage, who, withDb } from "./lib";

const deal = dealsCfg.one.toLowerCase();
const HELP = `leads.mjs <command> [...] [--json] [--as <email>]      enquiries: one each time someone asks for something

  list [--converted | --archived] [--source s] [--owner o] [--find text] [--limit 50]
                                       open ones unless asked, newest first
  show <id>                            who, where it came from, what they said, what they already have
  add <who> "<what they need>" [--source ${MANUAL_SOURCES.join("|")}] [--notes n] [--owner o]
                                       a phone call or a walk-in; a form or an online booking makes its own
  archive <id> [--reason "${ARCHIVE_REASONS.join('" | "')}"] [--undo]

<who> is a customer's id, email or phone (customers.mjs add makes someone new).
To convert a lead into a ${deal}: node scripts/deals.mjs add <who> --lead <id>
(it is named for the lead, or "<name> deal" for a form's or a booking's, unless
you name it, and gets a "Call back" task today).
--as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = {
  list: ["converted", "archived", "source", "owner", "find", "limit"], show: [], add: ["source", "notes", "owner", "as"], archive: ["reason", "undo", "as"],
};
const WORDS: Record<string, number> = { list: 0, show: 1, archive: 1 };

const a = parseArgs(process.argv.slice(2), { bare: ["converted", "archived", "undo"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "leads", FLAGS);
const at = `leads ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const json = has(a, "json");
const show = (id: string) => `node scripts/leads.mjs show ${id}`;
if (["show", "archive"].includes(cmd) && !/^#?\d{1,18}$/.test(rest[0] ?? "")) misused(`${at}: name a lead by its id (#12 is 12)`, "node scripts/leads.mjs list");
if (has(a, "converted") && has(a, "archived")) misused(`${at}: one of --converted or --archived`, "node scripts/leads.mjs list --archived");
const source = flag(a, "source");
if (source && !(Object.keys(SOURCE_LABELS) as string[]).includes(source)) misused(`${at}: --source ${source}: one of ${Object.keys(SOURCE_LABELS).join(", ")}`, "node scripts/leads.mjs --help");
if (cmd === "add" && source && !(MANUAL_SOURCES as string[]).includes(source)) misused(`${at}: --source ${source}: a lead added by hand is ${MANUAL_SOURCES.join(", ")}`, "node scripts/leads.mjs --help");
const reason = flag(a, "reason");
if (reason && has(a, "undo")) misused(`${at}: --reason is for archiving; --undo opens it again`, `node scripts/leads.mjs archive ${rest[0] ?? "<id>"} --undo`);
if (reason && !ARCHIVE_REASONS.includes(reason)) misused(`${at}: --reason ${reason}: one of ${ARCHIVE_REASONS.join(", ")}`, "node scripts/leads.mjs --help");

const fmt = (l: Lead) =>
  [`#${l.id}`, local(l.created_at), `[${l.status}${l.archived_reason ? `: ${l.archived_reason}` : ""}]`, `${l.customer_name} (#${l.customer_id})`, sourceText(l),
    l.deal_title ? `-> ${l.deal_title} (#${l.deal_id})` : "", l.owner ? `@${l.owner}` : ""].filter(Boolean).join("  ");
const convert = (l: Lead) => `node scripts/deals.mjs add ${l.customer_id} --lead ${l.id}`;

await withDb(async (db) => {
  const user = who(a);
  const result = (data: unknown, what: string, opts: Parameters<typeof done>[2] = {}) => (json ? out(true, data, String) : done(at, what, opts));
  const leadOr = async (id: string) => (await getLead(db, id.replace(/^#/, ""))) ?? fail(`${at}: no lead ${id}`, "node scripts/leads.mjs list");

  switch (cmd) {
    case "list": {
      const status: LeadStatus = has(a, "converted") ? "converted" : has(a, "archived") ? "archived" : "open";
      const limit = limitOf(a, at, { max: 200 });
      const rows = await listLeads(db, { status, source: source ?? null, owner: clean(flag(a, "owner"), 200), q: clean(flag(a, "find"), 100) }, limit + 1);
      const page = rows.slice(0, limit);
      if (json) return out(true, { rows: page, more: rows.length > limit }, String);
      if (!page.length) return done(at, `no ${status} leads${flag(a, "find") ? ` matching "${flag(a, "find")}"` : ""}`, { next: 'node scripts/leads.mjs add <who> "<what they need>" --source phone' });
      return done(at, `${page.length} ${status} lead${page.length === 1 ? "" : "s"}, newest first`, {
        lines: [...page.map(fmt), ...(rows.length > limit ? [`the first ${limit}; --limit ${Math.min(limit * 4, 200)} for more`] : [])],
        next: status === "open" ? show(page[0].id) : undefined,
      });
    }

    case "show": {
      const l = await leadOr(rest[0]);
      return result(l, fmt(l), {
        lines: [
          [l.customer_email, l.customer_phone].filter(Boolean).join("  "),
          l.said ? `said: ${l.said}` : "",
          l.open_deal_id ? `open ${deal}: ${l.open_deal_title} (#${l.open_deal_id})` : "",
          l.next_event_at ? `next visit: ${local(l.next_event_at)} (event #${l.next_event_id})` : "",
        ].filter(Boolean),
        next: l.status === "open" ? convert(l) : undefined,
      });
    }

    case "add": {
      const c = await resolveCustomer(db, rest[0], at);
      const title = clean(rest.slice(1).join(" "), 200) ?? misused(`${at}: say what they need`, `node scripts/leads.mjs add ${c.id} "Furnace not heating" --source phone`);
      const id = (await saveLead(db, { customerId: c.id, source: (source as LeadSource | undefined) ?? "phone", title, notes: clean(flag(a, "notes"), 10_000), owner: ownerOf(a) }, user))
        ?? fail(`${at}: the leads table is not set up yet`, "node scripts/migrate.mjs");
      const l = (await getLead(db, id))!;
      return result(l, `added ${fmt(l)}`, { next: convert(l) });
    }

    case "archive": {
      const l = await leadOr(rest[0]);
      if (has(a, "undo")) {
        if (l.status !== "archived") return result(l, `lead ${l.id} is ${l.status}, not archived; left alone`);
        await reopenLead(db, l.id, user);
        return result(await getLead(db, l.id), `lead ${l.id} (${l.customer_name}) is open again`, { next: show(l.id) });
      }
      if (l.status !== "open") return result(l, `lead ${l.id} is already ${l.status}; left alone`);
      await archiveLead(db, l.id, reason ?? "Other", user);
      return result(await getLead(db, l.id), `lead ${l.id} (${l.customer_name}) archived: ${reason ?? "Other"}`, { next: "node scripts/leads.mjs list" });
    }
  }
});
