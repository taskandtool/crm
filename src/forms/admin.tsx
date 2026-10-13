// The private side of forms. formsAdmin is what came in: one list of
// submissions from every form and the booking page, in three tabs (Inbox,
// Archived, Spam) with a form picker and a search; one submission's page with
// its answers, its booking (reschedule, cancel), its payment (refund) and the
// person's notes. formEditor is for an app that lets the team set forms up
// (the CRM): the forms, the editor, a CSV export, and who stopped part way.
// teamOnly is applied to both, so a mount that forgets it still answers 404.
//
//   app.route("/admin/submissions", formsAdmin(getDb, {
//     base: "/admin/submissions", css: "/site.css", timeZone: "America/Chicago",
//     links: { booking: (id) => `/admin/schedule/${id}`, payment: (id) => `/admin/payments/${id}` } }));
//
// Statuses: new and read are the Inbox (read once opened), done is Archived.
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import type { Db, GetDb } from "../data/db";
import { normalizeEmail } from "../data/email";
import { envOf, setting } from "../data/env";
import { senderOf } from "../data/send";
import { FieldList, JsonData, Section } from "../admin/detail";
import { csvResponse, type CsvColumn } from "../admin/csv";
import { alertClass, Flash, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { cut, everyPage, readCursor, type Cursor, type Keyed } from "../admin/keyset";
import { SectionPage, SectionTabs, type Frame, type Head, type NavItem } from "../admin/layout";
import { DataTable, EmptyCard, rowClick, rowLink, SearchBar, TableRows, When, type TableSpec } from "../admin/list";
import { formIds, idParam, isPartial, likePattern, listUrl, localPath, str } from "../admin/query";
import { buttonClass, controlClass, fieldClass, inputClass, pickStatus, primaryClass, Select, smallText, StatusBadge, type StatusOption } from "../admin/status";
import { customerByEmail, customerFor } from "../customers/customer";
import { addNote, listNotes, NOTE_KINDS, NOTE_LABELS, pickNoteKind, wallTime, type Note } from "../customers/notes";
import { checkFields, FIELD_TYPES, FORM_KEY, formKeyFrom, PHOTO_PATH, sitePath, type Errors, type Field, type Form } from "./fields";
import { cameFrom } from "./origin";
import { linkedTo, linkKinds, type Linked } from "./linked";
import { priceOf } from "./price";
import { formatMoney } from "../payments/money";
import { refundable, type Payment } from "../payments/admin";
import { BOOKING_STATUSES } from "../booking/admin";
import { BOOKING_PAGE, CONTACT_FORM, toForm } from "./store";

export type FormsAdminOptions = {
  base: string;
  css: string;
  timeZone: string;
  nav?: NavItem[];
  pageSize?: number;
  /** The app's own page frame (the CRM's layout and nav) instead of AdminLayout. */
  Frame?: Frame;
  /** A booking's address where bookingAdmin is mounted (`/admin/schedule/42`: its Reschedule and Cancel) and a payment's where paymentsAdmin is. */
  links?: { booking?: (id: string) => string; payment?: (id: string) => string };
};


export const STATUSES: StatusOption[] = [
  { value: "new", label: "New", tone: "accent" },
  { value: "read", label: "Inbox", tone: "strong" },
  { value: "done", label: "Archived", tone: "neutral" },
  { value: "spam", label: "Spam", tone: "muted" },
];

/** The three tabs: which statuses each shows. */
type View = "inbox" | "archived" | "spam";
const VIEWS: Record<View, { path: string; label: string; statuses: string[]; empty: string }> = {
  inbox: { path: "", label: "Inbox", statuses: ["new", "read"], empty: "Nothing here yet. What people send from your site's forms and booking page shows up here." },
  archived: { path: "/archived", label: "Archived", statuses: ["done"], empty: "Nothing archived." },
  spam: { path: "/spam", label: "Spam", statuses: ["spam"], empty: "No spam." },
};
const viewOf = (status: string): View => (status === "done" ? "archived" : status === "spam" ? "spam" : "inbox");

const MESSAGES: FlashMessages = {
  done: "Archived.",
  read: "Moved to the Inbox.",
  spam: "Marked as spam.",
  bulk: (n) => (n === 1 ? "Moved 1 submission." : `Moved ${n} submissions.`),
  "none-selected": { error: "Select at least one submission first." },
  booked: "Booked. They are sent a confirmation if email is on.",
  cancelled: "Booking cancelled. They have been told.",
  rescheduled: "Booking moved. They have been told the new time.",
  unchanged: { error: "The booking was not changed. A cancelled or past booking cannot be moved." },
  refund: "Refund requested. The payment changes when Stripe confirms it, usually within a minute.",
  note: "Added to their notes.",
  "note-empty": { error: "Write something in the note first." },
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
  /** Its booking and payment (linked.ts). */
  linked?: Linked;
};
type Filter = { q: string | null; form: string | null };

function readFilter(c: Context): Filter {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const form = c.req.query("form") ?? "";
  return { q: q || null, form: FORM_KEY.test(form) ? form : null };
}

/** One page plus one row of a tab, newest first. `data` only when asked (the export). */
function listPage(db: Db, statuses: string[], f: Filter, after: Cursor | null, size: number, withData = false): Promise<Item[]> {
  const pat = likePattern(f.q);
  return db.sql<Item>`
    select id::text as id, form_key, name, email::text as email, phone, status, page, source, created_at, completed_at,
           updated_by::text as updated_by, created_at::text as k, case when ${withData} then data end as data
    from submissions s
    where s.status = any(${statuses}::text[])
      and (${f.form}::text is null or s.form_key = ${f.form})
      and (${pat}::text is null or s.name ilike ${pat} or s.email::text ilike ${pat})
      and (${after?.k ?? null}::timestamptz is null
           or (s.created_at, s.id) < (${after?.k ?? null}::timestamptz, ${after?.id ?? null}::bigint))
    order by s.created_at desc, s.id desc
    limit ${size + 1}`;
}

type FormInfo = { key: string; title: string; notify_emails: string[]; active: boolean };

/** Every form, and every key that has submissions without a form row (the booking page), by name. */
async function formsAndKeys(db: Db): Promise<{ forms: FormInfo[]; titles: Map<string, string>; fresh: number }> {
  const [forms, keys] = await Promise.all([
    db.sql<FormInfo>`select key, title, notify_emails::text[] as notify_emails, active from forms order by title, key`,
    db.sql<{ form_key: string; fresh: number }>`
      select form_key, count(*) filter (where status = 'new')::int as fresh from submissions group by form_key order by form_key`,
  ]);
  const titles = new Map(forms.map((f) => [f.key, f.title]));
  for (const k of keys) if (!titles.has(k.form_key)) titles.set(k.form_key, k.form_key === BOOKING_PAGE.key ? BOOKING_PAGE.title : k.form_key);
  return { forms, titles, fresh: keys.reduce((n, k) => n + k.fresh, 0) };
}

/** How the team hears of a new submission, in one line, and what to ask the AI when it is nobody. */
function EmailNote({ c, forms }: { c: Context; forms: FormInfo[] }) {
  const env = envOf(c);
  const sender = senderOf(env);
  const to = [...new Set(forms.filter((f) => f.active).flatMap((f) => f.notify_emails))];
  if (typeof sender === "string" || !setting(env, "NOTIFY_FROM")) {
    return (
      <p class="mb-4 rounded-card border border-line bg-panel/60 px-4 py-3 text-copy text-ink">
        <strong>Email is off.</strong> No email sender is connected, so nobody is emailed about new submissions and customers get no
        booking confirmations. Ask the AI to connect one to turn it on.
      </p>
    );
  }
  const text = to.length
    ? `New form submissions are emailed to ${to.join(", ")}.`
    : "Nobody is emailed about new submissions. Ask the AI to email them to you.";
  return <p class={`mb-4 ${smallText} text-ink-2`}>{text}</p>;
}

/** The note under every list: what is changed by asking, not here. */
const AskNote = () => (
  <p class={`mt-6 max-w-prose ${smallText} text-ink-3`}>
    To add a form, change its questions or prices, or choose who is emailed, ask the AI in Task &amp; Tool.
  </p>
);

/**
 * Whether the forms listed (one, or every form) can lead to a booking or a
 * payment: a booking step, or a payment or products step, on a form whose
 * table is here. What the submissions list gives a column to.
 */
async function leadsTo(db: Db, form: string | null): Promise<{ bookings: boolean; payments: boolean }> {
  const [has, forms] = await Promise.all([
    linkKinds(db),
    db.sql<{ fields: { type?: string }[] }>`select fields from forms where ${form}::text is null or key = ${form}::text`,
  ]);
  const types = new Set(forms.flatMap((f) => (Array.isArray(f.fields) ? f.fields.map((x) => x.type) : [])));
  return { bookings: has.bookings && types.has("booking"), payments: has.payments && (types.has("payment") || types.has("items")) };
}

export function formsAdmin(getDb: GetDb, opts: FormsAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const size = opts.pageSize ?? 50;
  const nav = opts.nav ?? [{ href: base || "/", label: "Submissions" }];
  const tz = opts.timeZone;
  const who = (r: Item) => r.name || r.email || `Submission ${r.id}`;
  const subUrl = (id: string) => `${base}/${id}`;
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  const page = (c: Context<{ Variables: TeamVars }>, title: string, body: Child, head: Omit<Head, "title"> = {}) => (
    <SectionPage Frame={opts.Frame} css={opts.css} user={c.get("user")} label="Submissions" links={nav} current={base || "/"} head={{ title, ...head }}>
      <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
      {body}
    </SectionPage>
  );

  // ---- the list ----------------------------------------------------------

  // Booking and Payment are columns only where a listed form can lead to one (leadsTo).
  const spec = (view: View, showForm: boolean, titles: Map<string, string>, has: { bookings: boolean; payments: boolean }): TableSpec<Item> => ({
    id: "subs",
    href: (r) => subUrl(r.id),
    select: { form: "bulk", label: who },
    columns: [
      {
        label: "From",
        cell: (r) => (
          <>
            {view === "inbox" && r.status === "new" ? <span class="mr-2"><StatusBadge value="new" options={STATUSES} /></span> : null}
            <span class={r.status === "new" ? "font-semibold" : ""}>{who(r)}</span>
            {r.name && r.email ? <span class={`block break-all ${smallText} text-ink-2`}>{r.email}</span> : null}
            {r.completed_at ? null : <span class={`block ${smallText} text-ink-2`}>Not finished</span>}
          </>
        ),
      },
      ...(showForm ? [{ label: "Form", cell: (r: Item) => titles.get(r.form_key) ?? r.form_key, class: "hidden sm:table-cell" }] : []),
      ...(has.bookings ? [{
        label: "Booking",
        class: "hidden md:table-cell",
        cell: (r: Item) => (r.linked?.booking ? <>{r.linked.booking.status === "cancelled" ? "Cancelled: " : ""}<When at={r.linked.booking.starts_at} timeZone={tz} /></> : ""),
      }] : []),
      ...(has.payments ? [{ label: "Payment", class: "hidden md:table-cell", cell: (r: Item) => r.linked?.payment?.label ?? "" }] : []),
      { label: "Received", cell: (r) => <When at={r.created_at} timeZone={tz} /> },
    ],
  });

  /** What the selected rows can be moved to from this tab. */
  const MOVES: Record<View, { status: string; label: string }[]> = {
    inbox: [{ status: "done", label: "Archive" }, { status: "spam", label: "Mark as spam" }],
    archived: [{ status: "read", label: "Move to Inbox" }],
    spam: [{ status: "read", label: "Not spam" }],
  };

  const list = (view: View) => async (c: Context<{ Variables: TeamVars }>) => {
    const db = getDb(c);
    const v = VIEWS[view];
    const here = base + v.path || "/";
    const f = readFilter(c);
    const after = readCursor(c.req.query("after"));
    const { page: rows, next } = cut(await listPage(db, v.statuses, f, after, size), size);
    const linked = await linkedTo(db, rows.map((r) => r.id));
    const withLinks = rows.map((r) => ({ ...r, linked: linked.get(r.id) }));
    const { forms, titles, fresh } = await formsAndKeys(db);
    const self = listUrl(here, { q: f.q, form: f.form });
    const more = (cur: string) => listUrl(here, { q: f.q, form: f.form, after: cur });
    const s = spec(view, !f.form, titles, await leadsTo(db, f.form));
    if (isPartial(c) && after) return c.html(<TableRows spec={s} rows={withLinks} next={next} more={more} />);

    const results = (
      <div id="results">
        <form id="bulk" method="post" action={`${base}/bulk`} aria-label="Move selected" class="mb-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="return" value={self} />
          <span class="text-label text-ink-2">Selected:</span>
          {MOVES[view].map((m) => (
            <button name="status" value={m.status} class={buttonClass}>{m.label}</button>
          ))}
        </form>
        {after ? <p class="mb-3 text-label"><a href={self}>Back to the newest</a></p> : null}
        <DataTable
          spec={s}
          caption={`${v.label}, newest first`}
          rows={withLinks}
          next={next}
          more={more}
          empty={f.q || f.form ? <>Nothing matches. <a href={here}>Show everything</a></> : v.empty}
        />
      </div>
    );
    if (isPartial(c)) return c.html(results);
    const tabs = (Object.keys(VIEWS) as View[]).map((k) => ({
      href: base + VIEWS[k].path || "/",
      label: k === "inbox" && fresh ? `Inbox (${fresh} new)` : VIEWS[k].label,
    }));
    return c.html(
      page(
        c,
        "Submissions",
        <>
          <SectionTabs label="Submissions" links={tabs} current={here} />
          <EmailNote c={c} forms={forms} />
          <SearchBar
            action={here}
            target="#results"
            q={f.q}
            placeholder="Name or email"
            filters={[{ name: "form", label: "Form", options: [...titles].map(([value, label]) => ({ value, label })), value: f.form, any: "All forms" }]}
          />
          {results}
          <AskNote />
        </>,
      ),
    );
  };

  for (const view of Object.keys(VIEWS) as View[]) app.get(VIEWS[view].path || "/", list(view));

  app.post("/bulk", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const ret = localPath(str(body.return), base, base || "/");
    const status = pickStatus(body.status, STATUSES);
    const ids = formIds(body.id);
    if (!ids.length || !status) return c.redirect(withFlash(ret, "none-selected"), 303);
    const changed = await getDb(c).sql`
      update submissions
      set status = ${status}, updated_at = now(), updated_by = ${c.get("user")}
      where id = any(${ids}::bigint[]) and status <> ${status}
      returning id`;
    return c.redirect(withFlash(ret, "bulk", changed.length), 303);
  });

  // ---- one submission ----------------------------------------------------

  app.get("/:id{[0-9]+}", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const db = getDb(c);
    // Opening a new one reads it: it stays in the Inbox, no longer marked new.
    const [r] = await db.sql<Item & { updated_at: Date }>`
      with opened as (update submissions set status = 'read' where id = ${id}::bigint and status = 'new' returning id)
      select id::text as id, form_key, name, email::text as email, phone,
             case when exists (select 1 from opened) then 'read' else status end as status,
             page, source, created_at, completed_at, updated_by::text as updated_by, updated_at, created_at::text as k, data
      from submissions where id = ${id}::bigint`;
    if (!r) return c.notFound();
    const [formRow] = await db.sql`
      select key, title, fields, notify_emails::text[] as notify_emails, redirect_to, success_message, submit_label, active
      from forms where key = ${r.form_key}`;
    const form = formRow ? toForm(formRow) : null;
    const formTitle = form?.title ?? (r.form_key === BOOKING_PAGE.key ? BOOKING_PAGE.title : r.form_key);
    const data = { ...(r.data ?? {}) };
    // The person is on the Contact card, not repeated as answers.
    for (const k of ["name", "email", "phone"] as const) if (r[k]) delete data[k];
    let price: ReturnType<typeof priceOf> = null;
    try {
      price = form ? priceOf(form, r.data ?? {}) : null;
    } catch {
      price = null; // amounts in two currencies: shown as answers only
    }
    const answers = (form?.fields ?? [])
      .filter((x) => Object.hasOwn(data, x.name))
      .flatMap((x) => {
        const v = data[x.name];
        delete data[x.name];
        if (x.type === "items") {
          // An order ({ slug: quantity }) is the Order section when it prices.
          if (price) return [];
          const counts = v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, n]) => `${n} x ${k}`) : [];
          return [{ label: x.label, value: counts.join(", ") }];
        }
        if (x.type === "photo" && typeof v === "string" && PHOTO_PATH.test(v)) {
          return [{ label: x.label, value: <a href={v}><img src={v} alt={x.label} class="max-h-64 w-auto rounded-control" /></a> }];
        }
        return [{ label: x.label, value: Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : (v as Child) }];
      });
    const consent = data._consent as Record<string, string> | undefined;
    const from = cameFrom(data);
    for (const k of ["_consent", "_utm", "_referrer", "_charges", "_lines"]) delete data[k];
    // A booking page's submission: the Booking card shows the service and who; their notes are its one answer.
    if (r.form_key === BOOKING_PAGE.key && !form) {
      const notes = data.notes;
      for (const k of ["service", "with", "notes"]) delete data[k];
      if (typeof notes === "string" && notes) answers.push({ label: "Notes", value: notes });
    }
    const linked = (await linkedTo(db, [r.id])).get(r.id)!;
    const booking = linked.booking ? await bookingOf(db, linked.booking.id) : null;
    const payment = linked.payment ? await paymentOf(db, linked.payment.id) : null;
    // Notes are the CRM's: on the customer with this email, once there is one.
    const customer = r.email ? await customerByEmail(db, r.email) : null;
    const notes = customer ? await listNotes(db, customer.id) : [];

    const self = subUrl(r.id);
    const view = viewOf(r.status);
    const move = (status: string, label: string, primary = false) => (
      <form method="post" action={`${self}/status`}>
        <input type="hidden" name="status" value={status} />
        <button class={primary ? primaryClass : buttonClass}>{label}</button>
      </form>
    );
    const actions =
      view === "inbox" ? <>{move("done", "Archive", true)}{move("spam", "Mark as spam")}</>
      : view === "archived" ? <>{move("read", "Move to Inbox")}{move("spam", "Mark as spam")}</>
      : move("read", "Not spam");
    const head = {
      back: { href: base + VIEWS[view].path || "/", label: view === "inbox" ? "Submissions" : VIEWS[view].label },
      sub: (
        <p>
          {formTitle} · <When at={r.created_at} timeZone={tz} />
          {view === "inbox" ? null : <> · <StatusBadge value={r.status} options={STATUSES} /></>}
        </p>
      ),
      actions,
    };

    return c.html(
      page(
        c,
        who(r),
        <>
          <div class="grid gap-4 md:grid-cols-3">
            <div class="flex flex-col gap-4 md:col-span-2">
              <Section title="Contact">
                <FieldList
                  fields={[
                    { label: "Name", value: r.name },
                    { label: "Email", value: r.email ? <a href={`mailto:${r.email}`} class="break-all">{r.email}</a> : null },
                    { label: "Phone", value: r.phone ? <a href={`tel:${r.phone.replace(/[^0-9+]/g, "")}`}>{r.phone}</a> : null },
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
              {answers.length || Object.keys(data).length ? (
                <Section title="Answers">
                  {answers.length ? <FieldList fields={answers} /> : null}
                  {Object.keys(data).length ? <JsonData data={data} /> : null}
                </Section>
              ) : null}
              {consent && Object.keys(consent).length ? (
                <Section title="Agreed to">
                  <ul class="list-disc pl-5">
                    {Object.values(consent).map((t) => (
                      <li>{t}</li>
                    ))}
                  </ul>
                </Section>
              ) : null}
              {r.email ? <NotesCard action={`${self}/notes`} email={r.email} notes={notes} timeZone={tz} /> : null}
            </div>
            <div class="flex flex-col gap-4">
              {booking ? <BookingCard b={booking} held={linked.booking!.held && !linked.payment?.label.startsWith("Paid")} timeZone={tz} at={opts.links?.booking} /> : null}
              {payment ? <PaymentCard p={payment} label={linked.payment!.label} at={opts.links?.payment} /> : null}
              {r.completed_at ? null : (
                <Section title="Not finished">
                  <p class="text-ink-2">They answered the questions but have not finished booking or paying yet. It completes on its own when they do.</p>
                </Section>
              )}
              <Section title="Where it came from">
                <FieldList
                  fields={[
                    { label: "Form", value: formTitle },
                    { label: "Page", value: r.page },
                    { label: "Found you through", value: from },
                    { label: "Last changed by", value: r.updated_by ? <>{r.updated_by}, <When at={r.updated_at} timeZone={tz} /></> : null },
                  ]}
                />
              </Section>
            </div>
          </div>
        </>,
        head,
      ),
    );
  });

  // A note is about the person: it goes on their customer (the CRM's tables), made from this submission the first time.
  app.post("/:id{[0-9]+}/notes", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const text = str(body.body);
    if (!text.trim()) return c.redirect(withFlash(subUrl(id), "note-empty"), 303);
    const db = getDb(c);
    const [sub] = await db.sql<{ email: string; name: string | null; phone: string | null; created_at: Date; source: string }>`
      select s.email::text as email, s.name, s.phone, s.created_at, coalesce(f.title, case when s.form_key = ${BOOKING_PAGE.key} then ${BOOKING_PAGE.title} end, s.form_key) as source
      from submissions s left join forms f on f.key = s.form_key
      where s.id = ${id}::bigint and s.email is not null`;
    if (!sub) return c.notFound();
    const customer = await customerFor(db, sub, c.get("user"));
    await addNote(db, customer.id, { kind: pickNoteKind(body.kind) ?? "note", body: text, at: wallTime(body.at), timeZone: tz }, c.get("user"));
    return c.redirect(withFlash(subUrl(id), "note"), 303);
  });

  app.post("/:id{[0-9]+}/status", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.notFound();
    const status = pickStatus((await c.req.parseBody()).status, STATUSES);
    if (!status) return c.text("Choose one of the listed statuses.", 400);
    const [row] = await getDb(c).sql`
      update submissions set status = ${status}, updated_at = now(), updated_by = ${c.get("user")}
      where id = ${id}::bigint returning id`;
    if (!row) return c.notFound();
    // Archiving or marking spam is done with it: back to the list it left. Back to the Inbox stays on it.
    return c.redirect(withFlash(status === "read" ? subUrl(id) : base || "/", status), 303);
  });

  return app;
}

// ---- a submission's booking, payment and the notes on its person ----------

/**
 * The person's notes: the CRM's timeline box (a note, or a call, email,
 * meeting or text, now or at another time) and what is logged, newest first.
 */
function NotesCard({ action, email, notes, timeZone }: { action: string; email: string; notes: Note[]; timeZone: string }) {
  return (
    <Section title="Notes">
      <p class={`mb-4 ${smallText} text-ink-3`}>About {email}: on every submission from them, and on their customer page in the CRM.</p>
      <form method="post" action={action} aria-label="Log activity" class="flex flex-col gap-2">
        <textarea name="body" rows={2} required maxlength={10000} placeholder="Add a note, or log a call" aria-label="Note" class={inputClass}></textarea>
        <div class="flex flex-wrap items-center gap-2">
          <Select name="kind" aria-label="Type" class="w-32">
            {NOTE_KINDS.map((k) => (
              <option value={k}>{NOTE_LABELS[k]}</option>
            ))}
          </Select>
          <button class={buttonClass}>Log activity</button>
          {/* Now, unless it happened earlier: the time is there when it is needed. */}
          <details class="open:basis-full">
            <summary class="w-fit cursor-pointer list-none px-1 text-sm/6 font-semibold text-ink-2 no-underline hover:text-ink">Another time</summary>
            <input name="at" type="datetime-local" aria-label="When it happened" class={inputClass + " mt-2"} />
          </details>
        </div>
      </form>
      {notes.length ? (
        <ol class="mt-6 flex flex-col gap-4">
          {notes.map((n) => (
            <li class="border-l-2 border-line pl-3">
              <p class={`${smallText} text-ink-3`}>
                <span class="font-semibold text-ink-2">{NOTE_LABELS[n.kind] ?? n.kind}</span> · <When at={n.happened_at} timeZone={timeZone} />
                {n.author ? ` · ${n.author}` : ""}
              </p>
              <p class="mt-0.5 whitespace-pre-wrap break-words">{n.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  );
}

type BookingRow = {
  id: string; status: string; starts_at: Date; ends_at: Date; service: string | null; host: string | null; location_kind: string; location: string | null;
};

async function bookingOf(db: Db, id: string): Promise<BookingRow | null> {
  const [b] = await db.sql<BookingRow>`
    select b.id::text as id, b.status, b.starts_at, b.ends_at, t.name as service, r.name as host, b.location_kind, b.location
    from bookings b left join booking_types t on t.id = b.type_id left join resources r on r.id = b.resource_id
    where b.id = ${id}::bigint`;
  return b ?? null;
}

async function paymentOf(db: Db, id: string): Promise<Payment | null> {
  const [p] = await db.sql<Payment>`select p.*, p.id::text as id from payments p where p.id = ${id}::bigint`;
  return p ?? null;
}

function BookingCard({ b, held, timeZone, at }: { b: BookingRow; held: boolean; timeZone: string; at?: (id: string) => string }) {
  const upcoming = b.status === "confirmed" && new Date(b.starts_at) > new Date();
  const base = at?.(b.id);
  return (
    <Section title="Booking">
      <p class="font-semibold"><When at={b.starts_at} timeZone={timeZone} /></p>
      <p class="text-ink-2">{[b.service, b.host ? `with ${b.host}` : null].filter(Boolean).join(" ")}</p>
      <p class="mt-1 text-label text-ink-2">{held ? "Held until it is paid" : BOOKING_STATUSES.find((o) => o.value === b.status)?.label ?? b.status}</p>
      {upcoming && base ? (
        <div class="mt-3 flex flex-wrap gap-2">
          <a href={`${base}/reschedule`} class={buttonClass}>Reschedule</a>
          <form method="post" action={`${base}/status`} onsubmit={`return confirm(${JSON.stringify("Cancel this booking? They are told, and it cannot be undone.")})`}>
            <input type="hidden" name="status" value="cancelled" />
            <button class={buttonClass}>Cancel booking</button>
          </form>
        </div>
      ) : null}
    </Section>
  );
}

function PaymentCard({ p, label, at }: { p: Payment; label: string; at?: (id: string) => string }) {
  const base = at?.(p.id);
  return (
    <Section title="Payment">
      <p>{base ? <a href={base}>{label}</a> : label}</p>
      {refundable(p) && base ? (
        <p class="mt-3">
          <a href={`${base}/refund`} class={buttonClass}>Refund…</a>
        </p>
      ) : null}
    </Section>
  );
}

/**
 * Setting forms up, for an app that offers it (the CRM): every form and what
 * is new on it, a new form, the editor, a CSV export of a form's submissions,
 * and who stopped part way. `submissions` is where formsAdmin is mounted.
 */
export function formEditor(getDb: GetDb, opts: { base: string; css: string; timeZone: string; source: string; submissions: string; nav?: NavItem[]; Frame?: Frame }) {
  const base = opts.base.replace(/\/+$/, "");
  const subs = opts.submissions;
  const nav = opts.nav ?? [{ href: base, label: "Forms" }, { href: subs, label: "Submissions" }];
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  /** A page: a title, or a whole head (a record's page has `back`, so the tabs give way to the way back). */
  const layout = (c: Context<{ Variables: TeamVars }>, head: string | Head, current: string, body: Child) => (
    <SectionPage Frame={opts.Frame} css={opts.css} user={c.get("user")} label="Forms" links={nav} current={current}
      head={typeof head === "string" ? { title: head } : head}>
      <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={EDITOR_MESSAGES} />
      {body}
    </SectionPage>
  );

  // ---- forms -------------------------------------------------------------

  /** A form's page: back to the forms, its submissions one click away. */
  const editorHead = (form: Form): Head => ({
    title: form.title,
    back: { href: base, label: "Forms" },
    sub: form.active ? null : <StatusBadge value="off" options={FORM_STATES} />,
    actions: (
      <>
        <a href={listUrl(subs, { form: form.key })} class={buttonClass}>Submissions</a>
        <a href={listUrl(`${base}/export.csv`, { form: form.key })} class={buttonClass}>Export CSV</a>
      </>
    ),
  });

  // As Google Forms and HubSpot list them: each form, whether it is taking
  // submissions, what is new, how many in all and when the last one came.
  const formsPage = async (c: Context<{ Variables: TeamVars }>, newForm: Child) => {
    const forms = await allForms(getDb(c));
    return layout(
        c,
        { title: "Forms", actions: newForm },
        base,
        forms.length ? (
          <div class="overflow-x-auto rounded-card border border-line bg-surface">
            <table class="w-full border-collapse text-copy">
              <caption class="sr-only">Forms</caption>
              <thead>
                <tr class="border-b border-line-strong text-left text-label text-ink-3">
                  <th scope="col" class="px-4 py-2 font-semibold">Form</th>
                  <th scope="col" class="px-4 py-2 font-semibold">New</th>
                  <th scope="col" class="px-4 py-2 font-semibold">Submissions</th>
                  <th scope="col" class="hidden px-4 py-2 font-semibold sm:table-cell">Last one</th>
                </tr>
              </thead>
              <tbody>
                {forms.map((f) => (
                  <tr class="cursor-pointer border-b border-line last:border-b-0 hover:bg-canvas" {...rowClick(`${base}/form/${f.key}`)}>
                    <td class="px-4 py-3">
                      <a href={`${base}/form/${f.key}`} class={rowLink}>
                        {f.title}
                      </a>
                      {f.active ? null : <span class="ml-2"><StatusBadge value="off" options={FORM_STATES} /></span>}
                    </td>
                    <td class="px-4 py-3">
                      {f.new_count ? <a href={listUrl(subs, { form: f.key })} class="font-semibold">{f.new_count}</a> : <span class="text-ink-3">0</span>}
                    </td>
                    <td class="px-4 py-3">
                      {f.total ? <a href={listUrl(subs, { form: f.key })}>{f.total}</a> : <span class="text-ink-3">0</span>}
                    </td>
                    <td class="hidden px-4 py-3 text-ink-2 sm:table-cell">{f.last_at ? <When at={f.last_at} timeZone={opts.timeZone} /> : "None yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyCard title="No forms yet.">A form is how people ask for something on your website: a quote, a booking, a question. Make one with New form.</EmptyCard>
        ),
    );
  };

  const newForm = (f: { title?: string; errors?: Errors; open?: boolean } = {}) => (
    <>
      <a href={`${base}/unfinished`} class={buttonClass}>Not finished</a>
      <NewForm action={base} {...f} />
    </>
  );

  app.get("/", async (c) => c.html(await formsPage(c, newForm())));

  // A title is all a new form needs; its key (its address) is made from it,
  // numbered when taken. A key given (the AI, a script) is used as given.
  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const given = str(body.key).trim().toLowerCase();
    const title = str(body.title).trim();
    const errors: Errors = {};
    if (given && !FORM_KEY.test(given)) errors.key = "Use lowercase letters, digits and hyphens, like contact or quote-request.";
    if (!title) errors.title = "Give the form a title.";
    if (!errors.key && !errors.title) {
      const db = getDb(c);
      const stem = given || formKeyFrom(title);
      for (let n = 1; n <= (given ? 1 : 20); n++) {
        const key = n === 1 ? stem : `${stem}-${n}`;
        const made = await db.sql`
          insert into forms (key, title, fields, source, updated_by)
          values (${key}, ${title}, ${JSON.stringify(CONTACT_FORM.fields)}::jsonb, ${opts.source}, ${c.get("user")})
          on conflict (key) do nothing
          returning key`;
        if (made.length) return c.redirect(withFlash(`${base}/form/${key}`, "created"), 303);
      }
      errors.key = given ? "A form with this key exists already. Choose another." : "There are many forms with this title already. Choose another.";
    }
    return c.html(await formsPage(c, newForm({ title, errors, open: true })), 422);
  });

  app.get("/form/:key", async (c) => {
    const found = await formRow(getDb(c), c.req.param("key"));
    if (!found) return c.notFound();
    return c.html(layout(c, editorHead(found.form), base, <Editor base={base} form={found.form} raw={found.raw} version={found.version} />));
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
          editorHead(found.form),
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

  app.get("/export.csv", async (c) => {
    const db = getDb(c);
    const f = readFilter(c);
    const form = f.form ? (await formRow(db, f.form))?.form : null;
    const statuses = ["new", "read", "done"];
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
    return csvResponse(`${f.form ?? "submissions"}-${day}.csv`, columns, everyPage((after, size) => listPage(db, statuses, f, after, size, true)));
  });

  // Forms with steps that someone started and has not finished (store.ts drafts): the newest 200.
  app.get("/unfinished", async (c) => {
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
        base,
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

  return app;
}

/** A form switched off shows so in the list; one taking submissions needs no word. */
const FORM_STATES: StatusOption[] = [{ value: "off", label: "Switched off", tone: "muted" }];

const EDITOR_MESSAGES: FlashMessages = {
  saved: "Form saved.",
  created: "Form created. Add its questions below.",
};

async function allForms(db: Db) {
  return db.sql<{ key: string; title: string; active: boolean; new_count: number; total: number; last_at: Date | null }>`
    select f.key, f.title, f.active,
           (select count(*) from submissions s where s.form_key = f.key and s.status = 'new')::int as new_count,
           (select count(*) from submissions s where s.form_key = f.key and s.status <> 'spam')::int as total,
           (select max(created_at) from submissions s where s.form_key = f.key and s.status <> 'spam') as last_at
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
  textarea: "Paragraph",
  select: "Dropdown",
  checkbox: "Checkboxes",
  radio: "Multiple choice",
  date: "Date",
  number: "Number",
  consent: "Consent checkbox",
  items: "Products",
  photo: "Photo upload",
  page: "Page break",
  booking: "Appointment",
  payment: "Payment",
};


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
      {note ? (
        <p role="alert" class={alertClass}>
          {note}
        </p>
      ) : null}
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="count" value={String(raw.length)} />
      {/* The first submit button is the one Enter presses: a Save the eye never sees, so Enter saves; the visible one is at the foot. */}
      <button name="op" value="save" class="sr-only" tabindex={-1} aria-hidden="true">
        Save
      </button>
      <Section title="The form">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class={fieldClass}>
            Title
            <input name="title" value={form.title} required class={controlClass} aria-invalid={formProblems.title ? "true" : undefined} aria-describedby={formProblems.title ? "p-title" : undefined} />
            <Problem id="p-title" text={formProblems.title} />
          </label>
          <label class={fieldClass}>
            Button text
            <input name="submit_label" value={form.submit_label ?? ""} placeholder="Send" class={controlClass} />
          </label>
          <label class={fieldClass + " sm:col-span-2"}>
            Thank-you message
            <textarea name="success_message" rows={2} class={controlClass}>
              {form.success_message ?? ""}
            </textarea>
          </label>
          <label class={fieldClass}>
            Or send people to this page instead
            <input name="redirect_to" value={form.redirect_to ?? ""} placeholder="/thank-you" class={controlClass} aria-invalid={formProblems.redirect_to ? "true" : undefined} aria-describedby={formProblems.redirect_to ? "p-redirect" : undefined} />
            <Problem id="p-redirect" text={formProblems.redirect_to} />
          </label>
          <label class={fieldClass}>
            Email each submission to
            <input name="notify_emails" value={form.notify_emails.join(", ")} placeholder="you@example.com" class={controlClass} aria-invalid={formProblems.notify_emails ? "true" : undefined} aria-describedby="p-notify-help p-notify" />
            <span id="p-notify-help" class="font-normal text-ink-3">Needs an email sender connected to this app (Resend or Postmark).</span>
            <Problem id="p-notify" text={formProblems.notify_emails} />
          </label>
          <label class="flex items-center gap-2">
            <input type="checkbox" name="active" value="yes" checked={form.active} class="size-4" />
            Taking submissions
          </label>
        </div>
      </Section>
      <Section title="Questions">
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
                  {/* As Google Forms lays a question out: what it asks and its type on one line, the rest under it, the moves at its foot. */}
                  <div class="grid gap-3 sm:grid-cols-[2fr_1fr]">
                    <label class={fieldClass}>
                      Question
                      <input name={`f.${i}.label`} value={text(f.label)} class={controlClass} />
                    </label>
                    <label class={fieldClass}>
                      Type
                      <select name={`f.${i}.type`} class={controlClass}>
                        {FIELD_TYPES.map((t) => (
                          <option value={t} selected={t === type}>
                            {TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {/* Only a dropdown, multiple choice or checkboxes takes options. */}
                    <label class={fieldClass + " hidden sm:col-span-2 [fieldset:has(option[value=select]:checked)_&]:flex [fieldset:has(option[value=radio]:checked)_&]:flex [fieldset:has(option[value=checkbox]:checked)_&]:flex"}>
                      Options, one per line
                      <textarea name={`f.${i}.options`} rows={3} class={controlClass}>
                        {Array.isArray(f.options) ? f.options.join("\n") : ""}
                      </textarea>
                    </label>
                    <label class={fieldClass}>
                      Help text
                      <input name={`f.${i}.help`} value={text(f.help)} placeholder="Optional" class={controlClass} />
                    </label>
                    {/* Where the answers are kept: the AI and the exports read it; nobody filling the form sees it, so it waits under Advanced (as Google Forms never shows one). */}
                    <details class="sm:col-span-2" open={/\bnamed?\b/.test(problems[String(i)] ?? "")}>
                      <summary class="cursor-pointer text-label text-ink-2">Advanced</summary>
                      <label class={fieldClass + " mt-2"}>
                        Saved as
                        <input name={`f.${i}.name`} value={text(f.name)} pattern="[a-z][a-z0-9_]*" class={controlClass} />
                        <span class="text-label font-normal text-ink-3">Lowercase letters, digits and underscores. Changing it keeps earlier answers under the old name.</span>
                      </label>
                    </details>
                    {type === "booking" ? (
                      <label class={fieldClass + " sm:col-span-2"}>
                        Booking type (its page address, like intake)
                        <input name={`f.${i}.booking_type`} value={text(f.booking_type)} pattern="[a-z0-9-]+" class={controlClass} />
                      </label>
                    ) : null}
                  </div>
                  <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <label class="mr-auto flex items-center gap-2">
                      <input type="checkbox" name={`f.${i}.required`} value="yes" checked={f.required === true} class="size-4" />
                      Required
                    </label>
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
        <button name="op" value="add" class={buttonClass + " mt-4"}>
          Add a question
        </button>
      </Section>
      {/* As Shopify's save bar: Save stays in reach however long the form is. */}
      <div class="sticky bottom-0 -mx-4 flex justify-end border-t border-line bg-surface px-4 py-3 sm:mx-0 sm:rounded-card sm:border sm:px-4">
        <button name="op" value="save" class={primaryClass}>
          Save
        </button>
      </div>
    </form>
  );
}
/** "New form" in the page's head: a title, nothing else (its key is made from it). Open again when the title was refused. */
function NewForm({ action, title = "", errors = {}, open = false }: { action: string; title?: string; errors?: Errors; open?: boolean }) {
  return (
    <details class="relative max-sm:open:basis-full" open={open}>
      <summary class={primaryClass + " cursor-pointer list-none"}>New form</summary>
      <form method="post" action={action} class="mt-2 flex flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-lift sm:absolute sm:right-0 sm:z-10 sm:w-72">
        <label class={fieldClass}>
          Title
          <input name="title" value={title} required autofocus placeholder="Quote request" class={controlClass}
            aria-invalid={errors.title || errors.key ? "true" : undefined} aria-describedby={errors.title || errors.key ? "new-form-p" : undefined} />
        </label>
        <Problem id="new-form-p" text={errors.title ?? errors.key} />
        <button class={primaryClass}>Create form</button>
      </form>
    </details>
  );
}
