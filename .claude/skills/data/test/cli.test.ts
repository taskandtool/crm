// The helper every script shares: help, misuse and failure exit as the
// contract says, and done() prints the one shape. Each case runs a small
// script in its own process, since the helper exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, flag, flags, has } from "../cli.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** Runs `body` as a module with the helper imported as `c`, and these arguments. */
const run = (body: string, args: string[] = []) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `import * as c from ${JSON.stringify(cli)};\n${body}`, "--", ...args], { encoding: "utf8" });

const SCRIPT = `
const a = c.parseArgs(process.argv.slice(1));
const [cmd] = a._;
c.usage(a, cmd, ["list", "show"], "demo.mjs <command>\\n  list [--limit N]\\n  show <id>", "demo", { list: ["limit"], show: [] });
console.log("ran " + cmd);`;

test("parseArgs: -h is --help; a bare flag never takes the next word; a repeated flag collects", () => {
  const a = parseArgs(["show", "-h", "--json", "ann", "--tag", "a", "--tag=b", "--limit", "5"]);
  assert.deepEqual(a._, ["show", "ann"]);
  assert.equal(has(a, "help"), true);
  assert.deepEqual(flags(a, "tag"), ["a", "b"]);
  assert.equal(flag(a, "limit"), "5");
});

for (const h of ["--help", "-h"]) {
  test(`usage: ${h} prints the help on stdout and exits 0`, () => {
    const r = run(SCRIPT, [h]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^demo\.mjs <command>/);
    assert.equal(r.stderr, "");
  });
}

test("usage: no command, or an unknown one, exits 2 with Try on stderr and nothing on stdout", () => {
  for (const args of [[], ["nope"]]) {
    const r = run(SCRIPT, args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /commands: list, show\n {2}Try: node scripts\/demo\.mjs --help\n$/);
  }
});

test("usage: a flag the command does not take exits 2 and names the valid ones", () => {
  let r = run(SCRIPT, ["list", "--limt", "5"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "demo list: unknown flag --limt; valid: --limit\n  Try: node scripts/demo.mjs --help\n");
  r = run(SCRIPT, ["show", "1", "--limit", "5"]);
  assert.match(r.stderr, /^demo show: unknown flag --limit; valid: none\n/);
  r = run(SCRIPT, ["list", "--limit", "5", "--json"]);
  assert.equal(r.status, 0, "--json and --help always pass");
  assert.equal(r.stdout, "ran list\n");
});

test("checkFlags: the same check for a script with no command", () => {
  const r = run(`c.checkFlags(c.parseArgs(process.argv.slice(1)), ["before"], "reminders");`, ["--after", "5"]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "reminders: unknown flag --after; valid: --before\n  Try: node scripts/reminders.mjs --help\n");
});

test("parseArgs: a script's own bare flags never take the next word", () => {
  const a = parseArgs(["check", "5", "--done", "Order parts"], { bare: ["done"] });
  assert.deepEqual(a._, ["check", "5", "Order parts"]);
  assert.equal(a.flags.done, true);
});

test("plain: help exits 0; a flag it does not take, or a stray argument, exits 2", () => {
  const body = `c.plain(c.parseArgs(process.argv.slice(1)), "usage: npm run lint", "lint", { flags: ["fix"] }); console.log("ran");`;
  const help = run(body, ["-h"]);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, "usage: npm run lint\n");
  const ok = run(body, ["--fix"]);
  assert.equal(ok.stdout, "ran\n");
  const stray = run(body, ["pages"]);
  assert.equal(stray.status, 2);
  assert.equal(stray.stdout, "");
  assert.equal(stray.stderr, "lint: it takes no arguments (given pages)\n  Try: node scripts/lint.mjs --help\n");
  assert.equal(run(body, ["--bogus"]).status, 2);
});

test("flag: a value flag given no value is misuse, not quietly absent", () => {
  const r = run(`const a = c.parseArgs(process.argv.slice(1)); c.usage(a, a._[0], ["add"], "help", "demo"); c.flag(a, "board"); console.log("ran");`, ["add", "--board"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "demo add: --board needs a value\n  Try: node scripts/demo.mjs --help\n");
});

test("fail exits 1 and misused exits 2, each with its Try line", () => {
  let r = run(`c.fail("demo show: no thing 9", "node scripts/demo.mjs list");`);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "demo show: no thing 9\n  Try: node scripts/demo.mjs list\n");
  r = run(`c.misused("demo show: name it by its id");`);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "demo show: name it by its id\n");
});

test("under --json, fail prints the error as JSON", () => {
  const r = run(`c.parseArgs(process.argv.slice(1)); c.fail("demo show: no thing 9", "node scripts/demo.mjs list");`, ["show", "--json"]);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: "demo show: no thing 9", try: "node scripts/demo.mjs list" });
});

test("done: what happened, the lines indented, then Next after a blank line", () => {
  const r = run(`c.done("forms save", "made form contact, 3 fields", { lines: ["1 step", "two\\nlines"], next: "node scripts/forms.mjs list" });`);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "forms save: made form contact, 3 fields\n  1 step\n  two\n  lines\n\nNext: node scripts/forms.mjs list\n");
});

test("done: a step that waits for the owner says how to go ahead instead of Next", () => {
  const r = run(`c.done("invoices send", "invoice 3 for Ann Lee", { lines: ["Stripe will email it"], next: "x", waits: "node scripts/invoices.mjs send 3" });`);
  assert.equal(r.stdout, "invoices send: invoice 3 for Ann Lee\n  Stripe will email it\n  Nothing was sent. If the owner asked for it: node scripts/invoices.mjs send 3 --confirm\n");
});

test("limitOf: the default when not given; a --limit with no number, or 0, is misuse", () => {
  const body = `const a = c.parseArgs(process.argv.slice(1)); console.log(c.limitOf(a, "demo list", { fallback: 20, max: 200 }));`;
  assert.equal(run(body, ["list"]).stdout, "20\n");
  assert.equal(run(body, ["list", "--limit", "500"]).stdout, "200\n");
  for (const args of [["list", "--limit"], ["list", "--limit", "0"], ["list", "--limit=x"]]) {
    const r = run(body, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stderr, "demo list: --limit is a whole number, up to 200\n  Try: node scripts/demo.mjs list --limit 100\n");
  }
});

test("noMore: a word past what the command takes is misuse", () => {
  const r = run(`c.noMore(["3", "4"], 1, "demo show");`);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "demo show: unexpected 4\n  Try: node scripts/demo.mjs --help\n");
});
