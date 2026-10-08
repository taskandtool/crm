// The private side of forms: the forms, what came in (per form and across
// them), one submission, its status, a CSV export, and the form editor that
// writes forms. Built from admin/'s pieces; teamOnly is applied here
// as well, so a mount that forgets it still answers 404.
//
//   app.route("/admin/forms", formsAdmin(getDb, {
//     base: "/admin/forms", css: "/site.css", timeZone: "America/Chicago", source: "website" }));
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import type { Db, GetDb } from "../data/db";
import { normalizeEmail } from "../data/email";
import { BulkForm } from "../admin/bulk";
import { csvResponse, type CsvColumn } from "../admin/csv";
import { FieldList, JsonData, Section } from "../admin/detail";
import { Flash, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { cut, everyPage, readCursor, type Cursor, type Keyed } from "../admin/keyset";
import { AdminLayout, type NavItem } from "../admin/layout";
import { DataTable, SearchBar, TableRow, TableRows, When, type TableSpec } from "../admin/list";
import { formIds, idParam, isPartial, likePattern, listUrl, localPath, str } from "../admin/query";
import { buttonClass, controlClass, pickStatus, StatusBadge, StatusForm, type StatusOption } from "../admin/status";
import { checkFields, FIELD_TYPES, FORM_KEY, sitePath, type Errors, type Field, type Form } from "./fields";
import { cameFrom } from "./origin";
import { linkedTo, type Linked } from "./linked";
import { priceOf } from "./price";
import { formatMoney } from "../payments/money";
import { CONTACT_FORM, toForm } from "./store";

export type FormsAdminOptions = {
  base: string;
  css: string;
  timeZone: string;
  /** This app's slug, stored on the forms it creates. */
  source: string;
  nav?: NavItem[];
  pageSize?: number;
  /** The app's own page frame (the CRM's layout and nav) instead of AdminLayout. */
  Frame?: (p: { title: string; user: string; children: Child }) => Child;
  /** Where a submission's booking and payment are shown, when the app has those pages. */
  links?: { booking?: (id: string) => string; payment?: (id: string) => string };
};

export const STATUSES: StatusOption[] = [
  { value: "new", label: "New", tone: "accent" },
  { value: "read", label: "Read", tone: "strong" },
  { value: "done", label: "Done", tone: "neutral" },
  { value: "spam", label: "Spam", tone: "muted" },
];

const MESSAGES: FlashMessages = {
  status: "Status saved.",
  bulk: (n) => (n === 1 ? "Updated 1 submission." : `Updated ${n} submissions.`),
  "none-selected": "Select at least one submission first.",
  "pick-status": "Choose a status to apply.",
  saved: "Form saved.",
  created: "Form created. Add its questions below.",
};

type Item = Keyed & {
  id: string;
  form_key: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  page: string | null;
  source: string;
  created_at: Date;
  /** When the whole form was done; null while a booking or payment step is still to do. */
  completed_at: Date | null;
  updated_by: string | null;
  data: Record<string, unknown> | null;
  /** Its booking and payment (linked.ts), on the list and the page. */
  linked?: Linked;
};
export type SubmissionFilter = { q: string | null; status: string | null; form: string | null };

export function readFilter(c: Context): SubmissionFilter {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const form = c.req.query("form") ?? "";
  return { q: q || null, status: pickStatus(c.req.query("status"), STATUSES), form: FORM_KEY.test(form) ? form : null };
}

/**
 * One page plus one row, newest first. With no status chosen, spam is left
 * out: it is there to be checked, not read. `data` only when asked (the export).
 */
export function listPage(db: Db, f: SubmissionFilter, after: Cursor | null, size: number, withData = false): Promise<Item[]> {
  const pat = likePattern(f.q);
  return db.sql<Item>`
    select id::text as id, form_key, name, email::text as email, phone, status, page, source, created_at, completed_at,
           updated_by::text as updated_by, created_at::text as k, case when ${withData} then data end as data
    from submissions s
    where (${f.form}::text is null or s.form_key = ${f.form})
      and (case when ${f.status}::text is null then s.status <> 'spam' else s.status = ${f.status} end)
      and (${pat}::text is null or s.name ilike ${pat} or s.email::text ilike ${pat})
      and (${after?.k ?? null}::timestamptz is null
           or (s.created_at, s.id) < (${after?.k ?? null}::timestamptz, ${after?.id ?? null}::bigint))
    order by s.created_at desc, s.id desc
    limit ${size + 1}`;
}

/** Each form's title by its key: what a list shows instead of the key. */
async function formTitles(db: Db): Promise<Map<string, string>> {
  return new Map((await db.sql<{ key: string; title: string }>`select key, title from forms`).map((f) => [f.key, f.title]));
}

async function allForms(db: Db) {
  return db.sql<{ key: string; title: string; active: boolean; new_count: number; total: number }>`
    select f.key, f.title, f.active,
           (select count(*) from submissions s where s.form_key = f.key and s.status = 'new')::int as new_count,
           (select count(*) from submissions s where s.form_key = f.key and s.status <> 'spam')::int as total
    from forms f
    order by f.title, f.key`;
}

async function formRow(db: Db, key: string) {
  const [row] = await db.sql`
    select key, title, fields, notify_emails::text[] as notify_emails, redirect_to, success_message, submit_label, active,
           updated_at::text as version
    from forms where key = ${key}`;
  return row ? { form: toForm(row), raw: (Array.isArray(row.fields) ? row.fields : []) as Record<string, unknown>[], version: row.version as string } : null;
}

export function formsAdmin(getDb: GetDb, opts: FormsAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const subs = `${base}/submissions`;
  const size = opts.pageSize ?? 50;
  const nav = opts.nav ?? [
    { href: base, label: "Forms" },
    { href: subs, label: "Submissions" },
  ];
  const who = (r: Item) => r.name || r.email || `Submission ${r.id}`;
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  const layout = (c: Context<{ Variables: TeamVars }>, title: string, current: string, body: Child) => {
    const flash = <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />;
    if (!opts.Frame) {
      return (
        <AdminLayout title={title} css={opts.css} nav={nav} current={current} user={c.get("user")}>
          {flash}
          {body}
        </AdminLayout>
      );
    }
    // In the app's own frame the sections are links at the top, as the booking pages do.
    const sections = (
      <nav aria-label="Forms" class="mb-4 flex flex-wrap gap-1 text-label">
        {nav.map((n) => (
          <a href={n.href} aria-current={current === n.href ? "page" : undefined}
            class={"rounded-control px-2 py-1 no-underline " + (current === n.href ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>
            {n.label}
          </a>
        ))}
      </nav>
    );
    return <>{opts.Frame({ title, user: c.get("user"), children: <>{sections}{flash}{body}</> })}</>;
  };
  const withLinks = async (db: Db, rows: Item[]) => {
    const linked = await linkedTo(db, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, linked: linked.get(r.id) }));
  };

  // ---- forms -------------------------------------------------------------

  app.get("/", async (c) => {
    const forms = await allForms(getDb(c));
    return c.html(
      layout(
        c,
        "Forms",
        base,
        <>
          {forms.length ? (
            <div class="overflow-x-auto rounded-card border border-line bg-surface">
              <table class="w-full border-collapse text-copy">
                <caption class="sr-only">Forms</caption>
                <thead>
                  <tr class="border-b border-line-strong text-left text-label text-ink-3">
                    <th scope="col" class="px-3 py-2 font-semibold">Form</th>
                    <th scope="col" class="px-3 py-2 font-semibold">New</th>
                    <th scope="col" class="px-3 py-2 font-semibold">All</th>
                    <th scope="col" class="px-3 py-2 font-semibold">State</th>
                  </tr>
                </thead>
                <tbody>
                  {forms.map((f) => (
                    <tr class="border-b border-line last:border-b-0">
                      <td class="px-3 py-2">
                        <a href={`${base}/form/${f.key}`} class="font-semibold">
                          {f.title}
                        </a>
                        <span class="ml-2 text-label text-ink-3">{f.key}</span>
                      </td>
                      <td class="px-3 py-2">
                        <a href={listUrl(subs, { form: f.key, status: "new" })}>{f.new_count}</a>
                      </td>
                      <td class="px-3 py-2">
                        <a href={listUrl(subs, { form: f.key })}>{f.total}</a>
                      </td>
                      <td class="px-3 py-2 text-ink-2">{f.active ? "Taking submissions" : "Switched off"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="text-ink-2">There are no forms yet.</p>
          )}
          <NewForm action={base} />
        </>,
      ),
    );
  });

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const key = str(body.key).trim().toLowerCase();
    const title = str(body.title).trim();
    const errors: Errors = {};
    if (!FORM_KEY.test(key)) errors.key = "Use lowercase letters, digits and hyphens, like contact or quote-request.";
    if (!title) errors.title = "Give the form a title.";
    if (!errors.key && !errors.title) {
      const made = await getDb(c).sql`
        insert into forms (key, title, fields, source, updated_by)
        values (${key}, ${title}, ${JSON.stringify(CONTACT_FORM.fields)}::jsonb, ${opts.source}, ${c.get("user")})
        on conflict (key) do nothing
        returning key`;
      if (made.length) return c.redirect(withFlash(`${base}/form/${key}`, "created"), 303);
      errors.key = "A form with this key exists already. Choose another.";
    }
    return c.html(layout(c, "Forms", base, <NewForm action={base} key_={key} title={title} errors={errors} />), 422);
  });

  app.get("/form/:key", async (c) => {
    const found = await formRow(getDb(c), c.req.param("key"));
    if (!found) return c.notFound();
    return c.html(layout(c, `Edit ${found.form.title}`, base, <Editor base={base} form={found.form} raw={found.raw} version={found.version} />));
  });

  app.post("/form/:key", async (c) => {
    const db = getDb(c);
    const found = await formRow(db, c.req.param("key"));
    if (!found) return c.notFound();
    const draft = readEditor(await c.req.parseBody({ all: true }));
    const { fields, problems } = checkFields(draft.fields);
    const formProblems: Errors = {};
    if (!draft.title) formProblems.title = "Give the form a title.";
    if (draft.badEmails.length) formProblems.notify_emails = `These are not email addresses: ${draft.badEmails.join(", ")}.`;
    if (draft.redirect_to && !sitePath(draft.redirect_to)) formProblems.redirect_to = "Use a path on this site that starts with /, like /thank-you.";
    const form: Form = {
      key: found.form.key,
      title: draft.title,
      fields,
      notify_emails: draft.notify_emails,
      redirect_to: sitePath(draft.redirect_to),
      success_message: draft.success_message || null,
      submit_label: draft.submit_label || null,
      active: draft.active,
    };
    const again = (status: 409 | 422, note?: string, version = draft.version) =>
      c.html(
        layout(
          c,
          `Edit ${found.form.title}`,
          base,
          <Editor base={base} form={form} raw={draft.fields} version={version} problems={problems} formProblems={formProblems} note={note} />,
        ),
        status,
      );
    if (Object.keys(problems).length || Object.keys(formProblems).length) return again(422);

    // Saved only over the version the editor opened, so two people editing at
    // once cannot silently overwrite each other.
    const saved = await db.sql`
      update forms
      set title = ${form.title}, fields = ${JSON.stringify(fields)}::jsonb, notify_emails = ${form.notify_emails}::citext[],
          redirect_to = ${form.redirect_to}, success_message = ${form.success_message}, submit_label = ${form.submit_label},
          active = ${form.active}, updated_by = ${c.get("user")}, updated_at = now()
      where key = ${form.key} and updated_at::text = ${draft.version}
      returning key`;
    if (!saved.length) {
      return again(409, "Someone saved this form after you opened it, so your changes are not saved yet. Check them below and save again to replace theirs.", found.version);
    }
    return c.redirect(withFlash(`${base}/form/${form.key}`, "saved") + `#${draft.focus}`, 303);
  });

  // ---- submissions -------------------------------------------------------

  const spec = (returnTo: string, showForm: boolean, titles: Map<string, string>): TableSpec<Item> => ({
    id: "subs",
    href: (r) => `${subs}/${r.id}`,
    select: { form: "bulk", label: who },
    columns: [
      { label: "From", cell: who },
      { label: "Email", cell: (r) => r.email ?? "", class: "hidden sm:table-cell" },
      ...(showForm ? [{ label: "Form", cell: (r: Item) => titles.get(r.form_key) ?? r.form_key, class: "hidden md:table-cell" }] : []),
      {
        label: "Status",
        cell: (r) => <StatusForm action={`${subs}/${r.id}/status`} current={r.status} options={STATUSES} returnTo={returnTo} label={`Status of ${who(r)}`} swap="closest tr" />,
      },
      {
        label: "Booked, paid",
        class: "hidden sm:table-cell",
        cell: (r) => (
          <>
            {r.linked?.booking ? <span class="block"><When at={r.linked.booking.starts_at} timeZone={opts.timeZone} />{r.linked.booking.status === "cancelled" ? " (cancelled)" : ""}</span> : null}
            {r.linked?.payment ? <span class="block text-label">{r.linked.payment.label}</span> : null}
            {r.completed_at ? null : <span class="block text-label text-ink-2">Not complete</span>}
          </>
        ),
      },
      { label: "Received", cell: (r) => <When at={r.created_at} timeZone={opts.timeZone} />, class: "hidden md:table-cell" },
    ],
  });

  app.get("/submissions", async (c) => {
    const db = getDb(c);
    const f = readFilter(c);
    const after = readCursor(c.req.query("after"));
    const cutPage = cut(await listPage(db, f, after, size), size);
    const next = cutPage.next;
    const page = await withLinks(db, cutPage.page);
    const params = { q: f.q, status: f.status, form: f.form };
    const self = listUrl(subs, params);
    const more = (cur: string) => listUrl(subs, { ...params, after: cur });
    const s = spec(self, !f.form, await formTitles(db));
    if (isPartial(c) && after) return c.html(<TableRows spec={s} rows={page} next={next} more={more} />);

    const results = (
      <div id="results">
        <BulkForm id="bulk" action={`${subs}/bulk`} returnTo={self}>
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
          caption="Submissions, newest first"
          rows={page}
          next={next}
          more={more}
          empty={f.q || f.status || f.form ? <>Nothing matches these filters. <a href={subs}>Clear filters</a></> : "Nothing has come in yet."}
        />
        <p class="mt-3 flex flex-wrap gap-x-4 text-label">
          <a href={listUrl(`${subs}.csv`, params)}>Export CSV</a>
          <a href={listUrl(`${subs}/unfinished`, { form: f.form })}>Not finished</a>
        </p>
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const forms = await allForms(db);
    return c.html(
      layout(
        c,
        "Submissions",
        subs,
        <>
          <SearchBar
            action={subs}
            target="#results"
            q={f.q}
            placeholder="Name or email"
            filters={[
              { name: "form", label: "Form", options: forms.map((x) => ({ value: x.key, label: x.title })), value: f.form, any: "Every form" },
              { name: "status", label: "Status", options: STATUSES, value: f.status, any: "All but spam" },
            ]}
          />
          {results}
        </>,
      ),
    );
  });

  app.get("/submissions.csv", async (c) => {
    const db = getDb(c);
    const f = readFilter(c);
    const form = f.form ? (await formRow(db, f.form))?.form : null;
    const answers: CsvColumn<Item>[] = form
      ? form.fields
          .filter((x) => !["name", "email", "phone"].includes(x.name))
          .map((x) => ({ label: x.label, value: (r: Item) => (r.data && Object.hasOwn(r.data, x.name) ? r.data[x.name] : null) }))
      : [{ label: "Answers", value: (r: Item) => r.data }];
    const columns: CsvColumn<Item>[] = [
      { label: "ID", value: (r) => r.id },
      { label: "Received (UTC)", value: (r) => r.created_at },
      { label: "Form", value: (r) => r.form_key },
      { label: "Status", value: (r) => r.status },
      { label: "Name", value: (r) => r.name },
      { label: "Email", value: (r) => r.email },
      { label: "Phone", value: (r) => r.phone },
      ...answers.map((col) => ({ ...col, value: (r: Item) => flat(col.value(r)) })),
      { label: "Page", value: (r) => r.page },
      { label: "Came from", value: (r) => cameFrom(r.data) },
      { label: "App", value: (r) => r.source },
    ];
    const day = new Date().toISOString().slice(0, 10);
    return csvResponse(`${f.form ?? "submissions"}-${day}.csv`, columns, everyPage((after, size) => listPage(db, f, after, size, true)));
  });

  app.post("/submissions/bulk", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const ret = localPath(str(body.return), subs, subs);
    const status = pickStatus(body.status, STATUSES);
    const ids = formIds(body.id);
    if (!ids.length) return c.redirect(withFlash(ret, "none-selected"), 303);
    if (!status) return c.redirect(withFlash(ret, "pick-status"), 303);
    const changed = await getDb(c).sql`
      update submissions
      set status = ${status}, updated_at = now(), updated_by = ${c.get("user")}
      where id = any(${ids}::bigint[]) and status <> ${status}
      returning id`;
    return c.redirect(withFlash(ret, "bulk", changed.length), 303);
  });

  // Forms with steps that someone started and has not finished (store.ts drafts): the newest 200.
  app.get("/submissions/unfinished", async (c) => {
    const db = getDb(c);
    const formKey = c.req.query("form") ?? "";
    const only = FORM_KEY.test(formKey) ? formKey : null;
    const rows = await db.sql<{ id: string; form_key: string; name: string | null; email: string | null; step: number; updated_at: Date }>`
      select id::text as id, form_key, name, email::text as email, step, updated_at from submission_drafts
      where submission_id is null and not spam and (${only}::text is null or form_key = ${only})
      order by updated_at desc, id desc limit 200`;
    const forms = new Map((await allForms(db)).map((f) => [f.key, f.title]));
    return c.html(
      layout(
        c,
        "Not finished",
        subs,
        <>
          <p class="mb-4 max-w-prose text-ink-2">
            People who started a form with steps and stopped before the end. What they answered is kept; nobody was emailed about it.
          </p>
          {rows.length ? (
            <div class="overflow-x-auto rounded-card border border-line bg-surface">
              <table class="w-full border-collapse text-copy">
                <thead>
                  <tr class="border-b border-line-strong text-left text-label text-ink-3">
                    <th scope="col" class="px-3 py-2 font-semibold">Who</th>
                    <th scope="col" class="px-3 py-2 font-semibold">Form</th>
                    <th scope="col" class="px-3 py-2 font-semibold">Steps done</th>
                    <th scope="col" class="px-3 py-2 font-semibold">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr class="border-b border-line">
                      <td class="px-3 py-2">{d.name || d.email || "Not given yet"}{d.name && d.email ? <span class="block text-label text-ink-2">{d.email}</span> : null}</td>
                      <td class="px-3 py-2">{forms.get(d.form_key) ?? d.form_key}</td>
                      <td class="px-3 py-2">{d.step}</td>
                      <td class="px-3 py-2"><When at={d.updated_at} timeZone={opts.timeZone} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="text-ink-3">Nobody has stopped part way.</p>
          )}
        </>,
      ),
    );
  });

  app.get("/submissions/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const db = getDb(c);
    const [r] = await db.sql<Item & { updated_at: Date }>`
      select id::text as id, form_key, name, email::text as email, phone, status, page, source, created_at, completed_at,
             updated_by::text as updated_by, updated_at, created_at::text as k, data
      from submissions where id = ${id}::bigint`;
    if (!r) return c.notFound();
    const form = (await formRow(db, r.form_key))?.form;
    const data = { ...(r.data ?? {}) };
    const answers = (form?.fields ?? [])
      .filter((x) => Object.hasOwn(data, x.name))
      .map((x) => {
        const v = data[x.name];
        delete data[x.name];
        return { label: x.label, value: Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : (v as Child) };
      });
    const consent = data._consent as Record<string, string> | undefined;
    const from = cameFrom(data);
    delete data._consent;
    delete data._utm;
    delete data._referrer;
    delete data._charges;
    delete data._lines;
    const self = `${subs}/${r.id}`;
    const linked = (await linkedTo(db, [r.id])).get(r.id)!;
    let price: ReturnType<typeof priceOf> = null;
    try {
      price = form ? priceOf(form, r.data ?? {}) : null;
    } catch {
      price = null; // amounts in two currencies: shown as answers only
    }
    return c.html(
      layout(
        c,
        who(r),
        subs,
        <>
          <p class="mb-4 text-label">
            <a href={listUrl(subs, { form: r.form_key })}>All {form?.title ?? r.form_key} submissions</a>
          </p>
          <div class="grid gap-4 md:grid-cols-3">
            <div class="flex flex-col gap-4 md:col-span-2">
              <Section title="Details">
                <FieldList
                  fields={[
                    { label: "Name", value: r.name },
                    { label: "Email", value: r.email },
                    { label: "Phone", value: r.phone },
                    { label: "Form", value: form?.title ?? r.form_key },
                    { label: "Status", value: <StatusBadge value={r.status} options={STATUSES} /> },
                    { label: "Received", value: <When at={r.created_at} timeZone={opts.timeZone} /> },
                    { label: "Completed", value: r.completed_at ? <When at={r.completed_at} timeZone={opts.timeZone} /> : "Not yet: a booking or payment step is still to do" },
                    { label: "Page", value: r.page },
                    { label: "Came from", value: from },
                    { label: "App", value: r.source },
                    { label: "Last changed", value: r.updated_by ? <>{r.updated_by}, <When at={r.updated_at} timeZone={opts.timeZone} /></> : null },
                  ]}
                />
              </Section>
              {price ? (
                <Section title="Order">
                  <FieldList fields={[
                    ...price.lines.map((l) => ({ label: l.quantity > 1 ? `${l.quantity} x ${l.label}` : l.label, value: formatMoney(l.quantity * l.unit_cents, price!.currency) })),
                    { label: "Total before tax", value: <strong>{formatMoney(price.subtotal_cents, price.currency)}</strong> },
                  ]} />
                </Section>
              ) : null}
              <Section title="Answers">
                {answers.length ? <FieldList fields={answers} /> : null}
                {Object.keys(data).length ? <JsonData data={data} /> : answers.length ? null : <p class="text-ink-3">No other answers.</p>}
              </Section>
              {consent && Object.keys(consent).length ? (
                <Section title="Agreed to">
                  <ul class="list-disc pl-5">
                    {Object.values(consent).map((t) => (
                      <li>{t}</li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
            <div class="flex flex-col gap-4">
              <Section title="Status">
                <StatusForm action={`${self}/status`} current={r.status} options={STATUSES} returnTo={self} label="Status" />
              </Section>
              {linked.booking ? (
                <Section title="Booking">
                  <p><When at={linked.booking.starts_at} timeZone={opts.timeZone} /></p>
                  <p class="text-label text-ink-2">{linked.booking.status === "cancelled" ? "Cancelled" : linked.booking.held && !linked.payment?.label.startsWith("Paid") ? "Held until it is paid" : "Booked"}</p>
                  {opts.links?.booking ? <p class="mt-2 text-label"><a href={opts.links.booking(linked.booking.id)}>The booking</a></p> : null}
                </Section>
              ) : null}
              {linked.payment ? (
                <Section title="Payment">
                  <p>{linked.payment.label}</p>
                  {opts.links?.payment ? <p class="mt-2 text-label"><a href={opts.links.payment(linked.payment.id)}>The payment</a></p> : null}
                </Section>
              ) : null}
            </div>
          </div>
        </>,
      ),
    );
  });

  app.post("/submissions/:id/status", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const status = pickStatus(body.status, STATUSES);
    if (!status) return c.text("Choose one of the listed statuses.", 400);
    const ret = localPath(str(body.return), subs, `${subs}/${id}`);
    const [row] = await getDb(c).sql<Item>`
      update submissions
      set status = ${status}, updated_at = now(), updated_by = ${c.get("user")}
      where id = ${id}::bigint
      returning id::text as id, form_key, name, email::text as email, phone, status, page, source, created_at, completed_at,
                updated_by::text as updated_by, created_at::text as k, null::jsonb as data`;
    if (!row) return c.notFound();
    if (isPartial(c)) return c.html(<TableRow spec={spec(ret, !ret.includes("form="), await formTitles(getDb(c)))} row={(await withLinks(getDb(c), [row]))[0]} />);
    return c.redirect(withFlash(ret, "status"), 303);
  });

  return app;
}

/** A spreadsheet cell from an answer: lists joined, yes or no for a box. */
function flat(v: unknown): unknown {
  return Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : v;
}

// ---- the form editor -----------------------------------------------------
//
// One plain form. Every button saves: "Add a question", "Move up", "Remove"
// each post the whole form with an `op`, the server applies the op to what
// was posted, checks it, saves and redirects back. Nothing is lost between
// steps and none of it needs JavaScript.

type Draft = {
  op: string;
  focus: string;
  version: string;
  title: string;
  submit_label: string;
  success_message: string;
  redirect_to: string;
  notify_emails: string[];
  badEmails: string[];
  active: boolean;
  fields: Record<string, unknown>[];
};

/** What a field has that this editor does not show (things to buy, fees, the tax rate), carried through a save as it was. */
const CARRIED = ["items", "currency", "fees", "tax_rate_id"] as const;
function carried(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || "{}");
    return Object.fromEntries(CARRIED.filter((k) => v?.[k] !== undefined).map((k) => [k, v[k]]));
  } catch {
    return {};
  }
}

export function readEditor(body: Record<string, unknown>): Draft {
  const s = (k: string) => {
    const v = body[k];
    return (Array.isArray(v) ? str(v[0]) : str(v)).trim();
  };
  const n = Math.min(Number(s("count")) || 0, 100);
  let fields: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const p = `f.${i}.`;
    if (!(p + "name" in body)) continue;
    fields.push({
      name: s(p + "name"),
      label: s(p + "label"),
      type: s(p + "type"),
      required: s(p + "required") !== "",
      options: s(p + "options").split(/\r?\n/).map((o) => o.trim()).filter(Boolean),
      help: s(p + "help"),
      // Not edited here, but carried through so a save keeps what the row had.
      ...(Number(s(p + "maxLength")) > 0 ? { maxLength: Number(s(p + "maxLength")) } : {}),
      ...(s(p + "autocomplete") ? { autocomplete: s(p + "autocomplete") } : {}),
      ...(s(p + "booking_type") ? { booking_type: s(p + "booking_type") } : {}),
      ...carried(s(p + "settings")),
    });
  }
  const op = s("op") || "save";
  let focus = "fields";
  const m = /^(up|down|remove):(\d+)$/.exec(op);
  if (m) {
    const i = Number(m[2]);
    const j = m[1] === "up" ? i - 1 : i + 1;
    if (m[1] === "remove") fields = fields.filter((_, k) => k !== i);
    else if (i < fields.length && j >= 0 && j < fields.length) {
      [fields[i], fields[j]] = [fields[j], fields[i]];
      focus = `field-${j}`;
    }
  } else if (op === "add") {
    const names = new Set(fields.map((f) => f.name));
    let k = fields.length + 1;
    while (names.has(`question_${k}`)) k++;
    fields.push({ name: `question_${k}`, label: "New question", type: "text", required: false, options: [], help: "" });
    focus = `field-${fields.length - 1}`;
  }
  const emails = s("notify_emails").split(/[\s,;]+/).filter(Boolean);
  const good = emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e);
  return {
    op,
    focus,
    version: s("version"),
    title: s("title"),
    submit_label: s("submit_label"),
    success_message: s("success_message"),
    redirect_to: s("redirect_to"),
    notify_emails: [...new Set(good)],
    badEmails: emails.filter((e) => !normalizeEmail(e)),
    active: s("active") !== "",
    fields,
  };
}

const TYPE_LABELS: Record<Field["type"], string> = {
  text: "Short answer",
  email: "Email",
  tel: "Phone",
  textarea: "Long answer",
  select: "Dropdown",
  checkbox: "Tick boxes",
  radio: "One choice",
  date: "Date",
  number: "Number",
  consent: "Consent box",
  items: "Things to buy",
  page: "New page",
  booking: "Book a time",
  payment: "Payment",
};

const fieldCls = "flex flex-col gap-1 text-label text-ink-2";

function Problem({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} class="text-label font-semibold text-ink">
      {text}
    </p>
  ) : null;
}

function Editor(props: {
  base: string;
  form: Form;
  raw: Record<string, unknown>[];
  version: string;
  problems?: Errors;
  formProblems?: Errors;
  note?: string;
}) {
  const { base, form, raw, version, problems = {}, formProblems = {}, note } = props;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return (
    <form method="post" action={`${base}/form/${form.key}`} class="flex flex-col gap-6">
      <p class="text-label">
        <a href={listUrl(`${base}/submissions`, { form: form.key })}>See submissions</a>
      </p>
      {note ? (
        <p role="alert" class="rounded-card border border-line-strong bg-panel px-4 py-2">
          {note}
        </p>
      ) : null}
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="count" value={String(raw.length)} />
      {/* The first submit button is the one Enter presses: keep it Save. */}
      <div>
        <button name="op" value="save" class={buttonClass}>
          Save
        </button>
      </div>
      <Section title="The form">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class={fieldCls}>
            Title
            <input name="title" value={form.title} required class={controlClass} aria-invalid={formProblems.title ? "true" : undefined} aria-describedby={formProblems.title ? "p-title" : undefined} />
            <Problem id="p-title" text={formProblems.title} />
          </label>
          <label class={fieldCls}>
            Button text
            <input name="submit_label" value={form.submit_label ?? ""} placeholder="Send" class={controlClass} />
          </label>
          <label class={fieldCls + " sm:col-span-2"}>
            Thank-you message
            <textarea name="success_message" rows={2} class={controlClass}>
              {form.success_message ?? ""}
            </textarea>
          </label>
          <label class={fieldCls}>
            Or send people to this page instead
            <input name="redirect_to" value={form.redirect_to ?? ""} placeholder="/thank-you" class={controlClass} aria-invalid={formProblems.redirect_to ? "true" : undefined} aria-describedby={formProblems.redirect_to ? "p-redirect" : undefined} />
            <Problem id="p-redirect" text={formProblems.redirect_to} />
          </label>
          <label class={fieldCls}>
            Email each submission to
            <input name="notify_emails" value={form.notify_emails.join(", ")} placeholder="you@example.com" class={controlClass} aria-invalid={formProblems.notify_emails ? "true" : undefined} aria-describedby="p-notify-help p-notify" />
            <span id="p-notify-help">Needs an email sender connected to this app (Resend or Postmark).</span>
            <Problem id="p-notify" text={formProblems.notify_emails} />
          </label>
          <label class="flex items-center gap-2">
            <input type="checkbox" name="active" value="yes" checked={form.active} />
            Taking submissions
          </label>
        </div>
      </Section>
      <Section title="Questions">
        <p class="mb-4 text-label text-ink-2">
          A question's name is where its answers are stored. Renaming one starts a new column; earlier answers keep the old name.
        </p>
        <ol id="fields" class="flex flex-col gap-4">
          {raw.map((f, i) => {
            const pid = `p-field-${i}`;
            const type = text(f.type) as Field["type"];
            return (
              <li id={`field-${i}`}>
                <fieldset class="rounded-card border border-line p-4" aria-describedby={problems[String(i)] ? pid : undefined}>
                  <legend class="px-1 text-label font-semibold">Question {i + 1}</legend>
                  <Problem id={pid} text={problems[String(i)]} />
                  {typeof f.maxLength === "number" ? <input type="hidden" name={`f.${i}.maxLength`} value={String(f.maxLength)} /> : null}
                  {typeof f.autocomplete === "string" ? <input type="hidden" name={`f.${i}.autocomplete`} value={f.autocomplete} /> : null}
                  {CARRIED.some((k) => f[k] !== undefined) ? (
                    <input type="hidden" name={`f.${i}.settings`} value={JSON.stringify(Object.fromEntries(CARRIED.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])))} />
                  ) : null}
                  {type === "items" || type === "payment" ? (
                    <p class="mb-3 text-label text-ink-2">
                      {type === "items" ? `Sells ${Array.isArray(f.items) ? f.items.length : 0} things.` : `${Array.isArray(f.fees) ? f.fees.length : 0} fees${f.tax_rate_id ? ", taxed" : ""}.`} Ask the AI to change what it sells, its prices or fees; they are kept as they are here.
                    </p>
                  ) : null}
                  <div class="grid gap-3 sm:grid-cols-2">
                    <label class={fieldCls}>
                      Label
                      <input name={`f.${i}.label`} value={text(f.label)} class={controlClass} />
                    </label>
                    <label class={fieldCls}>
                      Name
                      <input name={`f.${i}.name`} value={text(f.name)} pattern="[a-z][a-z0-9_]*" class={controlClass} />
                    </label>
                    <label class={fieldCls}>
                      Type
                      <select name={`f.${i}.type`} class={controlClass}>
                        {FIELD_TYPES.map((t) => (
                          <option value={t} selected={t === type}>
                            {TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label class="flex items-center gap-2 self-end">
                      <input type="checkbox" name={`f.${i}.required`} value="yes" checked={f.required === true} />
                      Required
                    </label>
                    <label class={fieldCls}>
                      Options, one per line (dropdown, one choice, tick boxes)
                      <textarea name={`f.${i}.options`} rows={3} class={controlClass}>
                        {Array.isArray(f.options) ? f.options.join("\n") : ""}
                      </textarea>
                    </label>
                    <label class={fieldCls}>
                      Help text
                      <input name={`f.${i}.help`} value={text(f.help)} class={controlClass} />
                    </label>
                    {type === "booking" ? (
                      <label class={fieldCls}>
                        Booking type (its page address, like intake)
                        <input name={`f.${i}.booking_type`} value={text(f.booking_type)} pattern="[a-z0-9-]+" class={controlClass} />
                      </label>
                    ) : null}
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    {i > 0 ? (
                      <button name="op" value={`up:${i}`} class={buttonClass} aria-label={`Move question ${i + 1} up`}>
                        Move up
                      </button>
                    ) : null}
                    {i < raw.length - 1 ? (
                      <button name="op" value={`down:${i}`} class={buttonClass} aria-label={`Move question ${i + 1} down`}>
                        Move down
                      </button>
                    ) : null}
                    <button name="op" value={`remove:${i}`} class={buttonClass} aria-label={`Remove question ${i + 1}`}>
                      Remove
                    </button>
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ol>
        <div class="mt-4 flex flex-wrap gap-2">
          <button name="op" value="add" class={buttonClass}>
            Add a question
          </button>
          <button name="op" value="save" class={buttonClass}>
            Save
          </button>
        </div>
      </Section>
    </form>
  );
}

function NewForm({ action, key_ = "", title = "", errors = {} }: { action: string; key_?: string; title?: string; errors?: Errors }) {
  // The hint and any problem sit under the row, so the two fields and the
  // button line up whatever each one has to say.
  return (
    <form method="post" action={action} class="mt-6">
      <div class="flex flex-wrap items-end gap-3">
        <label class={fieldCls}>
          New form title
          <input name="title" value={title} required class={controlClass} aria-invalid={errors.title ? "true" : undefined} aria-describedby={errors.title ? "new-title-p" : undefined} />
        </label>
        <label class={fieldCls}>
          Key
          <input name="key" value={key_} required pattern="[a-z0-9][a-z0-9\-]*" placeholder="quote-request" class={controlClass} aria-invalid={errors.key ? "true" : undefined} aria-describedby="new-key-help new-key-p" />
        </label>
        <button class={buttonClass}>Create the form</button>
      </div>
      <p id="new-key-help" class="mt-1 text-label text-ink-2">The key is used in the form's address. It cannot be changed later.</p>
      <Problem id="new-title-p" text={errors.title} />
      <Problem id="new-key-p" text={errors.key} />
    </form>
  );
}
