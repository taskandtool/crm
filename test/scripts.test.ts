// Every script answers --help and -h (exit 0), and refuses a command, a flag
// or an argument it does not take (exit 2, nothing on stdout, a Try: line on
// stderr), before it opens any database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const scripts = readdirSync("scripts").filter((f) => f.endsWith(".mjs") && !["check.mjs", "dev.mjs", "vendor.mjs", "run.mjs"].includes(f));
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("node", [`scripts/${script}`, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "", ...env }, timeout: 60_000 });

/** A refusal: the exit code, nothing on stdout, and a Try: line on stderr. */
function refused(r: ReturnType<typeof run>, status: number, what: string) {
  assert.equal(r.status, status, `${what}: ${r.stderr}`);
  assert.equal(r.stdout, "", `${what} prints nothing on stdout`);
  assert.match(r.stderr, /\n {2}Try: \S/, `${what} says what to try`);
  assert.doesNotMatch(r.stderr, /\n\s+at /, `${what}: no stack trace`);
}

for (const script of scripts) {
  for (const h of ["--help", "-h"]) {
    test(`${script} ${h} prints its usage and exits 0`, () => {
      const r = run(script, [h]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(script.replace(".mjs", "")));
    });
  }
}

const READ: Record<string, string[]> = {
  "customers.mjs": ["list"], "visits.mjs": ["list"], "stages.mjs": ["list"], "inbox.mjs": ["list"], "forms.mjs": ["list"],
  "quotes.mjs": ["list"], "invoices.mjs": ["list"], "import.mjs": ["file.csv"], "export.mjs": [], "migrate.mjs": [],
  "deals.mjs": ["list"], "follow-ups.mjs": ["list"],
};
test("every script is in the bad-input table", () => assert.deepEqual(Object.keys(READ).sort(), [...scripts].sort()));

for (const [script, args] of Object.entries(READ)) {
  test(`${script} refuses an unknown flag`, () => refused(run(script, [...args, "--bogus"]), 2, `${script} --bogus`));
  if (args.length && script !== "import.mjs") {
    test(`${script} refuses a command it does not have`, () => refused(run(script, ["nope"]), 2, `${script} nope`));
  }
}

test("a typo in a flag is refused, never a silent success", () => {
  const r = run("customers.mjs", ["add", "Ann", "--emial", "ann@example.com"]);
  refused(r, 2, "customers add --emial");
  assert.match(r.stderr, /customers add: unknown flag --emial; valid: .*--email/);
});

test("stray arguments and malformed ones are misuse", () => {
  refused(run("export.mjs", ["customers.csv"]), 2, "export with a stray argument");
  refused(run("migrate.mjs", ["now"]), 2, "migrate with a stray argument");
  refused(run("customers.mjs", ["list", "extra"]), 2, "customers list extra");
  refused(run("inbox.mjs", ["add", "foo", "1"]), 2, "inbox add foo 1");
  refused(run("inbox.mjs", ["done"]), 2, "inbox done with no id");
  refused(run("import.mjs", []), 2, "import with no file");
  refused(run("deals.mjs", ["list", "--won", "--lost"]), 2, "deals list with two kinds");
  refused(run("follow-ups.mjs", ["done"]), 2, "follow-ups done with no id");
  refused(run("deals.mjs", ["won", "abc"]), 2, "deals won with no id");
  refused(run("follow-ups.mjs", ["list", "--upcoming", "--none"]), 2, "follow-ups list with two views");
  refused(run("customers.mjs", ["merge", "1"]), 2, "customers merge with one record");
});

// deals, follow-ups and merge from chat, against a throwaway database: each
// says what happened first, a re-run is "already", and a merge waits for --confirm.
test("deals.mjs, follow-ups.mjs and customers merge, end to end", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" }, async () => {
  const pg = (await import("pg")).default;
  const admin = process.env.TEST_DATABASE_URL!;
  const name = "crm_sales_scripts_" + Date.now().toString(36);
  const root = new pg.Client({ connectionString: admin });
  await root.connect();
  await root.query(`create database ${name}`);
  const url = new URL(admin);
  url.pathname = "/" + name;
  const env = { DATABASE_URL: url.toString(), CRM_USER: "ann@team.example" };
  const sh = (script: string, ...args: string[]) => run(script, args, env);
  try {
    let r = sh("customers.mjs", "add", "Ann Lee", "--email", "ann@example.com");
    assert.equal(r.status, 0, r.stderr);
    r = sh("deals.mjs", "add", "ann@example.com", "New furnace", "--value", "6500");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^deals add: added #\d+  New furnace  \[New\]  Ann Lee  \$6,500\.00  @ann@team\.example\n\nNext: node scripts\/follow-ups\.mjs add \d+ "Call Ann Lee" --on tomorrow --deal \d+\n$/);
    const deal = r.stdout.match(/#(\d+)/)![1];
    r = sh("deals.mjs", "add", "ann@example.com", "new furnace");
    assert.match(r.stdout, /^deals add: already here, not added/, "the same open deal twice is one");
    r = sh("deals.mjs", "stage", deal, "nope");
    assert.equal(r.status, 2);
    r = sh("deals.mjs", "won", deal);
    assert.match(r.stdout, /^deals won: New furnace: New -> Won\n/);
    r = sh("deals.mjs", "won", deal);
    assert.match(r.stdout, /^deals won: New furnace is already won \(Won\); left alone/);
    r = sh("customers.mjs", "show", "ann@example.com");
    assert.match(r.stdout, /\[Customer\]/, "a won deal made her a customer");
    assert.match(r.stdout, /  deals:\n {4}#\d+ New furnace \[Won\] \$6,500\.00/);
    r = sh("deals.mjs", "job", deal);
    assert.match(r.stdout, /^deals job: visit #\d+ New furnace for Ann Lee\n/);
    r = sh("deals.mjs", "job", deal);
    assert.match(r.stdout, /^deals job: already made: visit #\d+/);

    r = sh("follow-ups.mjs", "add", "ann@example.com", "Call about the install", "--on", "2099-03-04", "--at", "9:30", "--deal", deal);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^follow-ups add: added #\d+  2099-03-04 09:30  call: Call about the install  for Ann Lee \(#\d+\)  re New furnace \(#\d+\)  @ann@team\.example\n  say back the day: 2099-03-04 at 09:30/);
    const fu = r.stdout.match(/#(\d+)/)![1];
    r = sh("follow-ups.mjs", "add", "ann@example.com", "call about the install", "--on", "2099-03-04");
    assert.match(r.stdout, /^follow-ups add: already planned, not added/);
    r = sh("follow-ups.mjs", "add", "ann@example.com", "Call", "--on", "someday");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--on someday: write the day as/);
    r = sh("follow-ups.mjs", "list");
    assert.match(r.stdout, /^follow-ups list: nothing due today or overdue\n/);
    r = sh("follow-ups.mjs", "move", fu, "--on", "today", "--at", "");
    assert.match(r.stdout, /^follow-ups move: moved #\d+ Call about the install: 2099-03-04 09:30 -> today\n/);
    r = sh("follow-ups.mjs", "list");
    assert.match(r.stdout, /^follow-ups list: 1 due today or overdue, soonest first\n  #\d+  today  call: Call about the install/);
    r = sh("follow-ups.mjs", "done", fu, "--outcome", "Booked for Tuesday");
    assert.match(r.stdout, /^follow-ups done: done: call: Call about the install for Ann Lee; noted on their timeline\n/);
    r = sh("follow-ups.mjs", "done", fu);
    assert.match(r.stdout, /^follow-ups done: #\d+ was already done; left alone/);
    r = sh("follow-ups.mjs", "list", "--none");
    assert.match(r.stdout, /^follow-ups list: everyone in play has something planned/, "a customer with no open deal is not in play");

    r = sh("customers.mjs", "add", "Ann L", "--email", "ann@work.example", "--phone", "555 222 1111");
    const dup = r.stdout.match(/#(\d+)/)![1];
    r = sh("customers.mjs", "merge", "ann@example.com", dup);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^customers merge: would merge #\d+ Ann L into #\d+ Ann Lee\n[\s\S]*Ann Lee gains: phone, also goes by ann@work\.example\n[\s\S]*Nothing was merged\. If the owner said yes: node scripts\/customers\.mjs merge \d+ \d+ --confirm/);
    r = sh("customers.mjs", "merge", "ann@example.com", dup, "--confirm");
    assert.match(r.stdout, /^customers merge: merged #\d+ Ann L into #\d+  Ann Lee/);
    r = sh("customers.mjs", "show", "ann@work.example");
    assert.match(r.stdout, /^customers show: #\d+  Ann Lee/, "found by the address she also goes by");
    r = sh("customers.mjs", "merge", "ann@example.com", dup, "--confirm");
    assert.match(r.stdout, /already merged into/);

    r = sh("stages.mjs", "list", "--statuses");
    assert.match(r.stdout, /^stages list: 3 customer statuses in order/);
    r = sh("stages.mjs", "add", "Site visit");
    assert.match(r.stdout, /^stages add: added site-visit \(Site visit\)/);
  } finally {
    await root.query(`drop database ${name} with (force)`);
    await root.end();
  }
});

test("import of a file that is not there is refused, before the database", () => {
  const r = run("import.mjs", ["no-such-file.csv", "--dry-run"]);
  refused(r, 1, "import of a missing file");
  assert.match(r.stderr, /^import: cannot read .*no-such-file\.csv: ENOENT/);
  const before = run("import.mjs", ["--dry-run", "no-such-file.csv"]);
  assert.match(before.stderr, /^import: cannot read .*no-such-file\.csv/, "--dry-run takes no value, so the file before it is still the file");
});

test("no database is exit 1 with the ask for one", () => {
  const r = run("customers.mjs", ["list"], { DATABASE_URL: "" });
  if (!r.stderr.includes("DATABASE_URL is not set")) return; // a machine with /home/sprite/.env has one
  refused(r, 1, "no DATABASE_URL");
  assert.match(r.stderr, /^customers list: the project has no database yet/);
  assert.match(r.stderr, /Try: python3 ~\/tools\/taskandtool\.py request-capability postgres/);
});

test("a database that does not answer is exit 1, not a stack trace", () => {
  const r = run("stages.mjs", ["list"], { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" });
  refused(r, 1, "an unreachable database");
  assert.match(r.stderr, /^stages list: cannot reach the database \(ECONNREFUSED\)/);
});

// forms.mjs against a throwaway database: save a form from JSON (refusing a
// bad one with the reason), list it, read it back, list its submissions.
test("forms.mjs saves, lists and shows a form, and refuses a broken one", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" }, async () => {
  const pg = (await import("pg")).default;
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const admin = process.env.TEST_DATABASE_URL!;
  const name = "crm_scripts_" + Date.now().toString(36);
  const root = new pg.Client({ connectionString: admin });
  await root.connect();
  await root.query(`create database ${name}`);
  const url = new URL(admin);
  url.pathname = "/" + name;
  const dir = mkdtempSync(join(tmpdir(), "forms-"));
  const forms = (...args: string[]) =>
    spawnSync("node", ["scripts/forms.mjs", ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 60_000 });
  try {
    writeFileSync(join(dir, "order.json"), JSON.stringify({ title: "Cookie order", fields: [
      { name: "email", label: "Email", type: "email", required: true },
      { name: "cookies", label: "Cookies", type: "items", currency: "usd", items: [{ key: "pb", label: "Peanut butter", price_cents: 3600 }] },
      { name: "pay", label: "Pay", type: "payment" },
    ] }));
    let r = forms("save", "order", "--file", join(dir, "order.json"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^forms save: made form order, 3 fields, 2 steps\n\nNext: /);
    r = forms("save", "order", "--file", join(dir, "order.json"));
    assert.match(r.stdout, /^forms save: unchanged form order/, "saving the same file again changes nothing");
    r = forms("list");
    assert.match(r.stdout, /order  Cookie order  2 steps \(payment\)  0 in/);
    r = forms("show", "order");
    assert.equal(JSON.parse(r.stdout).fields[1].items[0].price_cents, 3600);
    r = forms("submissions", "--form", "order");
    assert.equal(r.stdout.trim(), "forms submissions: nothing has come in on order");
    r = forms("submissions", "--form", "ordr");
    assert.equal(r.status, 1, "a form that is not there is wrong input, not an empty list");
    assert.match(r.stderr, /no form ordr\n  Try: node scripts\/forms\.mjs list/);

    writeFileSync(join(dir, "bad.json"), JSON.stringify({ title: "Bad", fields: [{ name: "pay", label: "Pay", type: "payment" }, { name: "email", label: "Email", type: "email" }] }));
    r = forms("save", "bad", "--file", join(dir, "bad.json"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /field 1 \(pay\): A booking or payment step comes after every question\./);
    r = forms("show");
    assert.equal(r.status, 2, "a missing key is a misuse");
    assert.match(r.stderr, /Try: node scripts\/forms\.mjs list/);
  } finally {
    await root.query(`drop database if exists ${name} with (force)`);
    await root.end();
  }
});

// invoices.mjs bill, short of Stripe: it drafts from the one finished visit
// worth something, takes that draft again rather than making a second,
// asks rather than choosing between two, never bills another visit on a
// retry after a send, and refuses --confirm plainly with no Stripe here.
// migrate.mjs applies every file even when the scripts' record says current.
test("invoices.mjs bill and migrate.mjs, against a scratch database", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" }, async () => {
  const pg = (await import("pg")).default;
  const admin = process.env.TEST_DATABASE_URL!;
  const name = "crm_bill_" + Date.now().toString(36);
  const root = new pg.Client({ connectionString: admin });
  await root.connect();
  await root.query(`create database ${name}`);
  const url = new URL(admin);
  url.pathname = "/" + name;
  const env = { ...process.env, DATABASE_URL: url.toString(), PHOENIX_URL: "", MACHINE_TOKEN: "", STRIPE_API_KEY: "" };
  const sh = (script: string, ...args: string[]) => spawnSync("node", [`scripts/${script}`, ...args], { encoding: "utf8", env, timeout: 60_000 });
  const db = new pg.Client({ connectionString: url.toString() });
  const visit = (email: string, title: string, amount?: string) => {
    const r = sh("visits.mjs", "add", email, title, "--at", "2026-10-01 09:30", "--json");
    assert.equal(r.status, 0, r.stderr);
    const id = JSON.parse(r.stdout).id;
    if (amount) assert.equal(sh("visits.mjs", "update", id, "--amount", amount).status, 0);
    assert.equal(sh("visits.mjs", "done", id).status, 0);
    return id;
  };
  try {
    assert.equal(sh("customers.mjs", "add", "Ann Lee", "--email", "ann@example.com").status, 0);
    await db.connect();
    let r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.equal(r.status, 1, "nothing finished to bill");
    assert.match(r.stderr, /no finished visit with an amount/);

    visit("ann@example.com", "Free check", "0");
    const job = visit("ann@example.com", "Boiler service", "245.00");
    r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.equal(r.status, 0, r.stderr + " (a $0 visit is not a second candidate)");
    assert.match(r.stdout, /^invoices bill: drafted invoice #\d+ to Ann Lee <ann@example\.com>: Boiler service, \$245\.00/);
    assert.match(r.stdout, new RegExp(`If the owner asked for it: node scripts/invoices\\.mjs bill ann@example\\.com --job ${job} --confirm$`, "m"));
    r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.match(r.stdout, /^invoices bill: took the draft invoice #\d+/, "a second call takes the same draft");
    assert.equal(JSON.parse(sh("invoices.mjs", "list", "--customer", "ann@example.com", "--json").stdout).length, 1);

    r = sh("invoices.mjs", "bill", "ann@example.com", "--confirm");
    assert.equal(r.status, 1, "no Stripe here");
    assert.match(r.stderr, /Try: python3 ~\/tools\/taskandtool\.py request-connection stripe/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");

    visit("ann@example.com", "Radiator bleed", "80.00");
    r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.equal(r.status, 2, "two to choose from is a misuse");
    assert.match(r.stderr, /ask the owner which/);
    assert.match(r.stderr, /Try: node scripts\/invoices\.mjs bill ann@example\.com --job <id>$/m, "names no job the owner did not choose");
    assert.doesNotMatch(r.stderr, /--confirm/, "a hint never sends");

    // As if the Boiler service invoice had just gone through Stripe: a retry without --job bills nothing else.
    await db.query(`update invoices set status = 'open', sent_at = now(), stripe_invoice_id = 'in_test' where visit_id = $1`, [job]);
    r = sh("invoices.mjs", "bill", "ann@example.com", "--confirm");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^invoices bill: nothing new was sent: invoice #\d+ went to ann@example\.com \(sent .*\), so this looks like a repeat; left alone/);
    assert.match(r.stdout, /not invoiced yet:\n    #\d+ Radiator bleed/, "names the job still to bill");
    assert.doesNotMatch(r.stdout, /--confirm/, "a hint never sends");
    assert.equal(JSON.parse(sh("invoices.mjs", "bill", "ann@example.com", "--json").stdout).outcome, "left_alone");
    assert.equal(JSON.parse(sh("invoices.mjs", "list", "--customer", "ann@example.com", "--json").stdout).length, 1, "no second invoice");
    // A voided invoice is not the one they asked for: the guard passes it by.
    await db.query(`update invoices set status = 'void' where visit_id = $1`, [job]);
    r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.equal(r.status, 2, "two jobs to bill again once the sent one is void");

    await db.query("drop table customer_notes");
    r = sh("migrate.mjs");
    assert.equal(r.status, 0, r.stderr);
    assert.equal((await db.query("select to_regclass('customer_notes') is not null as x")).rows[0].x, true, "migrate repairs what the scripts' record says is current");
  } finally {
    await db.end().catch(() => {});
    await root.query(`drop database if exists ${name} with (force)`);
    await root.end();
  }
});
