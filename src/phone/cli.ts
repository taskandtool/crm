// The phone from chat: where it stands, the six automatic texts and their
// words, the texting registration, the threads, and a text sent for the
// owner. The same command in every app that carries this skill; an app's
// scripts/phone.mjs passes its settings. Machine only.
//
//   await phoneCli(process.argv.slice(2), { withDb, ctx: (db) => phoneCtxFor(db) });
import { done, fail, flag, has, localTime, misused, noMore, parseArgs, usage } from "../data/cli.mjs";
import { businessOf } from "../data/business";
import type { Db } from "../data/db";
import { FILL_SAYS, FLOWS, flowOf, flowSettings, isFlowKey, resetFlow, setEnabled, setTiming, setWords, WORDS, fill } from "./flows";
import { exampleFill } from "./follow";
import { check, optInPage, steps } from "./registration";
import { sendText, type PhoneCtx } from "./send";
import { mainNumber, numbers, prettyPhone, thread, threads, toE164 } from "./store";
import { phoneKey } from "../customers/customer";
import { twilioConnected } from "./twilio";

export type PhoneCli = {
  withDb: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  /** The phone context for this database: the owner's Twilio, the business, where links go. */
  ctx: (db: Db) => PhoneCtx | Promise<PhoneCtx>;
  timeZone: string;
};

const HELP = `phone.mjs <command> [...] [--json]      the business number, its texts and calls

  status                               Twilio, the number, the phone it rings, texting, each flow on or off
  numbers [--area 512]                 the numbers in use; with --area, ones Twilio offers to buy
                                       (the owner chooses and buys one in Settings, Phone and texts)
  flows                                the six automatic texts: on or off, their words and timing
  flow <key>                           one flow's steps as its page shows them, with an example filled in
  set <key> [--on|--off] [--words "…" --variant <v>] [--timing <minutes>] [--reset]
                                       change a flow; --reset brings back our words, timing and switch.
                                       Words keep their {fill-ins} (each flow's are in "flow <key>"); a link
                                       the owner wants goes in the words as it is.
  registration [--check]               the US texting registration's steps (made in Twilio's Console); --check reads Twilio now
  threads [--unread] [--limit 20]      who texted or called, newest first
  thread <number>                      one number's texts and calls
  send <number> "<text>" --confirm     text a customer from the business number. Texting a real phone
                                       can't be undone: without --confirm it shows what would go and sends nothing.

Flow keys: ${FLOWS.map((f) => `${f.key} (${f.name})`).join(", ")}.

Prints what happened first, then Next:. Errors go to stderr with a Try: line; exit 1 when refused, 2 when misused.`;

export async function phoneCli(argv: string[], cli: PhoneCli): Promise<void> {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  usage(a, cmd, ["status", "numbers", "flows", "flow", "set", "registration", "threads", "thread", "send"], HELP, "phone", {
    status: [], numbers: ["area"], flows: [], flow: [], set: ["on", "off", "words", "variant", "timing", "reset"],
    registration: ["check"], threads: ["unread", "limit"], thread: [], send: ["confirm"],
  });
  const at = `phone ${cmd}`;
  const json = has(a, "json");
  noMore(rest, cmd === "send" ? 2 : cmd === "flow" || cmd === "set" || cmd === "thread" ? 1 : 0, at);
  /** JSON for another script, or the text for the AI. */
  const show = (data: unknown, text: () => void) => (json ? console.log(JSON.stringify(data, null, 2)) : text());
  const keyOf = () => {
    const k = rest[0];
    if (!isFlowKey(k)) misused(`${at}: name a flow: ${FLOWS.map((f) => f.key).join(", ")}`, "node scripts/phone.mjs flows");
    return k;
  };

  await cli.withDb(async (db) => {
    const ctx = await cli.ctx(db);
    switch (cmd) {
      case "status": {
        const connected = ctx.provider ? await twilioConnected(ctx.env) : false;
        const n = await mainNumber(db);
        const s = await flowSettings(db);
        const data = {
          twilio: connected, number: n ? n.e164 : null, ring_to: n?.ring_to ?? null, texting: n?.texting ?? "none",
          flows: Object.fromEntries(FLOWS.map((f) => [f.key, s[f.key].enabled])),
        };
        return show(data, () => {
          const lines = [
            `Twilio: ${connected === null ? "didn't answer just now" : connected ? "connected" : "not connected (the owner connects it on the app's Connections tab)"}`,
            `number: ${n ? `${prettyPhone(n.e164)}, rings ${n.ring_to ? prettyPhone(n.ring_to) : "nobody yet"}` : "none yet (Settings, Phone and texts)"}`,
            `texting: ${n?.texting === "approved" ? "approved" : n?.texting === "pending" ? "waiting for Twilio's approval (registration)" : n?.texting === "failed" ? "turned down (registration says why)" : "not registered yet"}`,
            ...FLOWS.map((f) => `${f.key}: ${s[f.key].enabled ? "on" : "off"}`),
          ];
          const state = connected === null ? "Twilio didn't answer" : !connected ? "no Twilio" : !n ? "Twilio, no number" : n.texting === "approved" ? "calls and texts" : "calls only";
          console.log([`phone status: ${state}`, ...lines.map((l) => `  ${l}`), "", `Next: ${connected === null ? "run it again in a minute" : !connected ? "ask the owner to connect Twilio, then walk them through Settings, Phone and texts" : !n ? "the owner picks a number in Settings, Phone and texts" : "node scripts/phone.mjs flows"}`].join("\n"));
        });
      }
      case "numbers": {
        const area = flag(a, "area");
        if (area !== undefined) {
          if (!/^\d{3}$/.test(area)) misused(`${at}: --area is a 3-digit area code`, "node scripts/phone.mjs numbers --area 512");
          if (!ctx.provider) fail(`${at}: Twilio isn't connected`, "node scripts/phone.mjs status");
          const offered = await ctx.provider.searchNumbers({ areaCode: area, limit: 10 });
          return show(offered, () => (offered.length ? done(at, `${offered.length} numbers Twilio offers in ${area}`, { lines: offered.map((o) => `${o.pretty} ${[o.locality, o.region].filter(Boolean).join(", ")}`), next: "the owner chooses one in Settings, Phone and texts (buying costs money on their Twilio)" }) : done(at, `none in ${area} just now`, { next: "try a neighbouring area code" })));
        }
        const list = await numbers(db);
        return show(list.map((n) => ({ e164: n.e164, label: n.label, ring_to: n.ring_to, texting: n.texting })), () =>
          done(at, list.length ? `${list.length} in use` : "none yet", { lines: list.map((n) => `${prettyPhone(n.e164)} ${n.label}${n.ring_to ? `, rings ${prettyPhone(n.ring_to)}` : ""}`), next: "node scripts/phone.mjs status" }));
      }
      case "flows": {
        const s = await flowSettings(db);
        const data = FLOWS.map((f) => ({ key: f.key, name: f.name, on: s[f.key].enabled, timing: s[f.key].timing, words: s[f.key].words, changed: s[f.key].changed }));
        return show(data, () => {
          const lines = FLOWS.flatMap((f) => [
            `${f.key} (${f.name}): ${s[f.key].enabled ? "on" : "off"}${s[f.key].timing ? `, timing ${s[f.key].timing} minutes` : ""}${s[f.key].changed ? ", changed by the owner" : ""}`,
            ...Object.entries(s[f.key].words).map(([v, w]) => `  ${v}: ${w}`),
            `  fill-ins: ${f.fills.map((k) => `{${k}}`).join(", ")}`,
          ]);
          done(at, "the six automatic texts", { lines, next: `node scripts/phone.mjs set <key> --words "…" --variant <v>` });
        });
      }
      case "flow": {
        const key = keyOf();
        const f = flowOf(key);
        const s = (await flowSettings(db))[key];
        const ex = await exampleFill(ctx);
        const lines = f.steps(s.timing).flatMap((st) =>
          st.kind === "text"
            ? [...st.variants.map((v) => `Sends${v.label ? ` (${v.label.replace(/:$/, "")})` : ""}: ${fill(s.words[v.key] ?? WORDS[key][v.key], ex)}`), ...(st.replies ?? []).map((r) => `  ${r.when}: ${r.then}`)]
            : [`${st.kind === "start" ? "Starts" : st.kind === "wait" ? "Waits" : "Ends"}: ${st.says}`],
        );
        lines.push(`Stops early when: ${f.stops.join("; ")}`, `Where: ${f.where}`, `Fill-ins: ${f.fills.map((k) => `{${k}}: ${FILL_SAYS[k]}`).join("; ")}`);
        if (!s.enabled) lines.push("It is off.");
        return show({ key, steps: lines }, () => done(at, f.name, { lines, next: `node scripts/phone.mjs set ${key} --words "…" --variant <v>` }));
      }
      case "set": {
        const key = keyOf();
        const by = "ai";
        const said: string[] = [];
        if (has(a, "reset")) {
          if (Object.keys(a.flags).some((k) => !["reset", "json"].includes(k))) misused(`${at}: --reset goes alone`, `node scripts/phone.mjs set ${key} --reset`);
          await resetFlow(db, key);
          return done(at, `${flowOf(key).name} is back to our words, timing and switch`, { next: `node scripts/phone.mjs flow ${key}` });
        }
        if (has(a, "on") && has(a, "off")) misused(`${at}: --on or --off, not both`, `node scripts/phone.mjs set ${key} --on`);
        if (has(a, "on") || has(a, "off")) {
          await setEnabled(db, key, has(a, "on"), by);
          said.push(has(a, "on") ? "switched on" : "switched off");
        }
        if (has(a, "words")) {
          const variant = flag(a, "variant") ?? (Object.keys(WORDS[key]).length === 1 ? Object.keys(WORDS[key])[0] : misused(`${at}: --words needs --variant, one of ${Object.keys(WORDS[key]).join(", ")}`, `node scripts/phone.mjs flow ${key}`));
          const r = await setWords(db, key, variant, flag(a, "words") ?? "", by);
          if (!r.ok) fail(`${at}: ${r.why}`, `node scripts/phone.mjs flow ${key}`);
          said.push(`new "${variant}" words${r.texts > 1 ? `; it sends as ${r.texts} texts with long names (one text is 160 characters)` : ""}`);
        }
        if (has(a, "timing")) {
          const r = await setTiming(db, key, Number(flag(a, "timing")), by);
          if (!r.ok) fail(`${at}: ${r.why}`, `node scripts/phone.mjs flows`);
          said.push(`waits ${flag(a, "timing")} minutes`);
        }
        if (!said.length) misused(`${at}: say what to change: --on, --off, --words, --timing or --reset`, `node scripts/phone.mjs set ${key} --on`);
        return done(at, `${flowOf(key).name}: ${said.join(", ")}`, { next: `node scripts/phone.mjs flow ${key}, and show the owner its page in Settings, Phone and texts` });
      }
      case "registration": {
        const n = await mainNumber(db);
        if (!n) fail(`${at}: there's no business number yet`, "node scripts/phone.mjs status");
        let cur = n;
        if (has(a, "check")) {
          if (!ctx.provider) fail(`${at}: Twilio isn't connected`, "node scripts/phone.mjs status");
          const r = await check(db, ctx.provider, n);
          cur = { ...n, texting: r.texting, registration: r.reg };
        }
        const rows = steps(cur, await businessOf(db), await optInPage(db, await ctx.links()), await flowSettings(db));
        return show({ texting: cur.texting, steps: rows, error: cur.registration.last_error ?? null }, () =>
          done(at, `texting ${cur.texting}`, { lines: [...rows.map((r) => `${r.label}: ${r.state}. ${r.says}${r.errors.length ? ` (${r.errors.join("; ")})` : ""}${r.where && r.state !== "done" ? ` In ${r.where}.` : ""}`), ...(cur.registration.last_error ? [`last error: ${cur.registration.last_error}`] : [])], next: cur.texting === "approved" ? "node scripts/phone.mjs flows" : "the owner registers in Twilio's Console with the words on Settings, Phone and texts, step 4 (Copy each); --check reads it back" }));
      }
      case "threads": {
        const list = await threads(db, { unread: has(a, "unread"), limit: Math.min(Number(flag(a, "limit") ?? 20) || 20, 200) });
        return show(list, () =>
          done(at, list.length ? `${list.length} threads` : "none", { lines: list.map((t) => `${t.contact_name ?? prettyPhone(t.remote_e164)} ${prettyPhone(t.remote_e164)}  ${t.unread ? `${t.unread} unread  ` : ""}${t.last_kind === "call" ? (t.last_voicemail ? "voicemail" : "call") : (t.last_direction === "out" ? "us: " : "") + (t.last_body ?? "").slice(0, 80)}  ${localTime(t.last_at, cli.timeZone)}`), next: "node scripts/phone.mjs thread <number>" }));
      }
      case "thread": {
        const key = phoneKey(rest[0] ?? "") ?? misused(`${at}: name a phone number`, "node scripts/phone.mjs threads");
        const rows = await thread(db, key);
        return show(rows, () =>
          done(at, rows.length ? `${rows.length} texts and calls` : "nothing with that number", { lines: rows.map((m) => `${localTime(m.created_at, cli.timeZone)} ${m.direction === "in" ? "them" : m.sent_by?.startsWith("flow:") ? "automatic" : m.sent_by ?? "us"}: ${m.kind === "call" ? `${m.answered_by ? "call" : "missed call"}${m.transcript ? `, voicemail: ${m.transcript}` : ""}` : m.body ?? ""}`) }));
      }
      case "send": {
        const to = toE164(rest[0] ?? "") ?? misused(`${at}: name the phone number first, then the text in quotes`, `node scripts/phone.mjs send "(555) 201-0142" "On our way" --confirm`);
        const body = (rest[1] ?? "").trim() || misused(`${at}: the text, in quotes, after the number`, `node scripts/phone.mjs send ${to} "On our way" --confirm`);
        if (!has(a, "confirm")) return done(at, `would text ${prettyPhone(to)}: ${body}`, { waits: `node scripts/phone.mjs send ${to} ${JSON.stringify(body)}` });
        const r = await sendText(ctx, { to, body, sentBy: "ai" });
        if (!r.ok) fail(`${at}: ${r.why}`, "node scripts/phone.mjs status");
        return done(at, `texted ${prettyPhone(to)}`, { next: `node scripts/phone.mjs thread ${to}` });
      }
    }
  });
}
