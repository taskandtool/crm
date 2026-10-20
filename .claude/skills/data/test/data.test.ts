import { test } from "node:test";
import assert from "node:assert/strict";
import { q } from "../db";
import { normalizeEmail } from "../email";
import { applySchema, statements } from "../migrate";
import { scratch, why } from "./scratch";

test("q numbers the parameters and never splices a value", () => {
  assert.deepEqual(q`select * from t where a = ${1} and b = ${"x'; drop table t; --"}`, {
    text: "select * from t where a = $1 and b = $2",
    values: [1, "x'; drop table t; --"],
  });
});

test("an email is trimmed, lowered, and refused when it is not one", () => {
  assert.equal(normalizeEmail("  Ann@Example.COM "), "ann@example.com");
  assert.equal(normalizeEmail("ann@example"), null);
  assert.equal(normalizeEmail("a b@example.com"), null);
  assert.equal(normalizeEmail(42), null);
  for (const bad of ["Bank<evil@a.b>", "a,b@x.com", '"a"@x.com', "a@x.com\r\nBcc: c@d.e", "a;b@x.com", "a@x.", "a@.com"]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
  for (const ok of ["ann.lee+tag@sub.example.co.uk", "o'neil@example.ie", "x_y-z@ex-ample.io"]) assert.equal(normalizeEmail(ok), ok);
});

test("a schema file splits into statements: comments dropped, a semicolon inside a string kept", () => {
  assert.equal(statements(`
    -- a comment; with a semicolon
    create table if not exists things (id bigserial primary key, email citext not null);
    create index if not exists things_email on things (email);
    comment on table things is 'Things';`).length, 3);
  assert.deepEqual(statements("comment on table t is 'a; b -- c ''d''';\ncomment on column t.x is 'y'"), [
    "comment on table t is 'a; b -- c ''d'''",
    "comment on column t.x is 'y'",
  ]);
  assert.throws(() => statements("do $$ begin end $$"), /\$\$/);
});

test("applySchema runs twice cleanly, and a file that fails part way changes nothing", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    const schema = "create table if not exists things (id bigserial primary key, email citext not null, note text)";
    await applySchema(s.db, schema);
    await applySchema(s.db, schema);
    await s.db.sql`insert into things (email, note) values (${"A@x.com"}, ${"n"})`;
    const [row] = await s.db.sql`select note from things where email = ${"a@X.com"}`;
    assert.equal(row.note, "n");

    await assert.rejects(applySchema(s.db, "create table if not exists more (id int);\nselect nope from things"));
    assert.equal((await s.db.sql`select to_regclass('more') as t`)[0].t, null, "the first statement was rolled back");
  } finally {
    await s.drop();
  }
});

test("a transaction is all or nothing", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await s.db.sql`create table t (id int primary key)`;
    await assert.rejects(s.db.transaction([q`insert into t values (${1})`, q`insert into t values (${1})`]));
    assert.equal((await s.db.sql`select count(*)::int as n from t`)[0].n, 0);
    const [, rows] = await s.db.transaction([q`insert into t values (${2})`, q`select id from t`]);
    assert.deepEqual(rows, [{ id: 2 }]);
  } finally {
    await s.drop();
  }
});
