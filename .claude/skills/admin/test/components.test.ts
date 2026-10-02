import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { BulkForm } from "../bulk";
import { Activity, FieldList, JsonData } from "../detail";
import { Flash, withFlash } from "../flash";
import { AdminLayout } from "../layout";
import { DataTable, SearchBar, TableRows, When, type TableSpec } from "../list";
import { formIds, likePattern, listUrl, localPath } from "../query";
import { pickStatus, StatusBadge, StatusForm, type StatusOption } from "../status";

const HOSTILE = `<script>alert(1)</script>`;

async function render(el: unknown): Promise<string> {
  const a = new Hono();
  a.get("/", (c) => c.html(el as string));
  return (await a.request("https://site.example/")).text();
}

type R = { id: string; name: string };
const spec: TableSpec<R> = {
  id: "subs",
  columns: [{ label: "Name", cell: (r) => r.name }, { label: "Id", cell: (r) => r.id, class: "hidden sm:table-cell" }],
  href: (r) => `/admin/subs/${r.id}`,
  select: { form: "bulk", label: (r) => r.name },
};
const more = (cur: string) => listUrl("/admin/subs", { q: "x", after: cur });

test("a table escapes what visitors sent and links each row to its detail", async () => {
  const html = await render(DataTable({ spec, caption: "Submissions", rows: [{ id: "7", name: HOSTILE }], next: null, more, empty: "None" }));
  assert.ok(!html.includes("<script>alert"), html);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes('href="/admin/subs/7"'));
  assert.ok(html.includes('id="subs-row-7"'));
  assert.match(html, /<input type="checkbox" name="id" value="7" form="bulk" aria-label="Select &lt;script&gt;/);
  assert.ok(html.includes("<caption"));
  assert.ok(!html.includes("Load more"));
});

test("Load more appears only when there is a next page, and swaps itself", async () => {
  const html = await render(TableRows({ spec, rows: [{ id: "1", name: "a" }], next: "CUR", more }));
  assert.match(html, /<tr id="subs-more">/);
  assert.match(html, /href="\/admin\/subs\?q=x&amp;after=CUR"/);
  assert.match(html, /hx-target="closest tr" hx-swap="outerHTML"/);
  const none = await render(TableRows({ spec, rows: [{ id: "1", name: "a" }], next: null, more }));
  assert.ok(!none.includes("Load more"));
});

test("an empty table says so", async () => {
  const html = await render(DataTable({ spec, caption: "S", rows: [], next: null, more, empty: "Nothing has come in yet." }));
  assert.match(html, /colspan="3"[^>]*>Nothing has come in yet\./);
});

test("the search form is a plain GET that htmx enhances", async () => {
  const opts = [{ value: "new", label: "New" }, { value: "done", label: "Done" }];
  const html = await render(SearchBar({ action: "/admin/subs", target: "#results", q: `"><b>`, filters: [{ name: "status", label: "Status", options: opts, value: "done" }] }));
  assert.match(html, /<form method="get" action="\/admin\/subs" role="search"/);
  assert.ok(html.includes('hx-push-url="true"'));
  assert.ok(html.includes('hx-trigger="input changed delay:300ms, search"'));
  assert.ok(html.includes('value="&quot;&gt;&lt;b&gt;"'));
  assert.match(html, /<option value="done" selected="">Done<\/option>/);
  assert.ok(html.includes(">Clear</a>"));
});

test("the private nav marks the current page", async () => {
  const html = await render(
    AdminLayout({ title: "Rows", css: "/site.css", nav: [{ href: "/admin", label: "Rows" }, { href: "/admin/x", label: "X" }], current: "/admin", user: "ann@example.com" }),
  );
  assert.match(html, /<a href="\/admin" aria-current="page"/);
  assert.match(html, /<a href="\/admin\/x" class=/);
});

const STATUSES: StatusOption[] = [{ value: "new", label: "New", tone: "accent" }, { value: "done", label: "Done" }];

test("a status form posts with its return path, and an inline one swaps its row", async () => {
  const plain = await render(StatusForm({ action: "/admin/1/status", current: "done", options: STATUSES, returnTo: "/admin/1", label: "Status" }));
  assert.match(plain, /<form method="post" action="\/admin\/1\/status"/);
  assert.ok(plain.includes('name="return" value="/admin/1"'));
  assert.match(plain, /<option value="done" selected="">/);
  assert.ok(!plain.includes("hx-post") && !plain.includes("noscript"));
  const inline = await render(StatusForm({ action: "/admin/1/status", current: "new", options: STATUSES, returnTo: "/admin", label: "Status of Ann", swap: "closest tr" }));
  assert.ok(inline.includes('hx-post="/admin/1/status"') && inline.includes('hx-target="closest tr"'));
  assert.ok(inline.includes("<noscript><button"));
  assert.ok(inline.includes('aria-label="Status of Ann"'));
  assert.equal(pickStatus("done", STATUSES), "done");
  assert.equal(pickStatus("deleted", STATUSES), null);
  const badge = await render(StatusBadge({ value: "new", options: STATUSES }));
  assert.ok(badge.includes("bg-accent") && !/#[0-9a-f]{3,6}\b/i.test(badge));
});

test("the bulk form carries its id and return path", async () => {
  const html = await render(BulkForm({ id: "bulk", action: "/admin/bulk", returnTo: "/admin?status=new" }));
  assert.match(html, /<form id="bulk" method="post" action="\/admin\/bulk"/);
  assert.ok(html.includes('name="return" value="/admin?status=new"'));
  assert.deepEqual(formIds(["3", "3", "x", "4; drop", "5"]), ["3", "5"]);
  assert.deepEqual(formIds("9"), ["9"]);
  assert.deepEqual(formIds(undefined), []);
});

test("JSON a visitor sent is readable and escaped", async () => {
  const html = await render(JsonData({ data: { [HOSTILE]: "<img src=x onerror=alert(1)>", tags: ["a", "b"], ok: true, nested: { site: "javascript:alert(1)" } } }));
  assert.ok(!html.includes("<script>") && !html.includes("<img"), html);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("a, b") && html.includes(">Yes<"));
  assert.ok(!html.includes("<a "), "stored values are never links");
  assert.ok((await render(JsonData({ data: {} }))).includes("Nothing else was sent."));
  const fields = await render(FieldList({ fields: [{ label: "Email", value: null }] }));
  assert.ok(fields.includes(">None<"));
});

test("activity shows times in the business's zone, not the server's", async () => {
  const html = await render(Activity({ entries: [{ at: new Date("2026-01-01T03:30:00Z"), by: "ann@example.com", text: HOSTILE }], timeZone: "America/Chicago" }));
  assert.ok(html.includes("9:30") && html.includes("Dec 31, 2025"), html);
  assert.ok(html.includes('datetime="2026-01-01T03:30:00.000Z"'));
  assert.ok(!html.includes("<script>alert"));
  assert.equal(await render(When({ at: "not a date", timeZone: "UTC" }) ?? ""), "");
});

test("a flash shows only the app's own words", async () => {
  const messages = { status: "Status saved.", bulk: (n: number) => `Updated ${n}.` };
  assert.match(await render(Flash({ code: "status", messages })), /role="status"[^>]*>Status saved\./);
  assert.ok((await render(Flash({ code: "bulk", n: "3", messages }))).includes("Updated 3."));
  assert.equal(await render(Flash({ code: "toString", messages }) ?? ""), "");
  assert.equal(await render(Flash({ code: HOSTILE, messages }) ?? ""), "");
  assert.equal(withFlash("/admin?status=new&after=abc", "bulk", 2), "/admin?status=new&saved=bulk&n=2");
});

test("search patterns treat wildcards as text; return paths stay inside the app", () => {
  assert.equal(likePattern(" 50%_off\\ "), "%50\\%\\_off\\\\%");
  assert.equal(likePattern("  "), null);
  assert.equal(listUrl("/admin", { q: "a b", status: "", after: null }), "/admin?q=a+b");
  assert.equal(localPath("/admin?status=new", "/admin", "/admin"), "/admin?status=new");
  for (const bad of ["//evil.example/admin", "https://evil.example/admin", "/administrator", "/\\evil", "/other"]) {
    assert.equal(localPath(bad, "/admin", "/admin"), "/admin", bad);
  }
});

test("a return path that resolves off the site is refused, and a flash never leaves it", async () => {
  const { localPath } = await import("../query");
  const { withFlash } = await import("../flash");
  for (const evil of ["/admin/..//evil.example", "/admin/%2e%2e//evil.example", "//evil.example", "/\\evil.example"]) {
    assert.equal(localPath(evil, "/admin", "/admin"), "/admin", evil);
  }
  // A doubled slash after the first segment is still a path on this site.
  assert.equal(localPath("/admin/.//x", "/admin", "/"), "/admin//x");
  assert.equal(localPath("/admin/forms?status=new", "/admin", "/"), "/admin/forms?status=new");
  assert.ok(!withFlash("/.//evil.example", "done").startsWith("//"));
  assert.equal(withFlash("/admin/forms?after=x", "done"), "/admin/forms?saved=done");
});
