// phoneCli keeps the script contract: --help and -h exit 0, wrong input
// exits 2 with a Try line, all before any database is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run-cli.ts", import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", runner, ...args], { encoding: "utf8" });

for (const h of ["--help", "-h"]) {
  test(`phone ${h} prints the usage and exits 0`, () => {
    const r = run([h]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^phone\.mjs <command>/);
  });
}

test("phone refuses wrong input with exit 2 and a Try line, before opening the database", () => {
  for (const [args, said] of [
    [["nope"], /^phone nope: no such command/],
    [["threads", "--unred"], /^phone threads: unknown flag --unred/],
    [["status", "extra"], /^phone status: unexpected extra/],
    // A flag that takes no value leaves the next word an argument: welcome is the flow, so extra is extra.
    [["set", "--on", "welcome", "extra"], /^phone set: unexpected extra/],
    [["flow", "nope"], /^phone flow: name a flow: /],
    [["send"], /^phone send: name the phone number first/],
    [["send", "(555) 201-0142"], /^phone send: the text, in quotes, after the number/],
  ] as const) {
    const r = run([...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, said);
    assert.match(r.stderr, /\n {2}Try: node scripts\/phone\.mjs/);
  }
});

test("a send's Try line never carries --confirm, so copying it only previews", () => {
  for (const args of [["send"], ["send", "(555) 201-0142"]]) {
    const r = run(args);
    assert.doesNotMatch(r.stderr, /--confirm/);
  }
});
