// Customers from chat: list, find, show, add, update, status, tag, note,
// archive, merge. `node scripts/customers.mjs --help`.
import { cfg, dealsCfg, visitsCfg } from "../src/config";
import { customerDeals } from "../src/crm/deals";
import { customerFollowUps } from "../src/crm/follow-ups";
import { mergeCustomers, mergePreview } from "../src/crm/merge";
import { cut } from "../src/admin/keyset";
import {
  createCustomer, listPage, patchCustomer, retag, setArchived, setStage, NO_FILTER, type Details,
} from "../src/crm/customers";
import { readFields } from "../src/crm/fields";
import { everythingFrom } from "../src/crm/history";
import { addNote, listNotes, pickNoteKind, NOTE_KINDS } from "../src/crm/notes";
import { phoneKey } from "../src/crm/phone";
import { customerVisits } from "../src/crm/visits";
import { firstOpenStage, listStages, resolveStage } from "../src/crm/stages";
import { clean, money, parseTags, relativeWall, wallTime } from "../src/crm/text";
import { normalizeEmail } from "../src/data/email";
import { done, fail, flag, flags, fmtCustomer, has, limitOf, local, misused, noMore, out, parseArgs, resolveCustomer, usage, who, withDb } from "./lib";

const HELP = `customers.mjs <command> [...] [--json] [--as <email>]

  list [--status s] [--tag t] [--owner o] [--archived] [--limit 50]
  find <text>                          name, email, phone or company
  show <who>                           details, notes, follow-ups, deals, visits, and what they sent, booked and paid
  add "<name>" [--email e] [--phone p] [--company c] [--address a] [--status s]
               [--source s] [--tag t]... [--owner o] [--notes n] [--field key=value]...
                                       an email or phone already here is reported, not added twice
  update <who> [--name n] [--email e] [--phone p] [--company c] [--address a] [--source s]
               [--owner o] [--notes n] [--field key=value]...      "" clears a value
  status <who> <status>                a status key or label (Lead, Customer...)
  tag <who> <tag>... [--remove]
  note <who> "<text>" [--kind ${NOTE_KINDS.join("|")}] [--at "YYYY-MM-DD HH:MM"]
                                       --at is in the business's zone (${cfg.time_zone}), also "today 14:30"; default now
  archive <who> [--undo]               never deletes
  merge <keep> <other> [--confirm]     <other> into <keep>: what moves; --confirm merges (not undone)

<who> is an id, an email or a phone number. Custom fields (--field):
${cfg.fields.length ? cfg.fields.map((f) => `  ${f.key} (${f.type}${f.options ? ": " + f.options.join(", ") : ""})`).join("\n") : "  none declared in crm.config.json"}
--as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

const DETAILS = ["email", "phone", "company", "address", "source", "owner", "notes", "field", "as"];
const FILTERS = ["status", "tag", "owner", "archived", "limit"];
const FLAGS: Record<string, string[]> = {
  list: FILTERS, find: FILTERS, show: [], add: [...DETAILS, "status", "tag"], update: [...DETAILS, "name"],
  status: ["as"], tag: ["remove", "as"], note: ["kind", "at", "as"], archive: ["undo", "as"], merge: ["confirm", "as"],
};
/** The words each command takes at most; the free-text ones (find, add, note, status) are not counted. */
const WORDS: Record<string, number> = { list: 0, show: 1, update: 1, archive: 1, merge: 2 };

// Flags that take no value, so `tag 12 --remove vip` keeps vip as the tag.
const a = parseArgs(process.argv.slice(2), { bare: ["archived", "remove", "undo", "confirm"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "customers", FLAGS);
const at = `customers ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
if (cmd === "merge" && rest.length < 2) misused(`${at}: name the record to keep, then the one to merge into it`, "node scripts/customers.mjs merge 12 15");
const json = has(a, "json");
const show = (id: string) => `node scripts/customers.mjs show ${id}`;

function fieldFlags(): ReturnType<typeof readFields> {
  const input: Record<string, string> = {};
  for (const kv of flags(a, "field")) {
    const i = kv.indexOf("=");
    const k = i > 0 ? kv.slice(0, i).trim() : "";
    if (!cfg.fields.some((f) => f.key === k)) misused(`${at}: --field ${kv}: no custom field ${k}; declared: ${cfg.fields.map((f) => f.key).join(", ") || "none"}`, "node scripts/customers.mjs --help");
    input[k] = kv.slice(i + 1);
  }
  const r = readFields(cfg.fields, input);
  if (r.errors.length) misused(`${at}: ${r.errors.join("; ")}`, "node scripts/customers.mjs --help");
  return r;
}

await withDb(async (db) => {
  const stages = await listStages(db, "customers", { archived: true });
  const active = stages.filter((s) => !s.archived);
  const label = (k: string) => stages.find((s) => s.key === k)?.label ?? k;
  const stageList = active.map((s) => `${s.key} (${s.label})`).join(", ");
  const user = who(a);
  const result = (data: unknown, what: string, opts: Parameters<typeof done>[2] = {}) => (json ? out(true, data, String) : done(at, what, opts));

  switch (cmd) {
    case "list":
    case "find": {
      const stage = flag(a, "status");
      const st = stage ? resolveStage(stages, stage) : undefined;
      if (stage && !st) misused(`${at}: no status ${stage}; statuses: ${stageList}`, "node scripts/stages.mjs list --statuses");
      const limit = limitOf(a, at);
      const q = cmd === "find" ? rest.join(" ").trim() || misused(`${at}: find what? a name, email, phone or company`, 'node scripts/customers.mjs find "lee"') : null;
      const f = { ...NO_FILTER, q, stage: st?.key ?? null, tag: flag(a, "tag") ?? null, owner: flag(a, "owner") ?? null, archived: has(a, "archived") };
      const { page, next } = cut(await listPage(db, f, null, limit), limit);
      const many = cfg.vocabulary.many.toLowerCase();
      if (!page.length) return result(page, q ? `no ${many} match "${q}"` : `no ${many}${st ? ` in ${st.label}` : ""}`, { next: q ? "node scripts/inbox.mjs --unmatched" : 'node scripts/customers.mjs add "<name>" --email <email>' });
      return result(page, `${page.length} ${many}${q ? ` matching "${q}"` : ""}${st ? ` in ${st.label}` : ""}`, {
        lines: [...page.map((c) => fmtCustomer(c, label(c.stage))), ...(next ? [`the first ${limit}; --limit ${Math.min(limit * 4, 1000)} for more`] : [])],
      });
    }

    case "show": {
      const c = await resolveCustomer(db, rest[0], at);
      const [notes, visits, history, deals, followUps] = await Promise.all([
        listNotes(db, c.id, 20), visitsCfg ? customerVisits(db, c.id, 20) : [], everythingFrom(db, c, 20), customerDeals(db, c.id, 20), customerFollowUps(db, c.id),
      ]);
      const dealStage = new Map((await listStages(db, "deals", { archived: true })).map((s) => [s.key, s.label]));
      return result({ customer: c, notes, visits, history: history.items, deals, followUps: followUps.open }, fmtCustomer(c, label(c.stage)), {
        lines: [
          c.address ? `address: ${c.address}` : "",
          c.source ? `source: ${c.source}` : "",
          ...Object.entries(c.fields ?? {}).map(([k, v]) => `${cfg.fields.find((f) => f.key === k)?.label ?? k}: ${String(v)}`),
          c.notes ? `about: ${c.notes}` : "",
          followUps.open.length
            ? "follow-ups:\n" + followUps.open.map((f) => `  #${f.id} ${f.due_on}${f.due_time ? " " + f.due_time : ""} ${f.kind}: ${f.title}${f.owner ? " @" + f.owner : ""}`).join("\n")
            : "nothing planned",
          deals.length
            ? `${dealsCfg.many.toLowerCase()}:\n` + deals.map((d) => `  #${d.id} ${d.title} [${dealStage.get(d.stage) ?? d.stage}]${d.shown_cents !== null ? " " + money(d.shown_cents, d.currency ?? dealsCfg.currency) : ""}`).join("\n")
            : `no ${dealsCfg.many.toLowerCase()}`,
          notes.length ? "notes:\n" + notes.map((n) => `  ${local(n.happened_at)} ${n.kind}${n.author ? " " + n.author : ""}: ${n.body}`).join("\n") : "no notes",
          visitsCfg
            ? visits.length
              ? `${visitsCfg.many.toLowerCase()}:\n` + visits.map((x) => `  #${x.id} ${x.starts_at ? local(x.starts_at) : "not scheduled"} [${x.status}] ${x.title}`).join("\n")
              : `no ${visitsCfg.many.toLowerCase()}`
            : "",
          history.items.length
            ? "from this person:\n" + history.items.map((i) => `  ${local(i.at)} ${i.kind === "submission" ? i.form_title || i.form_key : i.kind} (${i.status})`).join("\n")
            : "nothing from this person in forms, bookings or payments",
        ].filter(Boolean),
      });
    }

    case "add": {
      const name = clean(rest.join(" "), 200);
      const email = normalizeEmail(flag(a, "email"));
      if (flag(a, "email") && !email) misused(`${at}: --email ${flag(a, "email")} is not an email address`, 'node scripts/customers.mjs add "Ann Lee" --email ann@example.com');
      const phone = clean(flag(a, "phone"), 40);
      if (!name && !email && !phoneKey(phone)) misused(`${at}: it needs a name, an --email or a --phone`, 'node scripts/customers.mjs add "Ann Lee" --email ann@example.com');
      const stageArg = flag(a, "status");
      const st = (stageArg ? resolveStage(active, stageArg) : await firstOpenStage(db, "customers")) ?? misused(`${at}: no status ${stageArg ?? ""}; statuses: ${stageList}`, "node scripts/stages.mjs list --statuses");
      const fr = fieldFlags();
      const r = await createCustomer(
        db,
        {
          name: name ?? email ?? phone!,
          email,
          phone,
          company: clean(flag(a, "company"), 200),
          address: clean(flag(a, "address"), 500),
          stage: st.key,
          source: clean(flag(a, "source"), 100),
          tags: parseTags(flags(a, "tag")),
          owner: clean(flag(a, "owner"), 200),
          notes: clean(flag(a, "notes"), 10_000),
          fields: fr.set,
        },
        user,
      );
      const line = fmtCustomer(r.customer, label(r.customer.stage));
      return r.created
        ? result(r, `added ${line}`, { next: show(r.customer.id) })
        : result(r, `already here, not added: ${line}`, { lines: ["the same email or phone; left alone"], next: show(r.customer.id) });
    }

    case "update": {
      const c = await resolveCustomer(db, rest[0], at);
      const patch: Partial<Details> = {};
      for (const k of ["name", "email", "phone", "company", "address", "source", "owner", "notes"] as const) {
        if (!has(a, k)) continue;
        const v = flag(a, k) ?? "";
        if (k === "email") {
          if (v && !normalizeEmail(v)) misused(`${at}: --email ${v} is not an email address`, `node scripts/customers.mjs update ${c.id} --email ann@example.com`);
          patch.email = normalizeEmail(v);
        } else if (k === "name") patch.name = clean(v, 200) ?? misused(`${at}: --name cannot be empty`, `node scripts/customers.mjs update ${c.id} --name "Ann Lee"`);
        else patch[k] = clean(v, k === "notes" ? 10_000 : 500);
      }
      const fr = fieldFlags();
      if (!Object.keys(patch).length && !Object.keys(fr.set).length && !fr.unset.length) misused(`${at}: nothing to change; name a flag such as --phone`, "node scripts/customers.mjs --help");
      patch.fields = fr.set;
      patch.unset = fr.unset;
      const r = await patchCustomer(db, c.id, patch, user);
      if (!r.ok) {
        if (r.reason === "email-taken") fail(`${at}: another customer already has ${patch.email}; nothing saved`, `node scripts/customers.mjs find ${patch.email}`);
        fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      }
      return result(r.customer, `updated ${fmtCustomer(r.customer, label(r.customer.stage))}`, { next: show(c.id) });
    }

    case "status": {
      const c = await resolveCustomer(db, rest[0], at);
      const want = rest.slice(1).join(" ");
      if (!want) misused(`${at}: to which status? statuses: ${stageList}`, `node scripts/customers.mjs status ${c.id} ${active[0]?.key ?? "lead"}`);
      const st = resolveStage(active, want) ?? misused(`${at}: no active status ${want}; statuses: ${stageList}`, "node scripts/stages.mjs list --statuses");
      if (c.stage === st.key) return result(c, `${c.name} is already in ${st.label}; left alone`, { next: show(c.id) });
      const r = (await setStage(db, c.id, st.key, user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(r, `${r.name}: ${label(c.stage)} -> ${st.label}`, { next: show(c.id) });
    }

    case "tag": {
      const c = await resolveCustomer(db, rest[0], at);
      const tags = parseTags(rest.slice(1));
      if (!tags.length) misused(`${at}: which tags?`, `node scripts/customers.mjs tag ${c.id} vip`);
      const remove = has(a, "remove");
      const lower = c.tags.map((t) => t.toLowerCase());
      const fmtTags = (t: string[]) => (t.length ? t.map((x) => `#${x}`).join(" ") : "no tags");
      if (tags.every((t) => lower.includes(t.toLowerCase()) !== remove)) {
        return result(c, `${c.name} ${remove ? "has none of" : "already has"} ${fmtTags(tags)}; left alone`, { lines: [`tags: ${fmtTags(c.tags)}`] });
      }
      const r = (await retag(db, c.id, remove ? [] : tags, remove ? tags : [], user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(r, `${r.name}: ${fmtTags(r.tags)}`, { next: show(c.id) });
    }

    case "note": {
      const c = await resolveCustomer(db, rest[0], at);
      const body = rest.slice(1).join(" ").trim();
      if (!body) misused(`${at}: it needs the text`, `node scripts/customers.mjs note ${c.id} "Called, left a message"`);
      const kind = pickNoteKind(flag(a, "kind") ?? "note") ?? misused(`${at}: --kind must be one of ${NOTE_KINDS.join(", ")}`, `node scripts/customers.mjs note ${c.id} "..." --kind call`);
      const when = flag(a, "at");
      const wall = when ? (wallTime(when) ?? relativeWall(when, cfg.time_zone)) : null;
      if (when && !wall) misused(`${at}: --at ${when}: write it as "YYYY-MM-DD HH:MM", or "today 14:30", in ${cfg.time_zone}`, `node scripts/customers.mjs note ${c.id} "..." --at "today 14:30"`);
      const n = (await addNote(db, c.id, { kind, body, at: wall, timeZone: cfg.time_zone }, user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(n, `noted on ${c.name}: ${kind} at ${local(n.happened_at)} (${cfg.time_zone})`, { next: show(c.id) });
    }

    case "archive": {
      const c = await resolveCustomer(db, rest[0], at);
      const archive = !has(a, "undo");
      if (!!c.archived_at === archive) return result(c, `${c.name} is already ${archive ? "archived" : "active"}; left alone`);
      const r = (await setArchived(db, c.id, archive, user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(r, `${r.name}: ${r.archived_at ? "archived" : "active again"}`, { next: show(c.id) });
    }

    case "merge": {
      const keep = await resolveCustomer(db, rest[0], at);
      const other = await resolveCustomer(db, rest[1], at);
      if (keep.id === other.id) misused(`${at}: <keep> and <other> are the same record (#${keep.id})`, `node scripts/customers.mjs find ${JSON.stringify(keep.name)}`);
      if (other.merged_into) return result(other, `#${other.id} was already merged into #${other.merged_into}; left alone`, { next: show(other.merged_into) });
      const pv = (await mergePreview(db, keep.id, other.id)) ?? fail(`${at}: one of them is gone`, "node scripts/customers.mjs list");
      const lines = [
        `moves: ${pv.moves.notes} notes, ${pv.moves.deals} deals, ${pv.moves.followUps} follow-ups${visitsCfg ? `, ${pv.moves.visits} ${visitsCfg.many.toLowerCase()}` : ""}`,
        pv.fills.length ? `${keep.name} gains: ${pv.fills.join(", ")}` : `${keep.name} keeps every detail it has`,
        `#${other.id} is archived and opens #${keep.id}; not undone`,
      ];
      if (!has(a, "confirm")) return result(pv, `would merge #${other.id} ${other.name} into #${keep.id} ${keep.name}`, { lines: [...lines, `Nothing was merged. If the owner said yes: node scripts/customers.mjs merge ${keep.id} ${other.id} --confirm`] });
      const r = await mergeCustomers(db, keep.id, other.id, user);
      if (!r.ok) fail(`${at}: not merged: ${r.reason === "merged" ? "one of them was merged meanwhile" : "one of them is gone"}`, `node scripts/customers.mjs show ${keep.id}`);
      return result(r.customer, `merged #${other.id} ${other.name} into ${fmtCustomer(r.customer, label(r.customer.stage))}`, { lines: lines.slice(0, 2), next: show(keep.id) });
    }
  }
});
