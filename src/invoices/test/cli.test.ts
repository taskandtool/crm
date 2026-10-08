// quotesCli and invoicesCli keep the script contract: --help and -h exit 0,
// wrong input exits 2 with a Try line, all before any database is opened;
// against a scratch database, each command leads with what happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why } from "../../data/test/scratch";

const runner = fileURLToPath(new URL("./run-cli.ts", import.meta.url));
const run = (which: "quotes" | "invoices", args: string[], db = "") =>
  spawnSync(process.execPath, ["--import", "tsx", runner, which, ...args], { encoding: "utf8", env: { ...process.env, CLI_DB: db } });

for (const which of ["quotes", "invoices"] as const) {
  for (const h of ["--help", "-h"]) {
    test(`${which} ${h} prints the usage and exits 0`, () => {
      const r = run(which, [h]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^${which}\\.mjs <command>`));
    });
  }
}

test("quotes and invoices refuse wrong input with exit 2 and a Try line, before opening the database", () => {
  for (const [which, args, said] of [
    ["quotes", ["nope"], /^quotes nope: no such command/],
    ["quotes", ["list", "--stauts", "sent"], /^quotes list: unknown flag --stauts; valid: --status, --find, --limit, --customer/],
    ["quotes", ["send", "3", "--confrim"], /^quotes send: unknown flag --confrim/],
    ["quotes", ["show", "3", "4"], /^quotes show: unexpected 4/],
    ["quotes", ["list", "--limit", "all"], /^quotes list: --limit is a whole number/],
    ["quotes", ["list", "--limit"], /^quotes list: --limit is a whole number/],
    ["invoices", ["nope"], /^invoices nope: no such command/],
    ["invoices", ["void", "3", "--yes"], /^invoices void: unknown flag --yes; valid: --confirm, --as/],
    ["invoices", ["list", "extra"], /^invoices list: unexpected extra/],
  ] as const) {
    const r = run(which, [...args]);
    assert.equal(r.status, 2, `${which} ${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, said);
    assert.match(r.stderr, /\n {2}Try: node scripts\//);
  }
});

test("quotes --json errors are JSON on stderr", () => {
  const r = run("quotes", ["list", "--stauts", "sent", "--json"]);
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stderr), { error: "quotes list: unknown flag --stauts; valid: --status, --find, --limit, --customer", try: "node scripts/quotes.mjs --help" });
});

test("quotes and invoices, end to end short of sending", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  const t = (await scratch())!;
  const sql = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
  const q = (...args: string[]) => run("quotes", args, t.url);
  const i = (...args: string[]) => run("invoices", args, t.url);
  try {
    // The payments schema first: lines carry its tax_rates.
    await applySchema(t.db, sql("../../payments/schema.sql") + ";\n" + sql("../schema.sql"));
    let r = q("tax-rate", "Sales tax", "8.25");
    assert.match(r.stdout, /^quotes tax-rate: added #\d+ Sales tax 8\.25%\n\nNext: /);
    r = q("tax-rate", "sales tax", "9");
    assert.equal(r.status, 0, "a second run is already done, not an error");
    assert.match(r.stdout, /^quotes tax-rate: Sales tax is already #\d+ at 8\.25%; left alone/);

    r = q("add", "ann@example.com", "--line", "Fence repair|450", "--name", "Ann Lee", "--deal", "4");
    assert.equal(r.status, 0, r.stderr);
    const id = /#(\d+)/.exec(r.stdout)![1];
    assert.match(r.stdout, new RegExp(`^quotes add: added #${id} .*Ann Lee <ann@example\\.com>.*\\$450\\.00.*\\n\\nNext: node scripts/quotes\\.mjs send ${id}\\n$`));
    r = q("add", "ann@example.com", "--line", "Fence repair");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^quotes add: --line Fence repair: write it as/);
    r = q("list");
    assert.match(r.stdout, /^quotes list: 1 quote, newest first\n {2}#/);
    r = q("show", id);
    assert.match(r.stdout, /^quotes show: #\d+ .*\n {2}1\. Fence repair: 1 x \$450\.00/);
    r = q("send", id);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^quotes send: quote .* to ann@example\\.com, \\$450\\.00\\n[\\s\\S]*  Nothing was sent\\. If the owner asked for it: node scripts/quotes\\.mjs send ${id} --confirm\\n$`));
    r = q("send", "--pay", id);
    assert.equal(r.status, 0, "--pay takes no value, so the id stays an argument: " + r.stderr);
    r = q("show", "999");
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "quotes show: no quote 999\n  Try: node scripts/quotes.mjs list\n");

    r = i("from-quote", id);
    assert.equal(r.status, 1, "a quote not accepted is refused");
    assert.match(r.stderr, /^invoices from-quote: quote #\d+ is not accepted.*\n {2}Try: node scripts\/quotes\.mjs accept/);
    r = q("mark-sent", id);
    assert.match(r.stderr, /after send: quote ann@example\.com/, "mark-sent runs afterSend");
    r = q("accept", id);
    assert.match(r.stdout, /^quotes accept: accepted #\d+ .*deal #4\n {2}after: accepted deal 4\n/);
    r = q("accept", id);
    assert.equal(r.status, 0, "accepting it again is already done");
    assert.match(r.stdout, /^quotes accept: quote \d+ is already accepted; left alone\n/);
    r = q("decline", id);
    assert.equal(r.status, 1, "an accepted quote is not declined");
    assert.match(r.stderr, /^quotes decline: quote \d+ is accepted; nothing changed\n {2}Try: /);
    r = i("from-quote", id);
    assert.match(r.stdout, /^invoices from-quote: drafted #(\d+) /);
    const inv = /#(\d+)/.exec(r.stdout)![1];
    r = i("from-quote", id);
    assert.equal(r.status, 0, "a second run is already done");
    assert.equal(r.stdout, `invoices from-quote: quote #${id} already has invoice #${inv}; left alone\n\nNext: node scripts/invoices.mjs show ${inv}\n`);
    r = i("send", inv);
    assert.match(r.stdout, new RegExp(`\\n  Nothing was sent\\. If the owner asked for it: node scripts/invoices\\.mjs send ${inv} --confirm\\n$`));
    r = i("send", inv, "--confirm");
    assert.equal(r.status, 1, "no Stripe here");
    assert.match(r.stderr, /^invoices send: nothing was done: this app has no Stripe connection\n {2}Try: python3 ~\/tools\/taskandtool\.py request-connection stripe /);
    r = i("discard", inv);
    assert.match(r.stdout, /^invoices discard: discarded #/);
    r = i("discard", inv);
    assert.equal(r.status, 0, "discarding it again is already done");
    assert.match(r.stdout, /already discarded \(void\); left alone/);
    r = i("owed", "ann@example.com");
    assert.equal(r.stdout, "invoices owed: ann@example.com owes nothing on an open invoice\n");
  } finally {
    await t.drop();
  }
});
