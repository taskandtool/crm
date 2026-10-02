import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { csvCell, csvResponse } from "../csv";
import { cut, everyPage, readCursor, makeCursor, type Cursor } from "../keyset";
import { teamOnly, type TeamVars } from "../guard";

test("a cell a spreadsheet would run as a formula is defused", () => {
  for (const v of ["=HYPERLINK(\"x\")", "+1", "-2+3", "@SUM(A1)", "\tx", "\rx"]) assert.ok(csvCell(v).replace(/^"/, "").startsWith("'"), v);
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(new Date("2026-01-02T03:04:05Z")), "2026-01-02T03:04:05.000Z");
});

test("an export streams a header and every row", async () => {
  async function* rows() {
    yield { n: "=a" };
    yield { n: "b" };
  }
  const res = csvResponse("x.csv", [{ label: "Name", value: (r: { n: string }) => r.n }], rows());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  assert.equal(text, "﻿Name\r\n'=a\r\nb\r\n");
});

test("a cursor round-trips the text sort key and refuses junk", () => {
  const k = "2026-10-02 12:00:00.123456+00";
  assert.deepEqual(readCursor(makeCursor({ k, id: 42 })), { k, id: "42" });
  for (const bad of [undefined, "", "not-base64!", btoa('["x","1; drop"]')]) assert.equal(readCursor(bad), null);
  const rows = [1, 2, 3].map((id) => ({ k: `2026-10-0${id}`, id }));
  assert.equal(cut(rows, 3).next, null);
  assert.deepEqual(readCursor(cut(rows, 2).next), { k: "2026-10-02", id: "2" });
});

function app() {
  const a = new Hono<{ Variables: TeamVars }>();
  a.use("*", teamOnly());
  a.get("/", (c) => c.text(c.get("user")));
  a.post("/", (c) => c.text("done"));
  return a;
}

test("no identity header means the page does not exist", async () => {
  const res = await app().request("https://site.example/");
  assert.equal(res.status, 404);
});

test("a team member is let in, named, and kept out of caches", async () => {
  const res = await app().request("https://site.example/", { headers: { "x-tasktool-user": "Ann@Example.com" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ann@example.com");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a change from another site is refused", async () => {
  const headers = { "x-tasktool-user": "ann@example.com", host: "site.example", origin: "https://evil.example" };
  assert.equal((await app().request("https://site.example/", { method: "POST", headers })).status, 403);
  const same = { ...headers, origin: "https://site.example" };
  assert.equal((await app().request("https://site.example/", { method: "POST", headers: same })).status, 200);
});

test("the dev stand-in works only on localhost", async () => {
  process.env.ADMIN_DEV_USER = "dev@example.com";
  try {
    assert.equal((await app().request("http://localhost/")).status, 200);
    assert.equal((await app().request("https://site.example/")).status, 404);
  } finally {
    delete process.env.ADMIN_DEV_USER;
  }
});

test("a Host header alone does not make a request local", async () => {
  process.env.ADMIN_DEV_USER = "dev@example.com";
  try {
    // Through a proxy: forwarding headers mean someone else's request.
    const proxied = await app().request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(proxied.status, 404);
    // On the machine the URL's host is the Host header; the socket says where it came from.
    const remote = await app().request("http://localhost/", {}, { incoming: { socket: { remoteAddress: "203.0.113.9" } } });
    assert.equal(remote.status, 404);
    const loop = await app().request("http://localhost/", {}, { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } });
    assert.equal(loop.status, 200);
  } finally {
    delete process.env.ADMIN_DEV_USER;
  }
});

test("a formula hidden behind spaces, a line break or a full-width sign is defused too", () => {
  for (const v of [" =1+1", "\n=1+1", "　=1+1", "＝1+1", "＋1", "＠SUM(A1)"]) {
    assert.ok(csvCell(v).replace(/^"/, "").startsWith("'"), JSON.stringify(v));
  }
  assert.equal(csvCell("a = b"), "a = b");
});

test("a cursor id too long for a bigint is refused, not sent to the database", () => {
  assert.equal(readCursor(btoa(JSON.stringify(["2026-10-02", "9".repeat(19)]))), null);
});

test("everyPage walks a keyset query to the end, one page at a time", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ k: `2026-10-0${9 - i}`, id: String(i + 1) }));
  const asked: (Cursor | null)[] = [];
  const fetchPage = async (after: Cursor | null, size: number) => {
    asked.push(after);
    const from = after ? rows.findIndex((r) => r.id === after.id) + 1 : 0;
    return rows.slice(from, from + size + 1);
  };
  const seen: string[] = [];
  for await (const r of everyPage(fetchPage, 3)) seen.push(r.id);
  assert.deepEqual(seen, rows.map((r) => r.id));
  assert.deepEqual(asked.map((a) => a?.id ?? null), [null, "3", "6"]);
});
