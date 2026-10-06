// formsCli keeps the script contract: --help and -h exit 0, wrong input exits
// 2 with a Try line before any database is opened, and against a scratch
// database a save says made, changed or unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why } from "../../data/test/scratch";

const runner = fileURLToPath(new URL("./run-cli.ts", import.meta.url));
const forms = (args: string[], db = "") =>
  spawnSync(process.execPath, ["--import", "tsx", runner, ...args], { encoding: "utf8", env: { ...process.env, CLI_DB: db } });

for (const h of ["--help", "-h"]) {
  test(`forms ${h} prints the usage and exits 0`, () => {
    const r = forms([h]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^forms\.mjs <command>/);
  });
}

test("forms refuses wrong input with exit 2 and a Try line, before opening the database", () => {
  for (const [args, said] of [
    [["nope"], /forms nope: no such command/],
    [[], /forms: name a command/],
    [["list", "--limt", "5"], /forms list: unknown flag --limt; valid: none/],
    [["submissions", "--from", "contact"], /forms submissions: unknown flag --from; valid: --form, --limit/],
    [["show"], /forms show: name a form by its key/],
    [["show", "Bad Key"], /forms show: name a form by its key/],
    [["save", "contact"], /forms save: it needs --file/],
    [["list", "extra"], /forms list: unexpected extra/],
    [["submissions", "--limit", "lots"], /--limit is a whole number/],
    [["submissions", "--limit"], /--limit is a whole number/],
    [["submissions", "--limit", "0"], /--limit is a whole number/],
  ] as const) {
    const r = forms([...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, said);
    assert.match(r.stderr, /\n {2}Try: /);
  }
});

test("forms save says made, unchanged, then changed; list and submissions lead with what they found", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  const t = (await scratch())!;
  const dir = mkdtempSync(join(tmpdir(), "forms-cli-"));
  const file = join(dir, "contact.json");
  try {
    await applySchema(t.db, readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
    const def = { title: "Contact", fields: [{ name: "email", label: "Email", type: "email", required: true }] };
    writeFileSync(file, JSON.stringify(def));
    let r = forms(["save", "contact", "--file", file], t.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^forms save: made form contact, 1 field, 1 step\n\nNext: /);
    r = forms(["save", "contact", "--file", file], t.url);
    assert.match(r.stdout, /^forms save: unchanged form contact, 1 field, 1 step\n {2}the file matches the saved form; nothing was written\n/);
    writeFileSync(file, JSON.stringify({ ...def, title: "Contact us" }));
    r = forms(["save", "contact", "--file", file], t.url);
    assert.match(r.stdout, /^forms save: changed form contact/);

    r = forms(["list"], t.url);
    assert.match(r.stdout, /^forms list: 1 form\n {2}contact {2}Contact us {2}1 step {2}0 in\n\nNext: node scripts\/forms\.mjs submissions\n$/);
    r = forms(["submissions"], t.url);
    assert.equal(r.stdout, "forms submissions: nothing has come in\n");
    r = forms(["submissions", "--form", "ordr"], t.url);
    assert.equal(r.status, 1, "a form that is not there is wrong input, not an empty list");
    assert.equal(r.stderr, "forms submissions: no form ordr\n  Try: node scripts/forms.mjs list\n");
    r = forms(["save", "contact", "--file", join(dir, "missing.json")], t.url);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^forms save: .*missing\.json is not readable JSON.*\n {2}Try: node scripts\/forms\.mjs show contact/);
  } finally {
    await t.drop();
  }
});
