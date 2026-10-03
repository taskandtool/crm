// Customers from chat: list, find, show, add, update, stage, tag, note,
// archive, follow-up. `node scripts/customers.mjs --help`.
import { cfg, visitsCfg } from "../src/config";
import { cut } from "../src/admin/keyset";
import {
  createCustomer, followUps, listPage, patchCustomer, retag, setArchived, setStage, NO_FILTER, type Details,
} from "../src/crm/customers";
import { readFields } from "../src/crm/fields";
import { everythingFrom } from "../src/crm/history";
import { addNote, listNotes, pickNoteKind, NOTE_KINDS } from "../src/crm/notes";
import { phoneKey } from "../src/crm/phone";
import { customerVisits } from "../src/crm/visits";
import { firstOpenStage, listStages, resolveStage } from "../src/crm/stages";
import { clean, parseTags, wallTime } from "../src/crm/text";
import { normalizeEmail } from "../src/data/email";
import { fail, flag, flags, fmtCustomer, has, local, out, parseArgs, resolveCustomer, who, withDb } from "./lib";

const HELP = `customers.mjs <command> [...] [--json] [--as <email>]

  list [--stage s] [--tag t] [--owner o] [--archived] [--limit 50]
  find <text>                          name, email, phone or company
  show <who>                           details, notes, visits, and what they sent, booked and paid
  add "<name>" [--email e] [--phone p] [--company c] [--address a] [--stage s]
               [--source s] [--tag t]... [--owner o] [--notes n] [--field key=value]...
                                       an email or phone already here is reported, not added twice
  update <who> [--name n] [--email e] [--phone p] [--company c] [--address a] [--source s]
               [--owner o] [--notes n] [--field key=value]...      "" clears a value
  stage <who> <stage>                  a stage key or label
  tag <who> <tag>... [--remove]
  note <who> "<text>" [--kind ${NOTE_KINDS.join("|")}] [--at "YYYY-MM-DD HH:MM"]
                                       --at is in the business's zone (${cfg.time_zone}); default now
  archive <who> [--undo]               never deletes
  follow-up [--days 14]                open ${cfg.vocabulary.many.toLowerCase()} nobody has been in touch with for that long

<who> is an id, an email or a phone number. Custom fields (--field):
${cfg.fields.length ? cfg.fields.map((f) => `  ${f.key} (${f.type}${f.options ? ": " + f.options.join(", ") : ""})`).join("\n") : "  none declared in crm.config.json"}
--as records who acted (default CRM_USER, else AI).`;

const a = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = a._;
if (!cmd || has(a, "help")) {
  console.log(HELP);
  process.exit(cmd || has(a, "help") ? 0 : 1);
}
const json = has(a, "json");

function fieldFlags(): ReturnType<typeof readFields> {
  const input: Record<string, string> = {};
  for (const kv of flags(a, "field")) {
    const i = kv.indexOf("=");
    const k = i > 0 ? kv.slice(0, i).trim() : "";
    if (!cfg.fields.some((f) => f.key === k)) fail(`--field ${kv}: no custom field ${k}; declared: ${cfg.fields.map((f) => f.key).join(", ") || "none"}`);
    input[k] = kv.slice(i + 1);
  }
  const r = readFields(cfg.fields, input);
  if (r.errors.length) fail(r.errors.join("\n"));
  return r;
}

await withDb(async (db) => {
  const stages = await listStages(db, { archived: true });
  const label = (k: string) => stages.find((s) => s.key === k)?.label ?? k;
  const user = who(a);

  switch (cmd) {
    case "list":
    case "find": {
      const stage = flag(a, "stage");
      const st = stage ? resolveStage(stages, stage) : undefined;
      if (stage && !st) fail(`no stage ${stage}; stages: ${stages.map((s) => `${s.key} (${s.label})`).join(", ")}`);
      const limit = Math.min(Number(flag(a, "limit") ?? 50) || 50, 1000);
      const f = {
        ...NO_FILTER,
        q: cmd === "find" ? rest.join(" ").trim() || fail("find what?") : null,
        stage: st?.key ?? null,
        tag: flag(a, "tag") ?? null,
        owner: flag(a, "owner") ?? null,
        archived: has(a, "archived"),
      };
      const { page, next } = cut(await listPage(db, f, null, limit), limit);
      return out(json, page, () => (page.length ? page.map((c) => fmtCustomer(c, label(c.stage))).join("\n") + (next ? `\n... more; raise --limit` : "") : "none"));
    }

    case "show": {
      const c = await resolveCustomer(db, rest[0]);
      const [notes, visits, history] = await Promise.all([listNotes(db, c.id, 20), visitsCfg ? customerVisits(db, c.id, 20) : [], everythingFrom(db, c, 20)]);
      return out(json, { customer: c, notes, visits, history: history.items }, () =>
        [
          fmtCustomer(c, label(c.stage)),
          c.address ? `address: ${c.address}` : "",
          c.source ? `source: ${c.source}` : "",
          ...Object.entries(c.fields ?? {}).map(([k, v]) => `${cfg.fields.find((f) => f.key === k)?.label ?? k}: ${String(v)}`),
          c.notes ? `about: ${c.notes}` : "",
          notes.length ? "notes:\n" + notes.map((n) => `  ${local(n.happened_at)} ${n.kind}${n.author ? " " + n.author : ""}: ${n.body}`).join("\n") : "no notes",
          visitsCfg
            ? visits.length
              ? `${visitsCfg.many.toLowerCase()}:\n` + visits.map((x) => `  #${x.id} ${x.starts_at ? local(x.starts_at) : "not scheduled"} [${x.status}] ${x.title}`).join("\n")
              : `no ${visitsCfg.many.toLowerCase()}`
            : "",
          history.items.length
            ? "from this person:\n" + history.items.map((i) => `  ${local(i.at)} ${i.kind === "submission" ? i.form_title || i.form_key : i.kind} (${i.status})`).join("\n")
            : "nothing from this person in forms, bookings or payments",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    case "add": {
      const name = clean(rest.join(" "), 200);
      const email = normalizeEmail(flag(a, "email"));
      if (flag(a, "email") && !email) fail(`--email ${flag(a, "email")} is not an email address`);
      const phone = clean(flag(a, "phone"), 40);
      if (!name && !email && !phoneKey(phone)) fail("add needs a name, an --email or a --phone");
      const stageArg = flag(a, "stage");
      const st = stageArg ? resolveStage(stages.filter((s) => !s.archived), stageArg) : await firstOpenStage(db);
      if (!st) fail(`no stage ${stageArg}; stages: ${stages.filter((s) => !s.archived).map((s) => s.key).join(", ")}`);
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
      return out(json, r, () => (r.created ? "added " : "already here, not added: ") + fmtCustomer(r.customer, label(r.customer.stage)));
    }

    case "update": {
      const c = await resolveCustomer(db, rest[0]);
      const patch: Partial<Details> = {};
      for (const k of ["name", "email", "phone", "company", "address", "source", "owner", "notes"] as const) {
        if (!has(a, k)) continue;
        const v = flag(a, k) ?? "";
        if (k === "email") {
          if (v && !normalizeEmail(v)) fail(`--email ${v} is not an email address`);
          patch.email = normalizeEmail(v);
        } else if (k === "name") patch.name = clean(v, 200) ?? fail("--name cannot be empty");
        else patch[k] = clean(v, k === "notes" ? 10_000 : 500);
      }
      const fr = fieldFlags();
      patch.fields = fr.set;
      patch.unset = fr.unset;
      const r = await patchCustomer(db, c.id, patch, user);
      if (!r.ok) fail(r.reason === "email-taken" ? "another customer already has that email; nothing saved" : "not found");
      return out(json, r.customer, () => "updated " + fmtCustomer(r.customer, label(r.customer.stage)));
    }

    case "stage": {
      const c = await resolveCustomer(db, rest[0]);
      const st = resolveStage(stages.filter((s) => !s.archived), rest.slice(1).join(" "));
      if (!st) fail(`no active stage ${rest.slice(1).join(" ")}; stages: ${stages.filter((s) => !s.archived).map((s) => `${s.key} (${s.label})`).join(", ")}`);
      const r = await setStage(db, c.id, st.key, user);
      if (!r) fail("not found");
      return out(json, r, () => `${r.name}: ${label(c.stage)} -> ${st.label}`);
    }

    case "tag": {
      const c = await resolveCustomer(db, rest[0]);
      const tags = parseTags(rest.slice(1));
      if (!tags.length) fail("which tags?");
      const r = has(a, "remove") ? await retag(db, c.id, [], tags, user) : await retag(db, c.id, tags, [], user);
      if (!r) fail("not found");
      return out(json, r, () => `${r.name}: ${r.tags.length ? r.tags.map((t) => `#${t}`).join(" ") : "no tags"}`);
    }

    case "note": {
      const c = await resolveCustomer(db, rest[0]);
      const body = rest.slice(1).join(" ").trim();
      if (!body) fail('note needs the text: note <who> "Called, left a message"');
      const kind = pickNoteKind(flag(a, "kind") ?? "note");
      if (!kind) fail(`--kind must be one of ${NOTE_KINDS.join(", ")}`);
      const at = flag(a, "at");
      const wall = at ? wallTime(at) : null;
      if (at && !wall) fail(`--at ${at}: write it as "YYYY-MM-DD HH:MM", in ${cfg.time_zone}`);
      const n = await addNote(db, c.id, { kind, body, at: wall, timeZone: cfg.time_zone }, user);
      if (!n) fail("not found");
      return out(json, n, () => `noted on ${c.name}: ${kind} at ${local(n.happened_at)} (${cfg.time_zone})`);
    }

    case "archive": {
      const c = await resolveCustomer(db, rest[0]);
      const r = await setArchived(db, c.id, !has(a, "undo"), user);
      if (!r) fail("not found");
      return out(json, r, () => `${r.name}: ${r.archived_at ? "archived" : "active"}`);
    }

    case "follow-up": {
      const days = Number(flag(a, "days") ?? 14);
      if (!Number.isInteger(days) || days < 0) fail("--days must be a whole number");
      const rows = await followUps(db, days, Number(flag(a, "limit") ?? 50) || 50);
      return out(json, rows, () =>
        rows.length ? rows.map((c) => `${fmtCustomer(c, label(c.stage))}  quiet ${c.quiet_days} days`).join("\n") : `nobody open has been quiet for ${days} days`,
      );
    }

    default:
      fail(`unknown command ${cmd}\n\n${HELP}`);
  }
});
