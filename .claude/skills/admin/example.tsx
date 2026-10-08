// A complete private list over one table, wired from every piece in
// this folder: search, a status filter, Load more, a detail page, a status
// change that records who made it, a bulk change, and a CSV of the current
// filter streamed page by page. Copy it and rename; `example_rows` is
// a stand-in for the owning skill's table (submissions, bookings,
// payments), whose schema.sql carries the indexes this list needs:
//
//   create index if not exists example_rows_recent on example_rows (created_at desc, id desc);
//   create index if not exists example_rows_name_trgm on example_rows using gin (name gin_trgm_ops);
//   create index if not exists example_rows_email_trgm on example_rows using gin ((email::text) gin_trgm_ops);
//
// Mount it on the private prefix; `getDb` makes the request's handle (db.ts):
//   app.route("/admin/rows", adminRoutes(getDb, { base: "/admin/rows", css: "/site.css", timeZone: "America/Chicago" }));
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db, GetDb } from "../data/db";
import { BulkForm } from "./bulk";
import { csvResponse, type CsvColumn } from "./csv";
import { FieldList, JsonData, Section } from "./detail";
import { Flash, withFlash, type FlashMessages } from "./flash";
import { teamOnly, type TeamVars } from "./guard";
import { cut, everyPage, readCursor, type Cursor, type Keyed } from "./keyset";
import { AdminLayout, type NavItem } from "./layout";
import { DataTable, SearchBar, TableRow, TableRows, When, type TableSpec } from "./list";
import { formIds, idParam, isPartial, likePattern, listUrl, localPath, str } from "./query";
import { controlClass, pickStatus, StatusBadge, StatusForm, type StatusOption } from "./status";

export type AdminOptions = { base: string; css: string; timeZone: string; nav?: NavItem[]; pageSize?: number };

export const STATUSES: StatusOption[] = [
  { value: "new", label: "New", tone: "accent" },
  { value: "open", label: "Open", tone: "strong" },
  { value: "done", label: "Done", tone: "neutral" },
  { value: "spam", label: "Spam", tone: "muted" },
];

const MESSAGES: FlashMessages = {
  status: "Status saved.",
  bulk: (n) => (n === 1 ? "Updated 1 row." : `Updated ${n} rows.`),
  "none-selected": "Select at least one row first.",
  "pick-status": "Choose a status to apply.",
};

type Item = Keyed & {
  id: string;
  name: string | null;
  email: string | null;
  status: string;
  created_at: Date;
  updated_by: string | null;
};
type Full = Item & { data: Record<string, unknown> | null; source: string | null; updated_at: Date | null };
type ListFilter = { q: string | null; status: string | null };

export function readFilter(c: Context): ListFilter {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  return { q: q || null, status: pickStatus(c.req.query("status"), STATUSES) };
}

/** One page plus one row, newest first, after the cursor. */
export function listPage(db: Db, f: ListFilter, after: Cursor | null, size: number): Promise<Item[]> {
  const pat = likePattern(f.q);
  return db.sql<Item>`
    select id::text as id, name, email::text as email, status, created_at, updated_by::text as updated_by, created_at::text as k
    from example_rows r
    where (${pat}::text is null or r.name ilike ${pat} or r.email::text ilike ${pat})
      and (${f.status}::text is null or r.status = ${f.status})
      and (${after?.k ?? null}::timestamptz is null
           or (r.created_at, r.id) < (${after?.k ?? null}::timestamptz, ${after?.id ?? null}::bigint))
    order by r.created_at desc, r.id desc
    limit ${size + 1}`;
}

const CSV: CsvColumn<Item>[] = [
  { label: "ID", value: (r) => r.id },
  { label: "Name", value: (r) => r.name },
  { label: "Email", value: (r) => r.email },
  { label: "Status", value: (r) => r.status },
  { label: "Received (UTC)", value: (r) => r.created_at },
  { label: "Last changed by", value: (r) => r.updated_by },
];

export function adminRoutes(getDb: GetDb, opts: AdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const size = opts.pageSize ?? 50;
  const nav = opts.nav ?? [{ href: base, label: "Rows" }];
  const name = (r: Item) => r.name || r.email || `Row ${r.id}`;
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  // The status cell is a form that swaps its own row; `returnTo` is where a
  // plain post lands, so it is the list as the person filtered it.
  const spec = (returnTo: string): TableSpec<Item> => ({
    id: "rows",
    href: (r) => `${base}/${r.id}`,
    select: { form: "bulk", label: name },
    columns: [
      { label: "Name", cell: name },
      { label: "Email", cell: (r) => r.email ?? "", class: "hidden sm:table-cell" },
      {
        label: "Status",
        cell: (r) => (
          <StatusForm action={`${base}/${r.id}/status`} current={r.status} options={STATUSES} returnTo={returnTo} label={`Status of ${name(r)}`} swap="closest tr" />
        ),
      },
      { label: "Received", cell: (r) => <When at={r.created_at} timeZone={opts.timeZone} />, class: "hidden md:table-cell" },
    ],
  });

  app.get("/", async (c) => {
    const f = readFilter(c);
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await listPage(getDb(c), f, after, size), size);
    const self = listUrl(base, { q: f.q, status: f.status });
    const more = (cur: string) => listUrl(base, { q: f.q, status: f.status, after: cur });
    const s = spec(self);
    if (isPartial(c) && after) return c.html(<TableRows spec={s} rows={page} next={next} more={more} />);

    const results = (
      <div id="results">
        <BulkForm id="bulk" action={`${base}/bulk`} returnTo={self}>
          <label class="flex flex-col gap-1 text-label text-ink-2">
            Set selected to
            <select name="status" class={controlClass}>
              {STATUSES.map((o) => (
                <option value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </BulkForm>
        {after ? (
          <p class="mb-3 text-label">
            <a href={self}>Back to the newest</a>
          </p>
        ) : null}
        <DataTable
          spec={s}
          caption="Rows, newest first"
          rows={page}
          next={next}
          more={more}
          empty={
            f.q || f.status ? (
              <>
                Nothing matches these filters. <a href={base}>Clear filters</a>
              </>
            ) : (
              "Nothing has come in yet."
            )
          }
        />
        <p class="mt-3 text-label">
          <a href={listUrl(`${base}/export.csv`, { q: f.q, status: f.status })}>Export CSV</a>
        </p>
      </div>
    );
    if (isPartial(c)) return c.html(results);
    return c.html(
      <AdminLayout title="Rows" css={opts.css} nav={nav} current={base} user={c.get("user")}>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <SearchBar
          action={base}
          target="#results"
          q={f.q}
          placeholder="Name or email"
          filters={[{ name: "status", label: "Status", options: STATUSES, value: f.status, any: "Any status" }]}
        />
        {results}
      </AdminLayout>,
    );
  });

  app.get("/export.csv", (c) => {
    const day = new Date().toISOString().slice(0, 10);
    const db = getDb(c);
    const f = readFilter(c);
    return csvResponse(`rows-${day}.csv`, CSV, everyPage((after, size) => listPage(db, f, after, size)));
  });

  app.post("/bulk", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const ret = localPath(str(body.return), base, base);
    const status = pickStatus(body.status, STATUSES);
    const ids = formIds(body.id);
    if (!ids.length) return c.redirect(withFlash(ret, "none-selected"), 303);
    if (!status) return c.redirect(withFlash(ret, "pick-status"), 303);
    const changed = await getDb(c).sql`
      update example_rows
      set status = ${status}, updated_at = now(), updated_by = ${c.get("user")}
      where id = any(${ids}::bigint[]) and status <> ${status}
      returning id`;
    return c.redirect(withFlash(ret, "bulk", changed.length), 303);
  });

  app.get("/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const [r] = await getDb(c).sql<Full>`
      select id::text as id, name, email::text as email, status, created_at, updated_by::text as updated_by,
             created_at::text as k, data, source, updated_at
      from example_rows where id = ${id}::bigint`;
    if (!r) return c.notFound();
    const self = `${base}/${r.id}`;
    return c.html(
      <AdminLayout title={name(r)} css={opts.css} nav={nav} current={base} user={c.get("user")}>
        <p class="mb-4 text-label">
          <a href={base}>All rows</a>
        </p>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <div class="flex flex-col gap-4 md:col-span-2">
            <Section title="Details">
              <FieldList
                fields={[
                  { label: "Name", value: r.name },
                  { label: "Email", value: r.email },
                  { label: "Status", value: <StatusBadge value={r.status} options={STATUSES} /> },
                  { label: "Received", value: <When at={r.created_at} timeZone={opts.timeZone} /> },
                  { label: "From", value: r.source },
                  {
                    label: "Last changed",
                    value: r.updated_by ? (
                      <>
                        {r.updated_by}, <When at={r.updated_at} timeZone={opts.timeZone} />
                      </>
                    ) : null,
                  },
                ]}
              />
            </Section>
            <Section title="What they sent">
              <JsonData data={r.data} />
            </Section>
          </div>
          <Section title="Status">
            <StatusForm action={`${self}/status`} current={r.status} options={STATUSES} returnTo={self} label="Status" />
          </Section>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/:id/status", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const status = pickStatus(body.status, STATUSES);
    if (!status) return c.text("Choose one of the listed statuses.", 400);
    const ret = localPath(str(body.return), base, `${base}/${id}`);
    const [row] = await getDb(c).sql<Item>`
      update example_rows
      set status = ${status}, updated_at = now(), updated_by = ${c.get("user")}
      where id = ${id}::bigint
      returning id::text as id, name, email::text as email, status, created_at, updated_by::text as updated_by, created_at::text as k`;
    if (!row) return c.notFound();
    if (isPartial(c)) return c.html(<TableRow spec={spec(ret)} row={row} />);
    return c.redirect(withFlash(ret, "status"), 303);
  });

  return app;
}
