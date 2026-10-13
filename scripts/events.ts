// The schedule's events from chat: the same changes as the pages. Each is a
// booking (an online one, or one the team put on the schedule).
// `node scripts/events.mjs --help`.
import { cut } from "../src/admin/keyset";
import { allPeople, allTypes } from "../src/booking/hours";
import { cfg, eventsCfg, ownerLabel } from "../src/config";
import { addEvent, customerEvents, eventsPage, getEvent, LENGTHS, minutesOf, saveEvent, setEventStatus, startWall, type Event, type EventInput } from "../src/crm/events";
import { amountText, clean, parseAmount, relativeWall } from "../src/crm/text";
import { wallTime } from "../src/customers/notes";
import type { Db } from "../src/data/db";
import { done, fieldFlags, fail, flag, has, limitOf, local, misused, noMore, out, parseArgs, resolveCustomer, usage, who, withDb } from "./lib";

const OFF = 'the schedule is off: crm.config.json has "events": false (or none). Turn it on with { "one": "Event", "many": "Events", "fields": [] }.';
const HELP = ((ev) => !ev ? OFF : `events.mjs <command> [...] [--json] [--as <email>]      ${ev.many} on the schedule

  list [--past | --all] [--host <name>] [--find text] [--limit 50]
                                       scheduled (soonest first), past (completed, no-show, cancelled), or all (newest first)
  list --customer <who>                one customer's
  show <id>
  add <who> "<what>" --at "YYYY-MM-DD HH:MM" [--length 60] [--service <name>] [--host <name>]
               [--where w] [--amount 245.00] [--notes n] [--field key=value]...
  update <id> [--what w] [--at ...] [--length m] [--service s] [--host h] [--where w] [--amount a] [--notes n] [--field key=value]...
                                       "" clears a value
  done <id> | no-show <id> | cancel <id>   completed and no-show only once it has started

<who> is a customer's id, email or phone. --at also takes "next friday 9:30", "tomorrow 2pm"; it is in the business's zone
(${cfg.time_zone}). --length is minutes (default 60). --host is a Team member (${ownerLabel}) by name or email; --service a
service by name. --amount is in ${ev.currency}. Custom fields (--field):
${ev.fields.length ? ev.fields.map((f) => `  ${f.key} (${f.type}${f.options ? ": " + f.options.join(", ") : ""})`).join("\n") : "  none declared in crm.config.json's events"}
--as records who acted (default CRM_USER, else AI).

Prints what happened first, then Next:. A re-run says "already" and changes
nothing. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`)(eventsCfg);

const FIELDS = ["at", "length", "service", "host", "where", "amount", "notes", "field", "as"];
const FLAGS: Record<string, string[]> = {
  list: ["past", "all", "host", "find", "limit", "customer"], show: [], add: FIELDS, update: [...FIELDS, "what"],
  done: ["as"], "no-show": ["as"], cancel: ["as"],
};
const WORDS: Record<string, number> = { list: 0, show: 1, update: 1, done: 1, "no-show": 1, cancel: 1 };

const a = parseArgs(process.argv.slice(2), { bare: ["past", "all"] });
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "events", FLAGS);
if (!eventsCfg) fail(OFF, "node scripts/events.mjs --help");
const at = `events ${cmd}`;
if (WORDS[cmd] !== undefined) noMore(rest, WORDS[cmd], at);
const ev = eventsCfg;
const one = ev.one.toLowerCase();
const json = has(a, "json");
const show = (id: string) => `node scripts/events.mjs show ${id}`;

function atFlag(current: string | null): string | null {
  if (!has(a, "at")) return current;
  const when = flag(a, "at") ?? "";
  const wall = wallTime(when) ?? relativeWall(when, cfg.time_zone);
  if (!wall) misused(`${at}: --at ${when}: write it as "YYYY-MM-DD HH:MM", or "next friday 9:30", "tomorrow 2pm", in ${cfg.time_zone}`, "node scripts/events.mjs --help");
  return wall;
}

function lengthFlag(current: number): number {
  if (!has(a, "length")) return current;
  const m = Number(flag(a, "length"));
  if (!Number.isInteger(m) || m < 5 || m > 1440) misused(`${at}: --length is minutes, 5 to 1440, such as ${LENGTHS.slice(0, 4).join(", ")}`, "node scripts/events.mjs --help");
  return m;
}

function amountFlag(current: number | null): number | null {
  if (!has(a, "amount")) return current;
  const r = parseAmount(flag(a, "amount") ?? "", ev.currency);
  if (r === "invalid") misused(`${at}: --amount ${flag(a, "amount")}: a plain amount in ${ev.currency}, such as 245.00`, "node scripts/events.mjs --help");
  return r;
}

/** A Team member by name or email ("" is nobody). */
async function hostFlag(db: Db, current: string | null): Promise<string | null> {
  if (!has(a, "host")) return current;
  const name = (flag(a, "host") ?? "").trim().toLowerCase();
  if (!name) return null;
  const team = await allPeople(db);
  const p = team.find((r) => r.name.toLowerCase() === name || r.email?.toLowerCase() === name);
  return p?.id ?? fail(`${at}: nobody on the Team is ${flag(a, "host")}${team.length ? ` (the Team: ${team.map((r) => r.name).join(", ")})` : ""}`, "node scripts/events.mjs --help");
}

/** A service by name or its page address ("" is none). */
async function serviceFlag(db: Db, current: string | null): Promise<string | null> {
  if (!has(a, "service")) return current;
  const name = (flag(a, "service") ?? "").trim().toLowerCase();
  if (!name) return null;
  const services = await allTypes(db);
  const t = services.find((s) => s.name.toLowerCase() === name || s.slug === name);
  return t?.id ?? fail(`${at}: no service ${flag(a, "service")}${services.length ? ` (the services: ${services.map((s) => s.name).join(", ")})` : ""}`, "node scripts/events.mjs --help");
}

const fmt = (r: Event) =>
  [
    `#${r.id}`,
    local(r.starts_at),
    `[${r.status}]`,
    r.what,
    r.customer_id ? `for ${r.customer_name} (#${r.customer_id})` : `for ${r.name} (not a customer yet)`,
    r.host_name ? `@${r.host_name}` : "",
    r.amount_cents !== null ? `${amountText(r.amount_cents, r.currency ?? ev.currency)} ${r.currency ?? ev.currency}` : "",
    ...ev.fields.map((f) => (r.fields?.[f.key] !== undefined ? `${f.label}: ${String(r.fields[f.key])}` : "")),
  ]
    .filter(Boolean)
    .join("  ");

async function eventOr(db: Db, id: string | undefined): Promise<Event> {
  if (!id || !/^\d{1,18}$/.test(id)) misused(`${at}: name ${/^[aeiou]/.test(one) ? "an" : "a"} ${one} by its id (#12 is 12)`, "node scripts/events.mjs list");
  return (await getEvent(db, id)) ?? fail(`${at}: no ${one} ${id}`, "node scripts/events.mjs list --all");
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
        const rows = await customerEvents(db, c.id, limit + 1);
        const page = rows.slice(0, limit);
        return result(page, page.length ? `${page.length} ${ev.many.toLowerCase()} for ${c.name}` : `no ${ev.many.toLowerCase()} for ${c.name}`, { lines: [...page.map(fmt), ...more(rows.length)] });
      }
      const view = has(a, "all") ? "all" : has(a, "past") ? "past" : "upcoming";
      const host = has(a, "host") ? await hostFlag(db, null) : null;
      const { page, next } = cut(await eventsPage(db, { view, host, q: flag(a, "find") ?? null }, null, limit), limit);
      const what = view === "upcoming" ? "scheduled, soonest first" : view === "past" ? "past, newest first" : "newest first";
      return result(page, page.length ? `${page.length} ${ev.many.toLowerCase()} ${what}` : `no ${ev.many.toLowerCase()} ${what.split(",")[0]}`, {
        lines: [...page.map(fmt), ...(next ? more(limit + 1) : [])],
      });
    }

    case "show": {
      const r = await eventOr(db, rest[0]);
      return result(r, fmt(r), { lines: [r.location ? `where: ${r.location}` : "", r.notes ? `notes: ${r.notes}` : "", `added ${local(r.created_at)}`].filter(Boolean) });
    }

    case "add": {
      const c = await resolveCustomer(db, rest[0], at);
      const title = clean(rest.slice(1).join(" "), 200);
      const type = await serviceFlag(db, null);
      if (!title && !type) misused(`${at}: it needs what it is, or --service`, `node scripts/events.mjs add ${rest[0]} "Annual tune-up" --at "tomorrow 9am"`);
      const wall = atFlag(null) ?? misused(`${at}: it needs --at, when it happens`, `node scripts/events.mjs add ${rest[0]} "${title ?? "Annual tune-up"}" --at "tomorrow 9am"`);
      const fr = fieldFlags(a, ev.fields, at, `${one} field`);
      const input: EventInput = {
        title, type_id: type, at: wall, timeZone: cfg.time_zone, minutes: lengthFlag(60), resource_id: await hostFlag(db, null),
        location: has(a, "where") ? clean(flag(a, "where"), 500) : c.address, amount_cents: amountFlag(null), currency: ev.currency,
        notes: clean(flag(a, "notes"), 10_000), fields: fr.set,
      };
      const r = (await addEvent(db, c, input, user)) ?? fail(`${at}: no customer ${c.id}`, "node scripts/customers.mjs list");
      return result(r, `added ${fmt(r)}`, { next: show(r.id) });
    }

    case "update": {
      const r = await eventOr(db, rest[0]);
      if (!["what", "at", "length", "service", "host", "where", "amount", "notes", "field"].some((k) => has(a, k))) misused(`${at}: nothing to change; name a flag such as --at`, "node scripts/events.mjs --help");
      const fr = fieldFlags(a, ev.fields, at, `${one} field`);
      const amount = amountFlag(r.amount_cents === null ? null : Number(r.amount_cents));
      const title = has(a, "what") ? clean(flag(a, "what"), 200) : r.title;
      const type = await serviceFlag(db, r.type_id);
      if (!title && !type) misused(`${at}: it needs what it is, or a service`, `node scripts/events.mjs update ${r.id} --what "Annual tune-up"`);
      const start = startWall(r, cfg.time_zone);
      const input: EventInput = {
        title, type_id: type, at: atFlag(start) ?? start, timeZone: cfg.time_zone,
        minutes: lengthFlag(minutesOf(r)),
        resource_id: await hostFlag(db, r.resource_id), location: has(a, "where") ? clean(flag(a, "where"), 500) : r.location,
        amount_cents: amount, currency: (amount !== null && r.currency) || ev.currency,
        notes: has(a, "notes") ? clean(flag(a, "notes"), 10_000) : r.notes, fields: fr.set,
      };
      const saved = (await saveEvent(db, r.id, { ...input, unset: fr.unset }, user)) ?? fail(`${at}: no ${one} ${r.id}`, "node scripts/events.mjs list --all");
      return result(saved, `updated ${fmt(saved)}`, { next: show(r.id) });
    }

    case "done":
    case "no-show":
    case "cancel": {
      const r = await eventOr(db, rest[0]);
      const status = cmd === "done" ? "completed" : cmd === "no-show" ? "no_show" : "cancelled";
      if (r.status === status) return result(r, `${one} #${r.id} is already ${status}; left alone`, { lines: [fmt(r)] });
      const changed = await setEventStatus(db, r.id, status, user);
      if (!changed) {
        fail(r.status === "cancelled" ? `${at}: ${one} #${r.id} is cancelled, and stays so` : `${at}: ${one} #${r.id} has not started yet; it is marked ${status === "completed" ? "done" : "a no-show"} once it has`, show(r.id));
      }
      return result(changed, `${one} #${r.id} ${r.status} -> ${status}`, { lines: [fmt(changed)], next: show(r.id) });
    }
  }
});
