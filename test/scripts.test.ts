// Every script answers --help (exit 0) and refuses a command it does not
// have (exit 2, with a Try: line), before it opens any database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const scripts = readdirSync("scripts").filter((f) => f.endsWith(".mjs") && !["check.mjs", "dev.mjs", "vendor.mjs"].includes(f));
const run = (script: string, args: string[]) =>
  spawnSync("node", [`scripts/${script}`, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" }, timeout: 60_000 });

for (const script of scripts) {
  test(`${script} --help prints its usage and exits 0`, () => {
    const r = run(script, ["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(script.replace(".mjs", "")));
  });
}

for (const script of ["customers.mjs", "visits.mjs", "stages.mjs", "forms.mjs", "quotes.mjs", "invoices.mjs"]) {
  test(`${script} refuses a command it does not have`, () => {
    const r = run(script, ["nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Try: node scripts\//);
  });
}

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
    assert.match(r.stdout, /^forms save: made form order, 3 fields, 2 steps\nNext: /);
    r = forms("save", "order", "--file", join(dir, "order.json"));
    assert.match(r.stdout, /^forms save: changed form order/, "saving again changes, never duplicates");
    r = forms("list");
    assert.match(r.stdout, /order  Cookie order  2 steps \(payment\)  0 in/);
    r = forms("show", "order");
    assert.equal(JSON.parse(r.stdout).fields[1].items[0].price_cents, 3600);
    r = forms("submissions", "--form", "order");
    assert.equal(r.stdout.trim(), "nothing has come in");
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
    assert.match(r.stdout, /^drafted invoice #\d+ to Ann Lee <ann@example\.com>: Boiler service, \$245\.00/);
    assert.match(r.stdout, new RegExp(`If the owner asked for it: node scripts/invoices\\.mjs bill ann@example\\.com --job ${job} --confirm; otherwise show them this and wait`));
    r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.match(r.stdout, /^took the draft invoice #\d+/, "a second call takes the same draft");
    assert.equal(JSON.parse(sh("invoices.mjs", "list", "--customer", "ann@example.com", "--json").stdout).length, 1);

    r = sh("invoices.mjs", "bill", "ann@example.com", "--confirm");
    assert.equal(r.status, 1, "no Stripe here");
    assert.match(r.stderr, /Try: request_connection\("stripe"/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");

    visit("ann@example.com", "Radiator bleed", "80.00");
    r = sh("invoices.mjs", "bill", "ann@example.com");
    assert.equal(r.status, 2, "two to choose from is a misuse");
    assert.match(r.stderr, /ask the owner which/);
    assert.match(r.stderr, /Then: node scripts\/invoices\.mjs bill ann@example\.com --job <id>$/m, "names no job the owner did not choose");
    assert.doesNotMatch(r.stderr, /--confirm/, "a hint never sends");

    // As if the Boiler service invoice had just gone through Stripe: a retry without --job bills nothing else.
    await db.query(`update invoices set status = 'open', sent_at = now(), stripe_invoice_id = 'in_test' where visit_id = $1`, [job]);
    r = sh("invoices.mjs", "bill", "ann@example.com", "--confirm");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^nothing new was sent: invoice #\d+ went to ann@example\.com \(sent .*\), so this looks like a repeat; left alone/);
    assert.match(r.stdout, /Not invoiced yet:\n  #\d+ Radiator bleed/, "names the job still to bill");
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
