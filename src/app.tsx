// The Hono app: the team-only gate, the database for the request, the
// routes. The whole CRM is private: every path but /healthz needs the
// X-TaskTool-User header Task & Tool's edge sets for a signed-in team member
// (admin/guard.ts), and answers 404 without it. Every change is a POST,
// checked same-origin by the same guard, and records who made it.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { csvResponse } from "./admin/csv";
import { withFlash } from "./admin/flash";
import { teamOnly } from "./admin/guard";
import { cut, everyPage } from "./admin/keyset";
import { TableRows } from "./admin/list";
import { idParam, isPartial, listUrl, localPath, str } from "./admin/query";
import { cfg, showBooking, showPipeline, visitsCfg, KEY } from "./config";
import { normalizeEmail } from "./data/email";
import {
  byStage, createCustomer, facets, findMatch, getCustomer, listPage, readListCursor, saveDetails, setArchived, setStage,
  type ListFilter,
} from "./crm/customers";
import { csvColumns } from "./crm/columns";
import { readFields } from "./crm/fields";
import { everythingFrom } from "./crm/history";
import { addFromInbox, inboxPage, markDone, readInboxCursor, type InboxKind } from "./crm/inbox";
import { addNote, listNotes, pickNoteKind } from "./crm/notes";
import { phoneKey } from "./crm/phone";
import { addVisit, bookingsWithoutJob, customerVisits, getVisit, visitFromBooking, parseAmount, pickVisitStatus, saveVisit, setVisitStatus, visitCsvColumns, visitOwners, visitsPage, type Visit, type VisitFilter, type VisitInput } from "./crm/visits";
import { addStage, archiveStage, editStage, firstOpenStage, listStages, moveStage, pickKind, restoreStage, stagesWithCounts, type StageResult } from "./crm/stages";
import { missingSentence } from "./crm/tables";
import { clean, nowIn, parseTags, slugify, wallTime } from "./crm/text";
import type { AppEnv } from "./runtime";
import { CustomerPage } from "./views/customer";
import { CustomersPage, customerSpec, filterParams, Results } from "./views/customers";
import { InboxPage, InboxResults, InboxRows } from "./views/inbox";
import { Layout, WaitingView } from "./views/layout";
import { Pipeline, PipelinePage, PER_COLUMN, type PipelineData } from "./views/pipeline";
import { StagesPage } from "./views/stages";
import { bookingAdmin } from "./booking/admin";
import { emailSend, notifyBooking } from "./booking/notify";
import { envOf } from "./data/env";
import { afterResponse } from "./data/send";
import { Section } from "./admin/detail";
import type { Db } from "./data/db";
import { buttonClass } from "./views/ui";
import { CUSTOMER_VISITS, visitParams, VisitPage, VisitResults, VisitsPage, visitSpec } from "./views/visits";

type C = Context<AppEnv>;
const PAGE = 50;
const app = new Hono<AppEnv>();

// The one public path: whether the database is ready. It says nothing else.
app.get("/healthz", (c) => {
  const opened = c.env.runtime.open();
  if (opened.db && opened.close) void opened.close().catch(() => {});
  return opened.db ? c.text("ok") : c.text("waiting for the database", 503);
});

app.use("*", teamOnly() as unknown as MiddlewareHandler<AppEnv>);

// The database for this request: dev's one handle, or a pool per request in
// production, closed once the response (a streamed CSV included) is sent.
app.use("*", async (c, next) => {
  const opened = c.env.runtime.open();
  if (!opened.db) return c.html(<WaitingView state={opened.state} error={opened.error} />, 503);
  c.set("db", opened.db);
  try {
    await next();
  } finally {
    if (opened.close) closeAfter(c, opened.close);
  }
});

function closeAfter(c: C, close: () => Promise<void>) {
  let done: Promise<unknown>;
  const res = c.res;
  if (res?.body) {
    const { readable, writable } = new TransformStream();
    done = res.body.pipeTo(writable).catch(() => {}).finally(close);
    c.res = new Response(readable, res);
  } else done = close();
  const settled = done.catch(() => {});
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No execution context outside a Worker; the promise runs on its own.
  }
}

const flashOf = (c: C) => ({ code: c.req.query("saved"), n: c.req.query("n") });
// withFlash resolves dot segments, so a `return` of "/.//evil.example" that
// passed localPath comes out as "//evil.example": another site. Only a path
// that is still this app's own after resolving is followed.
export function backTo(path: string, code: string): string {
  const to = withFlash(path, code);
  return to.startsWith("//") || to.startsWith("/\\") ? withFlash("/", code) : to;
}
const back = (c: C, path: string, code: string) => c.redirect(backTo(path, code), 303);

// ---- what came in ---------------------------------------------------------

app.get("/", async (c) => {
  const unmatched = c.req.query("unmatched") === "1";
  const after = readInboxCursor(c.req.query("after"));
  const { rows, next, present } = await inboxPage(c.var.db, { inbox: cfg.inbox, unmatched }, after, PAGE);
  const filter = { unmatched: unmatched ? "1" : null };
  const self = listUrl("/", filter);
  const more = (cur: string) => listUrl("/", { ...filter, after: cur });
  if (isPartial(c) && after) return c.html(<InboxRows rows={rows} next={next} more={more} self={self} />);
  const missing = missingSentence(present, { submissions: true, bookings: cfg.inbox.bookings !== false, payments: cfg.inbox.payments !== false });
  // The filter box (htmx): everything under it.
  if (isPartial(c)) return c.html(<InboxResults rows={rows} next={next} more={more} self={self} unmatched={unmatched} paged={false} missing={missing} />);
  return c.html(
    <InboxPage user={c.var.user} rows={rows} next={next} more={more} self={self} unmatched={unmatched} paged={!!after} missing={missing} flash={flashOf(c)} />,
  );
});

app.post("/inbox/add", async (c) => {
  const body = await c.req.parseBody();
  const kind = str(body.kind);
  if (kind !== "submission" && kind !== "booking" && kind !== "payment") return back(c, "/", "gone");
  const stage = await firstOpenStage(c.var.db);
  if (!stage) return back(c, "/stages", "last-open");
  const r = await addFromInbox(c.var.db, kind as InboxKind, str(body.id), stage.key, c.var.user, cfg.fields);
  if (!r) return back(c, "/", "gone");
  return back(c, `/customers/${r.customer.id}`, r.created ? "added" : "exists");
});

app.post("/inbox/done", async (c) => {
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", "/");
  return back(c, ret, (await markDone(c.var.db, str(body.id), c.var.user)) ? "done" : "gone");
});

// ---- customers ------------------------------------------------------------

async function readFilter(c: C): Promise<ListFilter> {
  const stages = await listStages(c.var.db, { archived: true });
  const stage = c.req.query("stage") ?? "";
  return {
    q: clean(c.req.query("q"), 100),
    stage: stages.some((s) => s.key === stage) ? stage : null,
    tag: clean(c.req.query("tag"), 40),
    owner: clean(c.req.query("owner"), 200),
    archived: c.req.query("show") === "archived",
  };
}

app.get("/customers", async (c) => {
  const db = c.var.db;
  const f = await readFilter(c);
  const after = readListCursor(c.req.query("after"));
  const [stages, rows] = await Promise.all([listStages(db), listPage(db, f, after, PAGE)]);
  const { page, next } = cut(rows, PAGE);
  if (isPartial(c) && after) {
    const more = (cur: string) => listUrl("/customers", { ...filterParams(f), after: cur });
    return c.html(<TableRows spec={customerSpec(stages)} rows={page} next={next} more={more} />);
  }
  if (isPartial(c)) return c.html(<Results stages={stages} filter={f} rows={page} next={next} paged={!!after} />);
  return c.html(
    <CustomersPage user={c.var.user} stages={stages} facets={await facets(db)} filter={f} rows={page} next={next} paged={!!after} flash={flashOf(c)} />,
  );
});

app.get("/customers/export.csv", async (c) => {
  const db = c.var.db;
  const f = await readFilter(c);
  const labels = new Map((await listStages(db, { archived: true })).map((s) => [s.key, s.label]));
  const day = new Date().toISOString().slice(0, 10);
  return csvResponse(`customers-${day}.csv`, csvColumns(labels, cfg.fields), everyPage((after, size) => listPage(db, f, after, size)));
});

app.post("/customers", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const phone = clean(body.phone, 40);
  const name = clean(body.name, 200) ?? email ?? (phoneKey(phone) ? phone : null);
  if (!name) return back(c, "/customers", "name-needed");
  const stages = await listStages(db);
  const stage = stages.find((s) => s.key === str(body.stage)) ?? (await firstOpenStage(db));
  if (!stage) return back(c, "/stages", "last-open");
  const r = await createCustomer(
    db,
    { name, email, phone, company: clean(body.company, 200), stage: stage.key, source: clean(body.source, 100) },
    c.var.user,
  );
  return back(c, `/customers/${r.customer.id}`, r.created ? "added" : "exists");
});

app.get("/customers/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const customer = id ? await getCustomer(db, id) : null;
  if (!customer) return c.notFound();
  const [stages, notes, visits, history, f] = await Promise.all([
    listStages(db), listNotes(db, customer.id), visitsCfg ? customerVisits(db, customer.id, CUSTOMER_VISITS) : [], everythingFrom(db, customer), facets(db),
  ]);
  const owners = [...new Set([c.var.user, ...f.owners])];
  return c.html(
    <CustomerPage user={c.var.user} customer={customer} stages={stages} notes={notes} visits={visits} history={history.items} present={history.present} owners={owners} flash={flashOf(c)} />,
  );
});

app.post("/customers/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const current = id ? await getCustomer(db, id) : null;
  if (!current) return c.notFound();
  const self = `/customers/${current.id}`;
  const body = await c.req.parseBody();
  let invalid = false;
  const rawEmail = str(body.email).trim();
  let email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !email) {
    email = current.email;
    invalid = true;
  }
  const name = clean(body.name, 200) ?? current.name;
  const input: Record<string, unknown> = {};
  for (const fd of cfg.fields) if (`f_${fd.key}` in body) input[fd.key] = body[`f_${fd.key}`];
  const fr = readFields(cfg.fields, input);
  if (fr.errors.length) invalid = true;
  const r = await saveDetails(
    db,
    current.id,
    {
      name, email, phone: clean(body.phone, 40), company: clean(body.company, 200), address: clean(body.address, 500),
      source: clean(body.source, 100), tags: parseTags(str(body.tags)), owner: clean(body.owner, 200), notes: clean(body.notes, 10_000),
      fields: fr.set, unset: fr.unset,
    },
    c.var.user,
  );
  if (!r.ok) return back(c, self, r.reason === "email-taken" ? "email-taken" : "gone");
  return back(c, self, invalid ? "invalid" : "saved");
});

app.post("/customers/:id/stage", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", `/customers/${id}`);
  // `stage` from a drag (static/crm.js); `status` from a select (admin/status.tsx's StatusForm).
  const changed = await setStage(db, id, str(body.stage) || str(body.status), c.var.user);
  // From the pipeline (htmx: a drag or a card's select) the answer is the pipeline itself.
  if (isPartial(c)) return c.html(<Pipeline data={await pipelineData(c)} />);
  return back(c, ret, changed ? "stage" : "pick-stage");
});

app.post("/customers/:id/notes", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const self = `/customers/${id}`;
  const text = str(body.body);
  if (!text.trim()) return back(c, self, "note-empty");
  const note = await addNote(c.var.db, id, { kind: pickNoteKind(body.kind) ?? "note", body: text, at: wallTime(body.at), timeZone: cfg.time_zone }, c.var.user);
  return note ? back(c, self, "note") : c.notFound();
});

app.post("/customers/:id/archive", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const archive = str((await c.req.parseBody()).archived) === "1";
  const r = await setArchived(c.var.db, id, archive, c.var.user);
  return r ? back(c, `/customers/${id}`, archive ? "archived" : "unarchived") : c.notFound();
});

// ---- jobs, visits, appointments or events ---------------------------------
// crm.config.json's `visits` names them; with it off these paths are 404.

app.use("/visits/*", async (c, next) => (visitsCfg ? next() : c.notFound()));
app.use("/visits", async (c, next) => (visitsCfg ? next() : c.notFound()));
app.use("/customers/:id/visits", async (c, next) => (visitsCfg ? next() : c.notFound()));

/** The visit form, read the way the customer form is: a bad amount or field is left as it was and flagged. */
function readVisitForm(body: Record<string, unknown>, current?: Visit) {
  const v = visitsCfg!;
  let invalid = false;
  const at = str(body.at).trim();
  let wall = at ? wallTime(at) : null;
  if (at && !wall) {
    invalid = true;
    wall = current?.starts_at ? wallTime(nowIn(cfg.time_zone, new Date(current.starts_at))) : null;
  }
  let amount = parseAmount(body.amount, v.currency);
  if (amount === "invalid") {
    invalid = true;
    amount = current?.amount_cents == null ? null : Number(current.amount_cents);
  }
  const input: Record<string, unknown> = {};
  for (const fd of v.fields) if (`f_${fd.key}` in body) input[fd.key] = body[`f_${fd.key}`];
  const fr = readFields(v.fields, input);
  if (fr.errors.length) invalid = true;
  const visit: VisitInput = {
    title: clean(body.title, 200) ?? "",
    status: pickVisitStatus(body.status) ?? "planned",
    at: wall,
    timeZone: cfg.time_zone,
    owner: clean(body.owner, 200),
    amount_cents: amount,
    currency: (amount !== null && current?.currency) || v.currency,
    notes: clean(body.notes, 10_000),
    fields: fr.set,
  };
  return { visit, unset: fr.unset, invalid };
}

function readVisitFilter(c: C): VisitFilter {
  const view = c.req.query("view");
  return { view: view === "done" || view === "all" ? view : "upcoming", owner: clean(c.req.query("owner"), 200), q: clean(c.req.query("q"), 100) };
}

app.get("/visits", async (c) => {
  const db = c.var.db;
  const f = readVisitFilter(c);
  const after = readListCursor(c.req.query("after"));
  const { page, next } = cut(await visitsPage(db, f, after, PAGE), PAGE);
  if (isPartial(c) && after) {
    const more = (cur: string) => listUrl("/visits", { ...visitParams(f), after: cur });
    return c.html(<TableRows spec={visitSpec()} rows={page} next={next} more={more} />);
  }
  if (isPartial(c)) return c.html(<VisitResults filter={f} rows={page} next={next} paged={!!after} />);
  const [owners, booked] = await Promise.all([visitOwners(db), showBooking ? bookingsWithoutJob(db) : []]);
  return c.html(<VisitsPage user={c.var.user} owners={owners} booked={booked} filter={f} rows={page} next={next} paged={!!after} flash={flashOf(c)} />);
});

app.get("/visits/export.csv", async (c) => {
  const db = c.var.db;
  const f = readVisitFilter(c);
  const v = visitsCfg!;
  const day = new Date().toISOString().slice(0, 10);
  const columns = visitCsvColumns(v.fields, cfg.time_zone, cfg.owner_label ?? "Owner", v.currency);
  return csvResponse(`${slugify(v.many)}-${day}.csv`, columns, everyPage((after, size) => visitsPage(db, f, after, size)));
});

app.post("/customers/:id/visits", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const self = `/customers/${id}`;
  const { visit, invalid } = readVisitForm(await c.req.parseBody());
  if (!visit.title) return back(c, self, "visit-title-needed");
  const r = await addVisit(c.var.db, id, visit, c.var.user);
  if (!r) return c.notFound();
  return back(c, `/visits/${r.id}`, invalid ? "invalid" : "visit-added");
});

app.get("/visits/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const visit = id ? await getVisit(db, id) : null;
  if (!visit) return c.notFound();
  const [vo, f] = await Promise.all([visitOwners(db), facets(db)]);
  const owners = [...new Set([c.var.user, ...vo, ...f.owners])];
  return c.html(<VisitPage user={c.var.user} visit={visit} owners={owners} flash={flashOf(c)} />);
});

app.post("/visits/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const current = id ? await getVisit(db, id) : null;
  if (!current) return c.notFound();
  const self = `/visits/${current.id}`;
  const { visit, unset, invalid } = readVisitForm(await c.req.parseBody(), current);
  if (!visit.title) visit.title = current.title;
  const r = await saveVisit(db, current.id, { ...visit, unset }, c.var.user);
  if (!r) return back(c, "/visits", "gone");
  return back(c, self, invalid ? "invalid" : "saved");
});

app.post("/visits/:id/status", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", `/visits/${id}`);
  const status = pickVisitStatus(body.status);
  if (!status) return back(c, ret, "pick-status");
  const r = await setVisitStatus(c.var.db, id, status, c.var.user);
  return r ? back(c, ret, "visit-status") : c.notFound();
});

// ---- bookings ---------------------------------------------------------------
// The team's side of the booking skill, in the CRM's own frame: every
// booking, what can be booked and who takes it, each person's hours, time
// off and calendars. The Website's /book pages read the same tables.

/** Make it a job: the customer (matched, or added, as from What came in), then the job. */
app.post("/bookings/:id/job", async (c) => {
  if (!showBooking || !visitsCfg) return c.notFound();
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  let customerId = idParam(str(body.customer));
  if (!customerId || !(await getCustomer(db, customerId))) {
    const stage = await firstOpenStage(db);
    if (!stage) return back(c, "/stages", "last-open");
    const r = await addFromInbox(db, "booking", id, stage.key, c.var.user, cfg.fields);
    if (!r) return c.notFound();
    customerId = r.customer.id;
  }
  const v = await visitFromBooking(db, id, customerId, c.var.user);
  return v ? back(c, `/visits/${v.id}`, "visit-added") : c.notFound();
});

/** The request's database, set by the middleware above, for the booking skill's routes. */
const dbOf = (c: Context): Db => (c as unknown as C).var.db;

if (showBooking) {
  app.route(
    "/bookings",
    bookingAdmin(dbOf, {
      base: "/bookings",
      css: "/crm.css",
      source: "crm",
      timeZone: cfg.time_zone,
      manageBase: cfg.booking_page,
      // The confirmation of a booking the team made, through the owner's sender (none: nothing is sent).
      onBooked: (c, e) =>
        afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain: new URL(cfg.booking_page ?? c.req.url).host })),
      Frame: ({ title, user, children }) => (
        <Layout title={title} user={user} section="bookings">
          {children}
        </Layout>
      ),
      // Beside a booking: whose it is here, and its job.
      extra: async (c, b) => {
        const db = dbOf(c);
        const [customer, visit] = await Promise.all([findMatch(db, b.email, b.phone), db.sql<{ id: string }>`select id::text as id from customer_visits where booking_id = ${b.id}::bigint`]);
        return (
          <Section title={cfg.vocabulary.one}>
            {customer ? <p class="mb-3"><a href={`/customers/${customer.id}`}>{customer.name}</a></p> : <p class="mb-3 text-ink-2">Not a {cfg.vocabulary.one.toLowerCase()} yet.</p>}
            {visitsCfg ? (
              visit[0] ? (
                <p><a href={`/visits/${visit[0].id}`}>The {visitsCfg.one.toLowerCase()}</a></p>
              ) : (
                <form method="post" action={`/bookings/${b.id}/job`}>
                  {customer ? <input type="hidden" name="customer" value={customer.id} /> : null}
                  <button class={buttonClass}>Make it a {visitsCfg.one.toLowerCase()}</button>
                </form>
              )
            ) : null}
          </Section>
        );
      },
    }),
  );
}

// ---- pipeline -------------------------------------------------------------

async function pipelineData(c: C): Promise<PipelineData> {
  const [stages, { cards, counts }] = await Promise.all([listStages(c.var.db), byStage(c.var.db, PER_COLUMN)]);
  return { stages, cards, counts };
}

app.get("/pipeline", async (c) => {
  if (!showPipeline) return c.redirect("/customers", 302);
  if (isPartial(c)) return c.html(<Pipeline data={await pipelineData(c)} />);
  return c.html(<PipelinePage user={c.var.user} data={await pipelineData(c)} flash={flashOf(c)} />);
});

// ---- stages ---------------------------------------------------------------

app.get("/stages", async (c) => c.html(<StagesPage user={c.var.user} stages={await stagesWithCounts(c.var.db)} flash={flashOf(c)} />));

const STAGE_FLASH = { missing: "gone", label: "pick-stage", "in-use": "stage-in-use", "last-open": "last-open", "bad-target": "bad-target" } as const;
const stageFlash = (r: StageResult, ok: string) => (r.ok ? ok : STAGE_FLASH[r.reason]);

app.post("/stages", async (c) => {
  const body = await c.req.parseBody();
  const r = await addStage(c.var.db, str(body.label), pickKind(body.kind) ?? "open", c.var.user);
  return back(c, "/stages", stageFlash(r, "stage-added"));
});

app.post("/stages/:key", async (c) => {
  const key = c.req.param("key");
  if (!KEY.test(key)) return c.notFound();
  const body = await c.req.parseBody();
  const r = await editStage(c.var.db, key, { label: clean(body.label, 60), kind: pickKind(body.kind) }, c.var.user);
  return back(c, "/stages", stageFlash(r, "stage-saved"));
});

app.post("/stages/:key/move", async (c) => {
  const key = c.req.param("key");
  if (!KEY.test(key)) return c.notFound();
  const dir = str((await c.req.parseBody()).dir) === "up" ? "up" : "down";
  return back(c, "/stages", stageFlash(await moveStage(c.var.db, key, dir, c.var.user), "stage-moved"));
});

app.post("/stages/:key/archive", async (c) => {
  const key = c.req.param("key");
  if (!KEY.test(key)) return c.notFound();
  const moveTo = clean((await c.req.parseBody()).move_to, 40);
  return back(c, "/stages", stageFlash(await archiveStage(c.var.db, key, moveTo, c.var.user), "stage-archived"));
});

app.post("/stages/:key/restore", async (c) => {
  const key = c.req.param("key");
  if (!KEY.test(key)) return c.notFound();
  return back(c, "/stages", stageFlash(await restoreStage(c.var.db, key, c.var.user), "stage-restored"));
});

export default app;
