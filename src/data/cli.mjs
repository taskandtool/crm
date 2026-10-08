// @ts-check
// What every script an app's AI runs shares: arguments, usage, output,
// failure, and the machine's settings. Machine only (Node). Plain JavaScript,
// so a .mjs script imports it as readily as a .ts one.
//
//   const a = parseArgs(process.argv.slice(2));
//   const [cmd, ...rest] = a._;
//   usage(a, cmd, ["list", "show"], HELP, "forms", { list: ["limit"], show: [] });
//   if (!row) fail(`forms show: no form ${key}`, "node scripts/forms.mjs list");
//   done("forms save", "made form contact, 3 fields", { lines: ["1 step"], next: "node scripts/forms.mjs list" });
//
// The rules a script keeps: the first line says what happened; errors go to
// stderr with what was wrong and the command that works (Try:); exit 0 done,
// 1 refused or failed, 2 used wrongly.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @typedef {{ _: string[], flags: Record<string, string | boolean> }} Args */

/** Flags that never take a value, so `--json contact` keeps contact as an argument. */
const BARE = new Set(["json", "help", "confirm"]);

/** Set by parseArgs: under --json, fail and misused print JSON too. */
let jsonErrors = false;

/** Set by usage and plain: who is speaking, for flag()'s refusal. */
let speaker = { at: "", tryCmd: /** @type {string | undefined} */ (undefined) };

/**
 * `cmd sub "Ann Lee" --tag a --tag b --json`. A repeated flag collects into a
 * list (flags() reads it); a bare flag is true; `-h` is `--help`. `bare` names
 * this script's flags that never take a value, so `--done "Order parts"`
 * keeps the text as an argument.
 * @param {string[]} argv
 * @param {{ bare?: readonly string[] }} [opts]
 * @returns {Args}
 */
export function parseArgs(argv, { bare = [] } = {}) {
  /** @type {Args} */
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") out.flags.help = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      /** @type {string | boolean} */
      let v = true;
      if (inline !== undefined) v = inline;
      else if (!BARE.has(k) && !bare.includes(k) && next !== undefined && !next.startsWith("--")) {
        v = next;
        i++;
      }
      const prev = out.flags[k];
      out.flags[k] = typeof prev === "string" && typeof v === "string" ? `${prev}\u0000${v}` : v;
    } else out._.push(a);
  }
  jsonErrors = out.flags.json !== undefined;
  return out;
}

/**
 * A flag that takes a value: its last value, or undefined when absent. Given
 * with no value (`--board` at the end) it is misuse, never quietly absent.
 * @param {Args} a
 * @param {string} k
 * @returns {string | undefined}
 */
export function flag(a, k) {
  return flags(a, k).pop();
}

/**
 * Every value of a repeatable flag, in order.
 * @param {Args} a
 * @param {string} k
 * @returns {string[]}
 */
export function flags(a, k) {
  const v = a.flags[k];
  if (v === true) misused(`${speaker.at ? `${speaker.at}: ` : ""}--${k} needs a value`, speaker.tryCmd);
  return typeof v === "string" ? v.split("\u0000") : [];
}

/** @type {(a: Args, k: string) => boolean} */
export const has = (a, k) => a.flags[k] !== undefined;

/**
 * Before any database or network: --help prints `help` and exits 0; no
 * command, an unknown one, or a flag the command does not take exits 2.
 * `allowed` maps a command to the flags it takes (--json and --help always
 * pass); a command missing from it is not checked.
 * @param {Args} a
 * @param {string | undefined} cmd
 * @param {readonly string[]} commands
 * @param {string} help
 * @param {string} script
 * @param {Record<string, readonly string[]>} [allowed]
 * @returns {asserts cmd is string}
 */
export function usage(a, cmd, commands, help, script, allowed) {
  if (has(a, "help")) {
    console.log(help);
    process.exit(0);
  }
  const tryHelp = `node scripts/${script}.mjs --help`;
  speaker = { at: cmd ? `${script} ${cmd}` : script, tryCmd: tryHelp };
  if (!cmd) misused(`${script}: name a command; commands: ${commands.join(", ")}`, tryHelp);
  if (!commands.includes(cmd)) misused(`${script} ${cmd}: no such command; commands: ${commands.join(", ")}`, tryHelp);
  const ok = allowed?.[cmd];
  if (ok) checkFlags(a, ok, `${script} ${cmd}`, tryHelp);
}

/**
 * Before anything else, for a script with no subcommand: --help prints `help`
 * and exits 0; a flag it does not take, or an argument when `args` is false,
 * exits 2. Try defaults to its --help.
 * @param {Args} a
 * @param {string} help
 * @param {string} script
 * @param {{ flags?: readonly string[], args?: boolean, tryCmd?: string }} [opts]
 */
export function plain(a, help, script, { flags = [], args = false, tryCmd = `node scripts/${script}.mjs --help` } = {}) {
  speaker = { at: script, tryCmd };
  if (has(a, "help")) {
    console.log(help);
    process.exit(0);
  }
  checkFlags(a, flags, script, tryCmd);
  if (!args && a._.length) misused(`${script}: it takes no arguments (given ${a._.join(" ")})`, tryCmd);
}

/**
 * The flag check alone, for a script with no subcommand: any flag but
 * `allowed`, --json and --help exits 2. `at` is the script's name, or
 * "<script> <command>"; Try defaults to its --help.
 * @param {Args} a
 * @param {readonly string[]} allowed
 * @param {string} at
 * @param {string} [tryCmd]
 */
export function checkFlags(a, allowed, at, tryCmd = `node scripts/${at.split(" ")[0]}.mjs --help`) {
  speaker = { at, tryCmd };
  const bad = Object.keys(a.flags).find((k) => k !== "json" && k !== "help" && !allowed.includes(k));
  if (bad) misused(`${at}: unknown flag --${bad}; valid: ${allowed.map((f) => `--${f}`).join(", ") || "none"}`, tryCmd);
}

/**
 * A stray argument is misuse: the command takes at most `max` words.
 * @param {string[]} rest the words after the command
 * @param {number} max
 * @param {string} at "customers show"
 */
export function noMore(rest, max, at) {
  if (rest.length > max) misused(`${at}: unexpected ${rest.slice(max).join(" ")}`, `node scripts/${at.split(" ")[0]}.mjs --help`);
}

/**
 * --limit as a whole number from 1, `fallback` when not given, at most `max`.
 * A --limit with no number is misuse, never the default.
 * @param {Args} a
 * @param {string} at "forms submissions"
 * @param {{ fallback?: number, max?: number }} [opts]
 * @returns {number}
 */
export function limitOf(a, at, { fallback = 50, max = 1000 } = {}) {
  if (!has(a, "limit")) return fallback;
  const v = typeof a.flags.limit === "string" ? flag(a, "limit") ?? "" : "";
  const [script, ...cmd] = at.split(" ");
  if (!/^[1-9]\d*$/.test(v)) misused(`${at}: --limit is a whole number, up to ${max}`, `node scripts/${script}.mjs ${[...cmd, "--limit", String(Math.min(100, max))].join(" ")}`);
  return Math.min(Number(v), max);
}

/**
 * @param {number} code
 * @param {string} msg
 * @param {string} [tryCmd]
 * @returns {never}
 */
function stop(code, msg, tryCmd) {
  console.error(jsonErrors ? JSON.stringify({ error: msg, try: tryCmd }) : tryCmd ? `${msg}\n  Try: ${tryCmd}` : msg);
  process.exit(code);
}

/**
 * Refused or failed: `msg`, then `  Try: <tryCmd>`, on stderr. Exit 1.
 * @param {string} msg
 * @param {string} [tryCmd]
 * @returns {never}
 */
export function fail(msg, tryCmd) {
  return stop(1, msg, tryCmd);
}

/**
 * Used wrongly (a missing or malformed argument): the same, exit 2.
 * @param {string} msg
 * @param {string} [tryCmd]
 * @returns {never}
 */
export function misused(msg, tryCmd) {
  return stop(2, msg, tryCmd);
}

/**
 * What happened, in the shape every script prints: `<at>: <what>`, each line
 * indented, then `Next:` after a blank line, or, for a step that waits for
 * the owner, the line saying how to go ahead in its place.
 * @param {string} at "forms save"
 * @param {string} what "made form contact, 3 fields"
 * @param {{ lines?: string[], next?: string, waits?: string }} [opts] `waits`: the command that does it, without --confirm
 */
export function done(at, what, { lines = [], next, waits } = {}) {
  const text = [`${at}: ${what}`, ...lines.flatMap((l) => l.split("\n")).map((l) => (l ? `  ${l}` : ""))];
  if (waits) text.push(`  Nothing was sent. If the owner asked for it: ${waits} --confirm`);
  else if (next) text.push("", `Next: ${next}`);
  console.log(text.join("\n"));
}

/**
 * JSON for another script, or the text for the AI.
 * @param {boolean} json
 * @param {unknown} data
 * @param {() => string} text
 */
export function out(json, data, text) {
  console.log(json ? JSON.stringify(data, null, 2) : text());
}

/**
 * A time as the business sees it, "2026-10-02, 14:30", in its zone, never the machine's.
 * @param {Date | string} d
 * @param {string} zone
 */
export const localTime = (d, zone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(new Date(d));

/**
 * The settings a script that sends or charges needs (NOTIFY_FROM, NOTIFY_VIA,
 * the gateway's PHOENIX_URL and MACHINE_TOKEN): this shell's, then, on a
 * Task & Tool machine (~/.tasktool), ~/.env's, which the web service sources
 * and a chat shell may not.
 * @returns {Record<string, string | undefined>}
 */
export function machineEnv() {
  /** @type {Record<string, string | undefined>} */
  const out = {};
  try {
    if (!existsSync(join(homedir(), ".tasktool"))) throw new Error("off Task & Tool");
    for (const line of readFileSync(join(homedir(), ".env"), "utf8").split("\n")) {
      const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // Off Task & Tool: the shell's env is the whole story.
  }
  return { ...out, ...process.env };
}
