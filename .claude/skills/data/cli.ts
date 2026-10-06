// What every script an app's AI runs shares: arguments, usage, output,
// failure, and the machine's settings. Machine only (Node).
//
//   const a = parseArgs(process.argv.slice(2));
//   const [cmd, ...rest] = a._;
//   usage(a, cmd, ["list", "show"], HELP, "forms");   // --help exits 0; no or an unknown command exits 2
//   out(has(a, "json"), rows, () => rows.map(fmt).join("\n"));
//
// The rules a script keeps: the first line says what happened; errors go to
// stderr with what was wrong and the command that works (Try:); exit 0 done,
// 1 refused or failed, 2 used wrongly.
import { readFileSync } from "node:fs";

export type Args = { _: string[]; flags: Record<string, string | boolean> };

/** Flags that never take a value, so `--json contact` keeps contact as an argument. */
const BARE = new Set(["json", "help", "confirm"]);

/** `cmd sub "Ann Lee" --tag a --tag b --json`. A repeated flag collects into a list (flags() reads it); a bare flag is true. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      let v: string | boolean = true;
      if (inline !== undefined) v = inline;
      else if (!BARE.has(k) && next !== undefined && !next.startsWith("--")) {
        v = next;
        i++;
      }
      const prev = out.flags[k];
      out.flags[k] = typeof prev === "string" && typeof v === "string" ? `${prev}\u0000${v}` : v;
    } else out._.push(a);
  }
  return out;
}

export const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === "string" ? (a.flags[k] as string).split("\u0000").pop() : undefined);
export const flags = (a: Args, k: string): string[] => (typeof a.flags[k] === "string" ? (a.flags[k] as string).split("\u0000") : []);
export const has = (a: Args, k: string) => a.flags[k] !== undefined;

/**
 * --help prints the usage and exits 0; no command prints it to stderr, and
 * an unknown one says so, both exit 2 before any database is opened.
 */
export function usage(a: Args, cmd: string | undefined, commands: readonly string[], help: string, script: string): asserts cmd is string {
  if (has(a, "help")) {
    console.log(help);
    process.exit(0);
  }
  if (cmd && commands.includes(cmd)) return;
  console.error(cmd ? `${script} ${cmd}: no such command; commands: ${commands.join(", ")}\n  Try: node scripts/${script}.mjs --help` : help);
  process.exit(2);
}

/** Refused or failed: what went wrong and, on its own line, `Try: <the command that works>`. Exit 1. */
export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Used wrongly (a missing or malformed argument): the same message, exit 2. */
export function misused(msg: string): never {
  console.error(msg);
  process.exit(2);
}

export function out(json: boolean, data: unknown, text: () => string) {
  console.log(json ? JSON.stringify(data, null, 2) : text());
}

/** A time as the business sees it, "2026-10-02, 14:30", in its zone, never the machine's. */
export const localTime = (d: Date | string, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(new Date(d));

/**
 * The settings a script that sends or charges needs (NOTIFY_FROM, NOTIFY_VIA,
 * the gateway's PHOENIX_URL and MACHINE_TOKEN): this shell's, then
 * /home/sprite/.env's, which the web service sources and a chat shell may not.
 */
export function machineEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  try {
    for (const line of readFileSync("/home/sprite/.env", "utf8").split("\n")) {
      const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // Off Task & Tool: the shell's env is the whole story.
  }
  return { ...out, ...process.env };
}
