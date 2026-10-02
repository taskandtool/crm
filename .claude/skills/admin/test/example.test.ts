import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { adminRoutes } from "../example";

// The stand-in table, shaped as an owning skill's schema.sql would make it.
const SCHEMA = `
  create table if not exists example_rows (
    id bigserial primary key,
    name text,
    email citext,
    status text not null default 'new',
    data jsonb not null default '{}',
    source text,
    created_at timestamptz not null default now(),
    updated_at timestamptz,
    updated_by citext
  );
  create index if not exists example_rows_recent on example_rows (created_at desc, id desc);
  create index if not exists example_rows_name_trgm on example_rows using gin (name gin_trgm_ops);
  create index if not exists example_rows_email_trgm on example_rows using gin ((email::text) gin_trgm_ops);`;

let s: Scratch | null = null;
let app: Hono;
const HOST = "https://site.example";
const ME = { "x-tasktool-user": "Ann@Example.com", host: "site.example" };

before(async () => {
  s = await scratch();
  if (!s) return;
  await applySchema(s.db, SCHEMA);
  // Five rows inside one millisecond, apart only in microseconds, then two more.
  await s.db.sql`
    insert into example_rows (name, email, status, created_at, data)
    select 'Same ms ' || i, 'ms' || i || '@example.com', 'new',
           '2026-10-01 12:00:00.123400+00'::timestamptz + make_interval(secs => i / 1000000.0), '{}'
    from generate_series(1, 5) i`;
  await s.db.sql`
    insert into example_rows (name, email, status, created_at, data) values
      ('Bob Stone', 'bob@example.com', 'open', '2026-10-02 09:00:00+00', ${JSON.stringify({ message: "<script>alert(1)</script>", budget: "=1+1" })}::jsonb),
      ('50% off Carol', 'carol@example.com', 'done', '2026-10-02 10:00:00+00', '{}')`;
  app = new Hono();
  app.route("/admin", adminRoutes(() => s!.db, { base: "/admin", css: "/site.css", timeZone: "America/Chicago", pageSize: 3 }));
});

after(async () => {
  await s?.drop();
});

const get = (path: string, headers: Record<string, string> = ME) => app.request(HOST + path, { headers });
const post = (path: string, form: Record<string, string | string[]>, headers: Record<string, string> = { ...ME, origin: HOST }) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return app.request(HOST + path, { method: "POST", body, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } });
};
const ids = (html: string) => [...html.matchAll(/id="rows-row-(\d+)"/g)].map((m) => m[1]);
const moreHref = (html: string) => html.match(/<tr id="rows-more">[\s\S]*?href="([^"]+)"/)?.[1].replace(/&amp;/g, "&");

test("no identity header: the list, the export and a change are all 404", async (t) => {
  if (!s) return t.skip(why);
  assert.equal((await get("/admin", {})).status, 404);
  assert.equal((await get("/admin/export.csv", {})).status, 404);
  assert.equal((await post("/admin/1/status", { status: "done" }, { origin: HOST, host: "site.example" })).status, 404);
});

test("search matches name or email, and % is text", async (t) => {
  if (!s) return t.skip(why);
  const bob = await (await get("/admin?q=BOB")).text();
  assert.equal(ids(bob).length, 1);
  assert.ok(bob.includes("Bob Stone"));
  const pct = await (await get("/admin?q=" + encodeURIComponent("50%"))).text();
  assert.equal(ids(pct).length, 1);
  assert.ok(pct.includes("50% off Carol"));
  const none = await (await get("/admin?q=" + encodeURIComponent("%"))).text();
  assert.equal(ids(none).length, 1, "a lone % finds only the row that contains one");
  const miss = await (await get("/admin?q=zzz")).text();
  assert.ok(miss.includes("Nothing matches these filters."));
});

test("the status filter narrows the list; htmx gets only the results block", async (t) => {
  if (!s) return t.skip(why);
  const res = await get("/admin?status=open", { ...ME, "hx-request": "true" });
  const html = await res.text();
  assert.ok(html.startsWith('<div id="results">'), html.slice(0, 80));
  assert.equal(ids(html).length, 1);
  const restore = await (await get("/admin?status=open", { ...ME, "hx-request": "true", "hx-history-restore-request": "true" })).text();
  assert.ok(restore.startsWith("<!DOCTYPE html>") || restore.includes("<html"), "a history restore gets the whole page");
});

test("keyset paging crosses rows made in the same millisecond without a skip or a repeat", async (t) => {
  if (!s) return t.skip(why);
  const seen: string[] = [];
  let path: string | undefined = "/admin";
  let pages = 0;
  while (path) {
    const html = await (await get(path, pages ? { ...ME, "hx-request": "true" } : ME)).text();
    if (pages) assert.ok(html.startsWith("<tr"), "Load more answers with rows only");
    seen.push(...ids(html));
    path = moreHref(html);
    pages++;
  }
  assert.equal(pages, 3);
  const all = await s.db.sql<{ id: string }>`select id::text as id from example_rows order by created_at desc, id desc`;
  assert.deepEqual(seen, all.map((r) => r.id));

  // Without JavaScript, the Load more link is a full page with a way back.
  const first = await (await get("/admin")).text();
  const plain = await (await get(moreHref(first)!)).text();
  assert.ok(plain.includes("Back to the newest") && plain.includes("<html"));
});

test("a status change records who made it; htmx gets the row, a plain post a 303", async (t) => {
  if (!s) return t.skip(why);
  const [{ id }] = await s.db.sql<{ id: string }>`select id::text as id from example_rows where name = 'Bob Stone'`;
  const res = await post(`/admin/${id}/status`, { status: "done", return: "/admin?status=open" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin?status=open&saved=status");
  const [row] = await s.db.sql`select status, updated_by::text as by, updated_at from example_rows where id = ${id}::bigint`;
  assert.equal(row.status, "done");
  assert.equal(row.by, "ann@example.com");
  assert.ok(row.updated_at);

  const hx = await post(`/admin/${id}/status`, { status: "open", return: "/admin" }, { ...ME, origin: HOST, "hx-request": "true" });
  const html = await hx.text();
  assert.ok(html.startsWith(`<tr id="rows-row-${id}"`), html.slice(0, 60));
  assert.match(html, /<option value="open" selected="">/);

  const off = await post(`/admin/${id}/status`, { status: "done", return: "https://evil.example/" });
  assert.equal(off.headers.get("location"), `/admin/${id}?saved=status`);
  assert.equal((await post(`/admin/${id}/status`, { status: "deleted" })).status, 400);
  assert.equal((await post(`/admin/999999/status`, { status: "done" })).status, 404);
});

test("a change from another site is refused and changes nothing", async (t) => {
  if (!s) return t.skip(why);
  const [{ id }] = await s.db.sql<{ id: string }>`select id::text as id from example_rows where name = 'Same ms 1'`;
  const res = await post(`/admin/${id}/status`, { status: "spam" }, { ...ME, origin: "https://evil.example" });
  assert.equal(res.status, 403);
  const bulk = await post("/admin/bulk", { status: "spam", id: [id] }, { ...ME, "sec-fetch-site": "cross-site" });
  assert.equal(bulk.status, 403);
  const [row] = await s.db.sql`select status from example_rows where id = ${id}::bigint`;
  assert.equal(row.status, "new");
});

test("a bulk change updates the selected rows and says how many", async (t) => {
  if (!s) return t.skip(why);
  const rows = await s.db.sql<{ id: string }>`select id::text as id from example_rows where name like 'Same ms %' order by id limit 2`;
  const res = await post("/admin/bulk", { status: "open", id: rows.map((r) => r.id), return: "/admin?q=same" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin?q=same&saved=bulk&n=2");
  const after = await s.db.sql`select status, updated_by::text as by from example_rows where id = any(${rows.map((r) => r.id)}::bigint[])`;
  assert.ok(after.every((r) => r.status === "open" && r.by === "ann@example.com"));
  const page = await (await get(res.headers.get("location")!)).text();
  assert.ok(page.includes("Updated 2 rows."));
  const empty = await post("/admin/bulk", { status: "open", return: "/admin" });
  assert.equal(empty.headers.get("location"), "/admin?saved=none-selected");
});

test("the detail page escapes what was sent and shows who changed it", async (t) => {
  if (!s) return t.skip(why);
  const [{ id }] = await s.db.sql<{ id: string }>`select id::text as id from example_rows where name = 'Bob Stone'`;
  const html = await (await get(`/admin/${id}`)).text();
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("ann@example.com,"));
  assert.equal((await get("/admin/99999999999999999999")).status, 404);
  assert.equal((await get("/admin/424242")).status, 404);
});

test("the export streams every row of the current filter, defused for spreadsheets", async (t) => {
  if (!s) return t.skip(why);
  await s.db.sql`insert into example_rows (name, email, status) values ('=HYPERLINK("http://evil")', 'eve@example.com', 'spam')`;
  const res = await get("/admin/export.csv?status=spam");
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="rows-\d{4}-\d{2}-\d{2}\.csv"$/);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  const lines = text.split("\r\n").filter(Boolean);
  assert.ok(lines[0].startsWith("﻿ID,Name,Email,Status"));
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil"")"`), lines[1]);

  const everything = new TextDecoder().decode(await (await get("/admin/export.csv")).arrayBuffer());
  const total = (await s.db.sql`select count(*)::int as n from example_rows`)[0].n;
  assert.equal(everything.split("\r\n").filter(Boolean).length, total + 1, "more rows than one page of 3, all exported");
});
