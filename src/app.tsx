// The Hono app: the team-only gate, the database for the request, the
// routes. The whole CRM is private: every path but /healthz and Stripe's
// signed /hooks/stripe needs the
// X-TaskTool-User header Task & Tool's edge sets for a signed-in team member
// (admin/guard.ts), and answers 404 without it. Every change is a POST,
// checked same-origin by the same guard, and records who made it.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Child } from "hono/jsx";
import { csvResponse } from "./admin/csv";
import { withFlash } from "./admin/flash";
import { teamOnly } from "./admin/guard";
import { cut, everyPage } from "./admin/keyset";
import { TableRows } from "./admin/list";
import { idParam, isPartial, listUrl, localPath, str } from "./admin/query";
import { cfg, dealsCfg, eventsCfg, invoicesCfg, newLeadTask, ownerLabel, showBooking, KEY } from "./config";
import { normalizeEmail } from "./data/email";
import {
  createCustomer, customerChoices, facets, findMatch, getCustomer, listPage, readListCursor, saveDetails, sentTo, setArchived, setStage,
  NO_FILTER, type Customer, type ListFilter,
} from "./crm/customers";
import { csvColumns } from "./crm/columns";
import { postedFields, readFields } from "./crm/fields";
import { everythingFrom } from "./crm/history";
import { formChoices, inboxPage, markDone, markHandled, markUndone, readInboxCursor, requestOf, type InboxKind } from "./crm/inbox";
import { board, createDeal, customerDeals, getDeal, saveDeal, setDealArchived, setDealStage, setLostReason, winFromQuotes, type DealInput } from "./crm/deals";
import {
  addTask, customerTasks, doneTask, taskCounts, getTask, inPlay, listTasks, moveTask, nextTasks,
  pickTaskKind, readDay, readTime,
} from "./crm/tasks";
import { overview } from "./crm/overview";
import { mergeCustomers, mergePreview, possibleDuplicates } from "./crm/merge";
import { addNote, listNotes, pickNoteKind, wallTime } from "./customers/notes";
import { phoneKey } from "./customers/customer";
import { addEvent, customerEvents, eventCsvColumns, eventsPage, getEvent, inviteDomain, saveEvent, startWall, tellBooker, touchFor, type Event, type EventFilter, type EventInput } from "./crm/events";
import { addStage, archiveStage, editStage, firstOpenStage, listStages, moveStage, pickKind, pickPipeline, restoreStage, stagesWithCounts, type Pipeline, type StageResult } from "./crm/stages";
import { missingSentence } from "./crm/tables";
import { clean, parseAmount, parseTags, slugify } from "./crm/text";

import type { AppEnv } from "./runtime";
import { CustomerPage } from "./views/customer";
import { CustomersPage, customerSpec, filterParams, NewCustomerPage, Results } from "./views/customers";
import { InboxPage, InboxResults, InboxRows } from "./views/inbox";
import { Layout, SCHEDULE_TABS, WaitingView, type Section as NavSection } from "./views/layout";
import type { Frame } from "./admin/layout";
import { Board, CLOSED_DAYS, DealPage, DealsPage, NewDealPage, PER_COLUMN, type BoardData } from "./views/deals";
import { NewTaskPage, TasksPage } from "./views/tasks";
import { MergePage } from "./views/merge";
import { StagesPage } from "./views/stages";
import { bookingAdmin, peopleRoutes, typeRoutes } from "./booking/admin";
import { allPeople, allTypes } from "./booking/hours";
import { confirmFormBooking } from "./booking/confirm";
import { emailSend, emailSender, notifyBooking } from "./booking/notify";
import { envOf } from "./data/env";
import { afterResponse } from "./data/send";
import type { Db } from "./data/db";
import { primaryClass } from "./views/ui";
import { invoicesAdmin } from "./invoices/admin";
import { formEditor, formsAdmin } from "./forms/admin";
import { completePaidSubmission } from "./forms/store";
import { paymentsAdmin } from "./payments/admin";
import { invoiceEvents } from "./invoices/webhook";
import { todayIn as todayInZone } from "./reports/sql";
import { stripeWebhook } from "./payments/webhook";
import { quotesFor } from "./invoices/quotes";
import { invoicesFor, owed } from "./invoices/invoices";
import { loadTeam } from "./crm/people";
import { CUSTOMER_EVENTS, EventPage, eventParams, EventResults, EventsPage, eventSpec, NewEventPage, statusLabel, type Choices } from "./views/events";

type C = Context<AppEnv>;

/** A skill's pages (bookings, forms, invoices) in the CRM's own frame: its section lit, the page's head in the CRM's header. */
const frameIn = (section: NavSection): Frame => ({ title, user, back, sub, actions, children }) => (
  <Layout title={title} user={user} section={section} back={back} sub={sub} actions={actions}>
    {children}
  </Layout>
);
const PAGE = 50;
const app = new Hono<AppEnv>();

// The one public path: whether the database is ready. It says nothing else.
app.get("/healthz", (c) => {
  const opened = c.env.runtime.open();
  if (opened.db && opened.close) void opened.close().catch(() => {});
  return opened.db ? c.text("ok") : c.text("waiting for the database", 503);
});

// Stripe's events, with quotes and invoices on: public, because Stripe signs
// in with nothing but the signature, which payments/webhook.ts checks over the
// raw body before anything else. Stripe reaches dev through the machine's
// inbound URL (`python3 ~/tools/taskandtool.py inbound-url /hooks/stripe`).
if (invoicesCfg) {
  // POST only: any other method falls through to the team gate and its 404.
  app.on("POST", "/hooks/stripe", async (c, next) => {
    const opened = c.env.runtime.open();
    // 503: Stripe delivers again until the database is up.
    if (!opened.db) return c.text("waiting for the database", 503);
    c.set("db", opened.db);
    try {
      await next();
    } finally {
      if (opened.close) closeAfter(c, opened.close);
    }
  });
  // A form that ends in payment is complete once it is paid, and the booking
  // it made is confirmed then, by whichever app on the project gets there
  // first with a sender (booking/confirm.ts); a failed send is a 500, so
  // Stripe delivers again.
  app.route("/", stripeWebhook((c) => (c as unknown as C).var.db, {
    // An invoice paid through a quote's Pay button accepts the quote; its deal is won with it.
    more: [{
      handles: invoiceEvents.handles,
      apply: async (db, e) => {
        await invoiceEvents.apply(db, e);
        await winFromQuotes(db, "Stripe");
      },
    }],
    afterPaid: async (c, paymentId) => {
      const db = (c as unknown as C).var.db;
      const id = await completePaidSubmission(db, paymentId);
      if (!id) return;
      const book = cfg.booking_page ?? null;
      const sent = await confirmFormBooking(db, id, emailSender(envOf(c)), { domain: book ? new URL(book).host : "localhost", manageBase: book });
      if (sent.status === "failed") throw new Error(`booking confirmation for submission ${id}: ${sent.error}`);
    },
  }));
}

app.use("*", teamOnly() as unknown as MiddlewareHandler<AppEnv>);

// The database for this request: dev's one handle, or a pool per request in
// production, closed once the response (a streamed CSV included) is sent.
app.use("*", async (c, next) => {
  const opened = c.env.runtime.open();
  if (!opened.db) return c.html(<WaitingView state={opened.state} error={opened.error} />, 503);
  c.set("db", opened.db);
  try {
    await loadTeam(opened.db);
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
/** Today in the business's zone, YYYY-MM-DD: what "due" and "overdue" are judged against. */
const today = () => todayInZone(cfg.time_zone);
// withFlash resolves dot segments, so a `return` of "/.//evil.example" that
// passed localPath comes out as "//evil.example": another site. Only a path
// that is still this app's own after resolving is followed.
export function backTo(path: string, code: string): string {
  const to = withFlash(path, code);
  return to.startsWith("//") || to.startsWith("/\\") ? withFlash("/", code) : to;
}
const back = (c: C, path: string, code: string) => c.redirect(backTo(path, code), 303);

// ---- the inbox -------------------------------------------------------------

app.get("/", async (c) => {
  // To do unless asked for everything: what still needs someone.
  const all = c.req.query("view") === "all";
  const asked = c.req.query("form") ?? "";
  const form = /^[a-z0-9][a-z0-9-]{0,62}$/.test(asked) ? asked : null;
  const after = readInboxCursor(c.req.query("after"));
  const [{ rows, next, present }, numbers] = await Promise.all([
    inboxPage(c.var.db, { inbox: cfg.inbox, todo: !all, form }, after, PAGE),
    isPartial(c) ? null : overview(c.var.db, { timeZone: cfg.time_zone, currency: dealsCfg.currency, user: c.var.user }),
  ]);
  const filter = { view: all ? "all" : null, form };
  const self = listUrl("/", filter);
  const more = (cur: string) => listUrl("/", { ...filter, after: cur });
  if (isPartial(c) && after) return c.html(<InboxRows rows={rows} next={next} more={more} self={self} />);
  const missing = missingSentence(present, { payments: cfg.inbox.payments !== false });
  // The filter box (htmx): everything under it.
  if (isPartial(c)) return c.html(<InboxResults rows={rows} next={next} more={more} self={self} all={all} form={form} paged={false} missing={missing} />);
  return c.html(
    <InboxPage user={c.var.user} rows={rows} next={next} more={more} self={self} all={all} form={form} forms={await formChoices(c.var.db, cfg.inbox)}
      paged={!!after} missing={missing} numbers={numbers!} flash={flashOf(c)} undo={inboxRef(c.req.query("undo"))} />,
  );
});

/**
 * A deal made from the Inbox gets its first step: "Call back <name>" today,
 * on the deal, for whoever made it, unless crm.config.json turns it off.
 */
async function newLeadCall(db: Db, customer: { id: string; name: string }, dealId: string, user: string) {
  if (!newLeadTask) return;
  await addTask(db, customer.id, { kind: "call", title: `Call back ${customer.name}`, due_on: today(), due_time: null, owner: user, deal_id: dealId }, user);
}

/** An Inbox item named in a form or a link, "booking.12": its kind and id, or null. */
function inboxRef(v: unknown): { kind: InboxKind; id: string } | null {
  const m = typeof v === "string" ? v.match(/^(submission|booking|payment|change|quote)\.(\d{1,18})$/) : null;
  return m ? { kind: m[1] as InboxKind, id: m[2] } : null;
}

/** Take an Inbox item off To do: a submission by its status, anything else in inbox_done. */
const markItemDone = (db: Db, ref: { kind: InboxKind; id: string }, user: string) =>
  ref.kind === "submission" ? markDone(db, ref.id, user) : markHandled(db, ref.kind, ref.id, user).then((r) => r !== "missing");

/** The nav's count: what is in To do, filled in after the page loads so no page waits on it. */
app.get("/inbox/count", async (c) => {
  const { rows, next } = await inboxPage(c.var.db, { inbox: cfg.inbox, todo: true }, null, 99);
  if (!rows.length) return c.html(<span hidden></span>);
  return c.html(
    <span class="ml-auto rounded-full bg-accent px-1.5 text-label font-semibold tabular-nums text-accent-ink">
      <span class="sr-only">, </span>{next ? "99+" : rows.length}<span class="sr-only"> to do</span>
    </span>,
  );
});

// Done, with Undo in its message as Gmail's archive has: the redirect names what was done.
app.post("/inbox/done", async (c) => {
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", "/");
  const ref = inboxRef(`${str(body.kind)}.${str(body.id)}`);
  if (!ref || !(await markItemDone(c.var.db, ref, c.var.user))) return back(c, ret, "gone");
  return c.redirect(`${backTo(ret, "done")}&undo=${ref.kind}.${ref.id}`, 303);
});

app.post("/inbox/undo", async (c) => {
  const body = await c.req.parseBody();
  const ref = inboxRef(str(body.item));
  const undone = ref ? await markUndone(c.var.db, ref.kind, ref.id) : false;
  return back(c, localPath(str(body.return), "", "/"), undone ? "undone" : "gone");
});

// ---- customers ------------------------------------------------------------

async function readFilter(c: C): Promise<ListFilter> {
  const stages = await listStages(c.var.db, "customers", { archived: true });
  const stage = c.req.query("stage") ?? "";
  return {
    q: clean(c.req.query("q"), 100),
    stage: stages.some((s) => s.key === stage) ? stage : null,
    tag: clean(c.req.query("tag"), 40),
    owner: clean(c.req.query("owner"), 200),
    archived: c.req.query("show") === "archived",
    unplanned: c.req.query("next") === "none",
  };
}

app.get("/customers", async (c) => {
  const db = c.var.db;
  const f = await readFilter(c);
  const after = readListCursor(c.req.query("after"));
  const [stages, rows] = await Promise.all([listStages(db, "customers"), listPage(db, f, after, PAGE)]);
  const { page, next } = cut(rows, PAGE);
  const ids = page.map((r) => r.id);
  const [dues, playing] = await Promise.all([nextTasks(db, ids), inPlay(db, ids)]);
  const nextOf = { next: dues, inPlay: playing, today: today() };
  if (isPartial(c) && after) {
    const more = (cur: string) => listUrl("/customers", { ...filterParams(f), after: cur });
    return c.html(<TableRows spec={customerSpec(stages, nextOf)} rows={page} next={next} more={more} />);
  }
  if (isPartial(c)) return c.html(<Results stages={stages} filter={f} rows={page} next={next} paged={!!after} nextOf={nextOf} />);
  return c.html(
    <CustomersPage user={c.var.user} stages={stages} facets={await facets(db)} filter={f} rows={page} next={next} paged={!!after} nextOf={nextOf} flash={flashOf(c)} />,
  );
});

app.get("/customers/export.csv", async (c) => {
  const db = c.var.db;
  const f = await readFilter(c);
  const labels = new Map((await listStages(db, "customers", { archived: true })).map((s) => [s.key, s.label]));
  const day = new Date().toISOString().slice(0, 10);
  return csvResponse(`customers-${day}.csv`, csvColumns(labels, cfg.fields), everyPage((after, size) => listPage(db, f, after, size)));
});

/** Who a form names: an email, a phone, and a name (else the email, else the phone); no name means none was given. */
function personOf(body: Record<string, unknown>) {
  const email = normalizeEmail(body.email);
  const phone = clean(body.phone, 40);
  return { email, phone, name: clean(body.name, 200) ?? email ?? (phoneKey(phone) ? phone : null) };
}

/**
 * Who a new task, event or deal is for (CustomerPicker): the customer
 * picked (or the record it was merged into since the page loaded), or
 * someone new, matched by email or phone or added as a lead. A flash code
 * when neither works.
 */
async function pickedCustomer(c: C, body: Record<string, unknown>): Promise<{ id: string } | { error: "name-needed" | "gone" | "last-open" }> {
  const db = c.var.db;
  const picked = idParam(str(body.customer));
  if (picked) {
    const found = await getCustomer(db, picked);
    return found ? { id: found.merged_into ?? found.id } : { error: "gone" };
  }
  const { name, email, phone } = personOf(body);
  if (!name) return { error: "name-needed" };
  const status = await firstOpenStage(db, "customers");
  if (!status) return { error: "last-open" };
  return { id: (await createCustomer(db, { name, email, phone, stage: status.key }, c.var.user)).customer.id };
}

app.get("/customers/new", async (c) => {
  return c.html(<NewCustomerPage user={c.var.user} stages={await listStages(c.var.db, "customers")} flash={flashOf(c)} />);
});

app.post("/customers", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const { name, email, phone } = personOf(body);
  if (!name) return back(c, "/customers/new", "name-needed");
  const stages = await listStages(db, "customers");
  const stage = stages.find((s) => s.key === str(body.stage)) ?? (await firstOpenStage(db, "customers"));
  if (!stage) return back(c, "/stages", "last-open");
  const r = await createCustomer(
    db,
    { name, email, phone, company: clean(body.company, 200), address: clean(body.address, 500), stage: stage.key, source: clean(body.source, 100) },
    c.var.user,
  );
  return back(c, `/customers/${r.customer.id}`, r.created ? "added" : "exists");
});

/**
 * A customer's quotes, invoices and what they owe, under every address they
 * go by (a merge leaves the documents under the address they were sent to).
 */
async function moneyFor(db: Db, c: Customer) {
  const emails = [c.email, ...(c.other_emails ?? [])].filter((e): e is string => !!e);
  const each = await Promise.all(emails.map((email) => Promise.all([quotesFor(db, { email }), invoicesFor(db, { email }), owed(db, email)])));
  const newest = <T extends { created_at: Date }>(a: T, b: T) => b.created_at.getTime() - a.created_at.getTime();
  const owing = new Map<string, { currency: string; cents: string; count: number }>();
  for (const o of each.flatMap((e) => e[2])) {
    const cur = owing.get(o.currency);
    owing.set(o.currency, cur ? { currency: o.currency, cents: (BigInt(cur.cents) + BigInt(o.cents)).toString(), count: cur.count + o.count } : { ...o });
  }
  return { quotes: each.flatMap((e) => e[0]).sort(newest), invoices: each.flatMap((e) => e[1]).sort(newest), owed: [...owing.values()] };
}

app.get("/customers/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const customer = id ? await getCustomer(db, id) : null;
  if (!customer) return c.notFound();
  // A record merged into another opens that one.
  if (customer.merged_into) return c.redirect(`/customers/${customer.merged_into}`, 302);
  const [stages, notes, events, choices, history, f, money, deals, dealStages, tasks] = await Promise.all([
    listStages(db, "customers"), listNotes(db, customer.id), eventsCfg ? customerEvents(db, customer.id, CUSTOMER_EVENTS) : [],
    eventsCfg ? choicesOf(db) : { team: [], services: [] }, everythingFrom(db, customer), facets(db),
    invoicesCfg ? moneyFor(db, customer) : null,
    customerDeals(db, customer.id), listStages(db, "deals"), customerTasks(db, customer.id),
  ]);
  const duplicates = customer.archived_at ? [] : await possibleDuplicates(db, customer);
  const owners = [...new Set([c.var.user, ...f.owners])];
  return c.html(
    <CustomerPage user={c.var.user} customer={customer} stages={stages} notes={notes} events={events} choices={choices} history={history.items} present={history.present} owners={owners}
      deals={deals} dealStages={dealStages} tasks={tasks} today={today()}
      money={money} duplicates={duplicates} flash={flashOf(c)} />,
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
  const fr = readFields(cfg.fields, postedFields(cfg.fields, body));
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
  // `status` from the customer page's SaveOnChange select.
  const changed = await setStage(db, id, str(body.status), c.var.user);
  return back(c, ret, changed ? "stage" : "pick-status");
});

// A new deal on a customer's page.
app.post("/customers/:id/deals", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const self = `/customers/${id}`;
  const input = readDealForm(body);
  if (!input.deal.title) return back(c, self, "deal-title-needed");
  const stage = await dealStageOf(db, body.stage);
  if (!stage) return back(c, "/stages", "last-open");
  const deal = await createDeal(db, id, { ...input.deal, owner: input.deal.owner ?? c.var.user }, stage, c.var.user);
  return deal ? back(c, `/deals/${deal.id}`, input.invalid ? "invalid" : "deal-added") : c.notFound();
});

// A task for a customer, from their page or a deal's page.
app.post("/customers/:id/tasks", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", `/customers/${id}`);
  const title = clean(body.title, 200);
  const on = readDay(body.on);
  if (!title || !on) return back(c, ret, "task-needs");
  const task = await addTask(c.var.db, id, {
    kind: pickTaskKind(body.kind) ?? "call", title, due_on: on, due_time: readTime(body.at), owner: clean(body.owner, 200), deal_id: clean(body.deal, 20),
  }, c.var.user);
  return task ? back(c, ret, "task-added") : c.notFound();
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

// Merge another record into this one: find it, see what moves, merge.
app.get("/customers/:id/merge", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const keep = id ? await getCustomer(db, id) : null;
  if (!keep || keep.merged_into) return c.notFound();
  const q = clean(c.req.query("q"), 100);
  const other = idParam(c.req.query("other"));
  const [found, duplicates, preview] = await Promise.all([
    q ? listPage(db, { ...NO_FILTER, q }, null, 20) : [],
    possibleDuplicates(db, keep, 10),
    other && other !== keep.id ? mergePreview(db, keep.id, other) : null,
  ]);
  return c.html(
    <MergePage user={c.var.user} keep={keep} q={q} found={found.filter((x) => x.id !== keep.id).slice(0, 20)} duplicates={duplicates}
      preview={preview && !preview.other.merged_into ? preview : null} flash={flashOf(c)} />,
  );
});

app.post("/customers/:id/merge", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const other = idParam(str((await c.req.parseBody()).other));
  if (!other) return back(c, `/customers/${id}/merge`, "merge-gone");
  const r = await mergeCustomers(c.var.db, id, other, c.var.user);
  if (r.ok) return back(c, `/customers/${id}`, "merged");
  return back(c, `/customers/${id}/merge`, r.reason === "same" ? "merge-same" : "merge-gone");
});

app.post("/customers/:id/archive", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const archive = str((await c.req.parseBody()).archived) === "1";
  const r = await setArchived(c.var.db, id, archive, c.var.user);
  return r ? back(c, `/customers/${id}`, archive ? "archived" : "unarchived") : c.notFound();
});

// ---- the schedule: its events --------------------------------------------------
// crm.config.json's `events` names them; with it off these paths are 404.
// Each is a booking (the booking skill's table), whoever made it.

app.use("/events/*", async (c, next) => (eventsCfg ? next() : c.notFound()));
app.use("/events", async (c, next) => (eventsCfg ? next() : c.notFound()));
app.use("/customers/:id/events", async (c, next) => (eventsCfg ? next() : c.notFound()));

/** What the event forms choose from: the Team, and the Services with online booking on. */
const choicesOf = async (db: Db): Promise<Choices> => {
  const [team, services] = await Promise.all([allPeople(db), showBooking ? allTypes(db) : []]);
  return { team, services };
};

/**
 * The event form, read the way the customer form is: a bad amount or field is
 * left as it was and flagged. Null when it names neither a title nor a
 * service, or no time.
 */
function readEventForm(body: Record<string, unknown>, current?: Event): { event: EventInput; unset: string[]; invalid: boolean } | null {
  const ev = eventsCfg!;
  let invalid = false;
  const at = str(body.at).trim();
  const wall = (at ? wallTime(at) : null) ?? (current ? startWall(current, cfg.time_zone) : null);
  if (at && !wallTime(at)) invalid = true;
  const title = clean(body.title, 200);
  // A form with no Service choice (no services offered) leaves the one it has.
  const type = "type" in body ? idParam(str(body.type)) : current?.type_id ?? null;
  if (!wall || (!title && !type)) return null;
  const minutes = Number(str(body.minutes));
  let amount = parseAmount(body.amount, ev.currency);
  if (amount === "invalid") {
    invalid = true;
    amount = current?.amount_cents == null ? null : Number(current.amount_cents);
  }
  const fr = readFields(ev.fields, postedFields(ev.fields, body));
  if (fr.errors.length) invalid = true;
  return {
    event: {
      title, type_id: type, at: wall, timeZone: cfg.time_zone,
      minutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440 ? minutes : 60,
      resource_id: idParam(str(body.host)), location: clean(body.location, 500),
      amount_cents: amount, currency: (amount !== null && current?.currency) || ev.currency,
      notes: clean(body.notes, 10_000), fields: fr.set,
    },
    unset: fr.unset,
    invalid,
  };
}

function readEventFilter(c: C): EventFilter {
  const view = c.req.query("view");
  return { view: view === "overdue" || view === "past" || view === "all" ? view : "upcoming", host: idParam(c.req.query("host") ?? ""), q: clean(c.req.query("q"), 100) };
}

app.get("/events", async (c) => {
  const db = c.var.db;
  const f = readEventFilter(c);
  const after = readListCursor(c.req.query("after"));
  const { page, next } = cut(await eventsPage(db, f, after, PAGE), PAGE);
  if (isPartial(c) && after) {
    const more = (cur: string) => listUrl("/events", { ...eventParams(f), after: cur });
    return c.html(<TableRows spec={eventSpec()} rows={page} next={next} more={more} />);
  }
  if (isPartial(c)) return c.html(<EventResults filter={f} rows={page} next={next} paged={!!after} />);
  return c.html(<EventsPage user={c.var.user} team={await allPeople(db)} filter={f} rows={page} next={next} paged={!!after} flash={flashOf(c)} />);
});

app.get("/events/export.csv", async (c) => {
  const db = c.var.db;
  const f = readEventFilter(c);
  const ev = eventsCfg!;
  const day = new Date().toISOString().slice(0, 10);
  const columns = eventCsvColumns(ev.fields, cfg.time_zone, ownerLabel, ev.currency, statusLabel);
  return csvResponse(`${slugify(ev.many)}-${day}.csv`, columns, everyPage((after, size) => eventsPage(db, f, after, size)));
});

app.post("/customers/:id/events", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const customer = id ? await getCustomer(db, id) : null;
  if (!customer) return c.notFound();
  const form = readEventForm(await c.req.parseBody());
  if (!form) return back(c, `/customers/${customer.id}`, "event-incomplete");
  const r = await addEvent(db, customer, form.event, c.var.user);
  return r ? back(c, `/events/${r.id}`, form.invalid ? "invalid" : "event-added") : c.notFound();
});

app.get("/events/new", async (c) => {
  const db = c.var.db;
  const [choices, customers] = await Promise.all([choicesOf(db), customerChoices(db)]);
  return c.html(<NewEventPage user={c.var.user} choices={choices} customers={customers} flash={flashOf(c)} />);
});

// A new one from the list: the customer picked, or someone new, and the event.
app.post("/events", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const form = readEventForm(body);
  if (!form) return back(c, "/events/new", "event-incomplete");
  const who = await pickedCustomer(c, body);
  if ("error" in who) return back(c, who.error === "last-open" ? "/stages" : "/events/new", who.error);
  const customer = await getCustomer(db, who.id);
  const r = customer ? await addEvent(db, customer, form.event, c.var.user) : null;
  return r ? back(c, `/events/${r.id}`, form.invalid ? "invalid" : "event-added") : back(c, "/events", "gone");
});

app.get("/events/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const event = id ? await getEvent(db, id) : null;
  if (!event) return c.notFound();
  const [choices, money] = await Promise.all([
    choicesOf(db), invoicesCfg ? Promise.all([quotesFor(db, { visitId: event.id }), invoicesFor(db, { visitId: event.id })]) : null,
  ]);
  return c.html(<EventPage user={c.var.user} event={event} choices={choices} money={money ? { quotes: money[0], invoices: money[1] } : null} flash={flashOf(c)} />);
});

app.post("/events/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const current = id ? await getEvent(db, id) : null;
  if (!current) return c.notFound();
  const self = `/events/${current.id}`;
  const form = readEventForm(await c.req.parseBody(), current);
  if (!form) return back(c, self, "event-incomplete");
  const r = await saveEvent(db, current.id, { ...form.event, unset: form.unset }, c.var.user);
  if (!r) return back(c, "/events", "gone");
  afterResponse(c, tellBooker(db, envOf(c), current, r));
  return back(c, self, form.invalid ? "invalid" : "saved");
});

// ---- the booking pages ----------------------------------------------------------
// The booking skill's team side, in the CRM's frame: the week's Schedule, the
// Services customers book (with online booking on) and the Team's hours, time
// off and calendars. Every link to one booking opens its event page. The
// Website's /book pages read the same tables.

/** The request's database, set by the middleware above, for the skills' routes. */
const dbOf = (c: Context): Db => (c as unknown as C).var.db;

if (eventsCfg) {
  const one = eventsCfg.one;
  const team = {
    css: "/crm.css",
    source: "crm",
    timeZone: cfg.time_zone,
    sections: { schedule: "/schedule", services: "/services", team: "/team" },
    Frame: frameIn("schedule"),
    nav: SCHEDULE_TABS,
    currency: (invoicesCfg?.currency ?? eventsCfg.currency).toLowerCase(),
  };
  app.route(
    "/schedule",
    bookingAdmin(dbOf, {
      ...team,
      base: "/schedule",
      manageBase: cfg.booking_page,
      // Booked, moved or cancelled here tells an online booker, through the owner's sender (none: nothing is sent).
      onBooked: (c, e) => afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain: inviteDomain })),
      returnTo: (b) => ({ href: `/events/${b.id}`, label: one }),
      afterStatus: (c, b) => touchFor(dbOf(c), b.id, (c as unknown as C).var.user),
      scheduleActions: <a href="/events/new" class={primaryClass}>New {one.toLowerCase()}</a>,
    }),
  );
  app.route("/services", typeRoutes(dbOf, { ...team, base: "/services" }));
  app.route("/team", peopleRoutes(dbOf, { ...team, base: "/team" }));
}

// ---- forms ---------------------------------------------------------------------
// The forms skill's pages in the CRM's frame: the forms and their editor, and
// every submission (the Inbox's own list, by form: "orders" is the order
// form), each with the booking and payment it led to. The Website shows the
// same submissions; both read the same tables.

const FORM_TABS = [
  { href: "/forms", label: "Forms" },
  { href: "/forms/submissions", label: "Submissions" },
];
app.route(
  "/forms/submissions",
  formsAdmin(dbOf, {
    base: "/forms/submissions",
    css: "/crm.css",
    timeZone: cfg.time_zone,
    nav: FORM_TABS,
    links: {
      ...(eventsCfg ? { booking: (id: string) => `/schedule/${id}` } : {}),
      ...(invoicesCfg ? { payment: (id: string) => `/invoices/payments/${id}` } : {}),
    },
    Frame: frameIn("forms"),
  }),
);
app.route(
  "/forms",
  formEditor(dbOf, { base: "/forms", css: "/crm.css", timeZone: cfg.time_zone, source: "crm", submissions: "/forms/submissions", nav: FORM_TABS, Frame: frameIn("forms") }),
);

// ---- quotes and invoices ------------------------------------------------------
// The invoices skill's pages in the CRM's frame. A quote leaves through the
// owner's own sender, with a PDF where this runtime can print one (dev); an
// invoice through the owner's Stripe account, which emails it.

/** The Invoices section's tabs: the invoices skill's pages and the payments skill's, one set. */
const INVOICE_TABS = [
  { href: "/invoices/quotes", label: "Quotes" },
  { href: "/invoices", label: "Invoices" },
  { href: "/invoices/payments", label: "Payments" },
];

if (invoicesCfg) {
  // Every payment, where a refund is made: in the CRM's frame, before the invoice pages take /invoices/*.
  app.route(
    "/invoices/payments",
    paymentsAdmin(dbOf, {
      base: "/invoices/payments",
      css: "/crm.css",
      timeZone: cfg.time_zone,
      Frame: frameIn("invoices"),
      nav: INVOICE_TABS,
      navLabel: "Quotes and invoices",
    }),
  );
  app.route(
    "/invoices",
    invoicesAdmin(dbOf, {
      base: "/invoices",
      css: "/crm.css",
      source: "crm",
      timeZone: cfg.time_zone,
      business: invoicesCfg.name,
      currency: invoicesCfg.currency,
      terms: invoicesCfg.terms,
      print: (c, html) => (c as unknown as C).env.runtime.print?.(html) ?? Promise.resolve(null),
      Frame: frameIn("invoices"),
      daysUntilDue: invoicesCfg.days_until_due,
      // A quote or an invoice that went out is contact with the customer.
      afterSend: async (c, doc) => sentTo(dbOf(c), doc.email, (c as unknown as C).var.user),
      // A yes on the quote's page wins the deal it is for.
      afterDecide: async (c) => void (await winFromQuotes(dbOf(c), (c as unknown as C).var.user)),
      nav: INVOICE_TABS,
      // In a quote's or an invoice's Details: the customer's name opens their record, then the
      // request and the event it is for.
      links: async (c, linked) => {
        const db = dbOf(c);
        const doc = linked.kind === "quote" ? linked.quote : linked.invoice;
        const quote = linked.kind === "quote" ? linked.quote : null;
        const [customer, deal, event] = await Promise.all([
          findMatch(db, doc.email, doc.phone),
          quote?.deal_id ? getDeal(db, quote.deal_id) : null,
          eventsCfg && doc.visit_id ? getEvent(db, doc.visit_id) : null,
        ]);
        const more: { label: string; value: Child }[] = [];
        if (deal) {
          const hint = quote && quote.status !== "accepted" ? <span class="block text-label text-ink-3">A yes wins the {dealsCfg.one.toLowerCase()}.</span> : null;
          more.push({ label: dealsCfg.one, value: <><a href={`/deals/${deal.id}`}>{deal.title}</a>{hint}</> });
        }
        if (eventsCfg && event) more.push({ label: eventsCfg.one, value: <a href={`/events/${event.id}`}>{event.what}</a> });
        return { customer: customer ? `/customers/${customer.id}` : null, more };
      },
    }),
  );
}

// ---- tasks -----------------------------------------------------------

// Every open task, everyone's unless the viewer narrows to theirs: a small team's list is short.
app.get("/tasks", async (c) => {
  const mine = c.req.query("who") === "mine";
  const rows = await listTasks(c.var.db, mine ? c.var.user : null, PAGE);
  return c.html(<TasksPage user={c.var.user} mine={mine} today={today()} rows={rows.slice(0, PAGE)} more={rows.length > PAGE} flash={flashOf(c)} />);
});

app.get("/tasks/new", async (c) => {
  const [f, customers] = await Promise.all([facets(c.var.db), customerChoices(c.var.db)]);
  return c.html(<NewTaskPage user={c.var.user} owners={[...new Set([c.var.user, ...f.owners])]} today={today()} customers={customers} flash={flashOf(c)} />);
});

// A task from the Tasks page: for the customer picked, or for someone new
// (matched by email or phone, or added, as a new event does).
app.post("/tasks", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const title = clean(body.title, 200);
  const on = readDay(body.on);
  if (!title || !on) return back(c, "/tasks/new", "task-needs");
  const who = await pickedCustomer(c, body);
  if ("error" in who) return back(c, who.error === "last-open" ? "/stages" : "/tasks/new", who.error);
  const t = await addTask(db, who.id, {
    kind: pickTaskKind(body.kind) ?? "call", title, due_on: on, due_time: readTime(body.at), owner: clean(body.owner, 200) ?? c.var.user, deal_id: null,
  }, c.var.user);
  return t ? back(c, "/tasks", "task-added") : back(c, "/tasks/new", "gone");
});

// The nav's count: the viewer's tasks due today and overdue (htmx, after the page loads).
app.get("/tasks/count", async (c) => {
  const n = await taskCounts(c.var.db, today(), c.var.user);
  const due = n.overdue + n.today;
  if (!due) return c.html(<span hidden></span>);
  return c.html(
    <span class={"ml-auto rounded-full px-1.5 text-label font-semibold tabular-nums " + (n.overdue ? "bg-late text-accent-ink" : "bg-accent text-accent-ink")}>
      <span class="sr-only">, </span>{due}<span class="sr-only"> due{n.overdue ? `, ${n.overdue} overdue` : ""}</span>
    </span>,
  );
});

app.post("/tasks/:id/done", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const r = await doneTask(c.var.db, id, clean(body.outcome, 10_000), c.var.user);
  if (!r) return c.notFound();
  return back(c, localPath(str(body.return), "", `/customers/${r.task.customer_id}`), r.already ? "task-already" : "task-done");
});

app.post("/tasks/:id/move", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const f = await getTask(c.var.db, id);
  if (!f) return c.notFound();
  const ret = localPath(str(body.return), "", `/customers/${f.customer_id}`);
  const on = readDay(body.on);
  if (!on) return back(c, ret, "task-needs");
  // A time box sent (even empty) sets the time; the Tomorrow and Next week buttons send none and keep it.
  const at = "at" in body ? readTime(body.at) : undefined;
  return back(c, ret, (await moveTask(c.var.db, id, on, at, c.var.user)) ? "task-moved" : "task-already");
});

// ---- deals ----------------------------------------------------------------

/** A deal form's fields; a value that is not an amount is left blank and flagged. */
function readDealForm(body: Record<string, unknown>): { deal: DealInput; invalid: boolean } {
  let value = parseAmount(body.value, dealsCfg.currency);
  const invalid = value === "invalid";
  if (value === "invalid") value = null;
  const close = str(body.expected_close).trim();
  return {
    deal: {
      title: clean(body.title, 200) ?? "",
      value_cents: value,
      currency: dealsCfg.currency,
      owner: clean(body.owner, 200),
      expected_close: close ? readDay(close) : null,
      notes: clean(body.notes, 10_000),
    },
    invalid: invalid || (!!close && !readDay(close)),
  };
}

/** The deal stage asked for when it is active, else the first open one; null when there is none. */
async function dealStageOf(db: Db, asked: unknown): Promise<string | null> {
  const stages = await listStages(db, "deals");
  return (stages.find((s) => s.key === str(asked))?.key ?? (await firstOpenStage(db, "deals"))?.key) || null;
}

async function boardData(c: C): Promise<BoardData> {
  const db = c.var.db;
  const [stages, { cards, totals }] = await Promise.all([
    listStages(db, "deals"),
    board(db, { per: PER_COLUMN, closedDays: CLOSED_DAYS, currency: dealsCfg.currency }),
  ]);
  return { stages, cards, totals, next: await nextTasks(db, cards.map((d) => d.id), "deal"), today: today() };
}

app.get("/deals", async (c) => {
  if (isPartial(c)) return c.html(<Board data={await boardData(c)} />);
  return c.html(<DealsPage user={c.var.user} data={await boardData(c)} flash={flashOf(c)} />);
});

// New deal; from an Inbox item (?from=submission.12), filled in from it first, as Pipedrive's
// Convert to deal: the person, the deal named for what they asked, what they wrote as its
// notes, and the deals they already have open.
app.get("/deals/new", async (c) => {
  const db = c.var.db;
  const ref = inboxRef(c.req.query("from"));
  const asked = ref ? await requestOf(db, ref.kind, ref.id) : null;
  const who = asked ? await findMatch(db, asked.email, asked.phone) : null;
  const [stages, customers, theirs] = await Promise.all([listStages(db, "deals"), customerChoices(db), who ? customerDeals(db, who.id) : []]);
  const from = ref && asked ? { ref: `${ref.kind}.${ref.id}`, ...asked, customerId: who?.id ?? null, openDeals: theirs.filter((d) => !d.closed_at).map((d) => ({ id: d.id, title: d.title })) } : null;
  return c.html(<NewDealPage user={c.var.user} stages={stages} customers={customers} from={from} flash={flashOf(c)} />);
});

// New deal from the board: the customer picked, or someone new, and their deal.
app.post("/deals", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const input = readDealForm(body);
  if (!input.deal.title) return back(c, "/deals/new", "deal-title-needed");
  const stage = await dealStageOf(db, body.stage);
  if (!stage) return back(c, "/stages", "last-open");
  const who = await pickedCustomer(c, body);
  if ("error" in who) return back(c, who.error === "last-open" ? "/stages" : "/deals/new", who.error);
  const deal = await createDeal(db, who.id, { ...input.deal, owner: input.deal.owner ?? c.var.user }, stage, c.var.user);
  if (!deal) return back(c, "/deals", "gone");
  // Made from an Inbox item: that item is dealt with, and the deal gets its first step.
  const ref = inboxRef(body.from);
  if (ref) {
    await markItemDone(db, ref, c.var.user);
    const customer = await getCustomer(db, who.id);
    if (customer) await newLeadCall(db, customer, deal.id, c.var.user);
  }
  return back(c, `/deals/${deal.id}`, input.invalid ? "invalid" : "deal-added");
});

app.get("/deals/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const deal = id ? await getDeal(db, id) : null;
  if (!deal) return c.notFound();
  const [stages, tasks, deals, f, quotes] = await Promise.all([
    listStages(db, "deals"),
    customerTasks(db, deal.customer_id, deal.id),
    customerDeals(db, deal.customer_id),
    facets(db),
    invoicesCfg ? quotesFor(db, { dealId: deal.id }) : null,
  ]);
  return c.html(
    <DealPage user={c.var.user} deal={deal} stages={stages} tasks={tasks} openDeals={deals.filter((d) => !d.closed_at).map((d) => ({ id: d.id, title: d.title }))}
      quotes={quotes} owners={[...new Set([c.var.user, ...f.owners])]} today={today()} flash={flashOf(c)} />,
  );
});

app.post("/deals/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const self = `/deals/${id}`;
  const input = readDealForm(await c.req.parseBody());
  if (!input.deal.title) return back(c, self, "deal-title-needed");
  const saved = await saveDeal(c.var.db, id, input.deal, c.var.user);
  return saved ? back(c, self, input.invalid ? "invalid" : "deal-saved") : c.notFound();
});

app.post("/deals/:id/stage", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", `/deals/${id}`);
  // `stage` from a drag (static/crm.js); `status` from a select (admin/status.tsx's StatusForm).
  const stage = str(body.stage) || str(body.status);
  const reason = "lost_reason" in body ? clean(body.lost_reason, 200) : null;
  const current = await getDeal(db, id);
  if (!current) return c.notFound();
  let code = "deal-stage";
  if (current.stage === stage && "lost_reason" in body) code = (await setLostReason(db, id, reason, c.var.user)) ? "deal-saved" : "pick-stage";
  else if (!(await setDealStage(db, id, stage, c.var.user, reason))) code = "pick-stage";
  // From the board (htmx: a drag or a card's select) the answer is the board itself.
  if (isPartial(c) && ret === "/deals") return c.html(<Board data={await boardData(c)} />);
  return back(c, ret, code);
});

app.post("/deals/:id/archive", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const archive = str((await c.req.parseBody()).archived) === "1";
  return (await setDealArchived(c.var.db, id, archive, c.var.user)) ? back(c, `/deals/${id}`, archive ? "deal-archived" : "deal-unarchived") : c.notFound();
});

// ---- stages ---------------------------------------------------------------
// Both lists on one page: /stages/deals/... and /stages/customers/...

app.get("/stages", async (c) => {
  const [deals, statuses] = await Promise.all([stagesWithCounts(c.var.db, "deals"), stagesWithCounts(c.var.db, "customers")]);
  return c.html(<StagesPage user={c.var.user} deals={deals} statuses={statuses} flash={flashOf(c)} />);
});

const STAGE_FLASH = { missing: "gone", label: "pick-stage", "in-use": "stage-in-use", "last-open": "last-open", "bad-target": "bad-target" } as const;
const stageFlash = (r: StageResult, ok: string) => (r.ok ? ok : STAGE_FLASH[r.reason]);
/** The list and stage a path names, or null for a 404. */
const stageParams = (c: C): { p: Pipeline; key: string } | null => {
  const p = pickPipeline(c.req.param("pipeline"));
  const key = c.req.param("key") ?? "";
  return p && KEY.test(key) ? { p, key } : null;
};

app.post("/stages/:pipeline", async (c) => {
  const p = pickPipeline(c.req.param("pipeline"));
  if (!p) return c.notFound();
  const body = await c.req.parseBody();
  const r = await addStage(c.var.db, p, str(body.label), pickKind(body.kind) ?? "open", c.var.user);
  return back(c, "/stages", stageFlash(r, "stage-added"));
});

app.post("/stages/:pipeline/:key", async (c) => {
  const s = stageParams(c);
  if (!s) return c.notFound();
  const body = await c.req.parseBody();
  const r = await editStage(c.var.db, s.p, s.key, { label: clean(body.label, 60), kind: pickKind(body.kind) }, c.var.user);
  return back(c, "/stages", stageFlash(r, "stage-saved"));
});

app.post("/stages/:pipeline/:key/move", async (c) => {
  const s = stageParams(c);
  if (!s) return c.notFound();
  const dir = str((await c.req.parseBody()).dir) === "up" ? "up" : "down";
  return back(c, "/stages", stageFlash(await moveStage(c.var.db, s.p, s.key, dir, c.var.user), "stage-moved"));
});

app.post("/stages/:pipeline/:key/archive", async (c) => {
  const s = stageParams(c);
  if (!s) return c.notFound();
  const moveTo = clean((await c.req.parseBody()).move_to, 40);
  return back(c, "/stages", stageFlash(await archiveStage(c.var.db, s.p, s.key, moveTo, c.var.user), "stage-archived"));
});

app.post("/stages/:pipeline/:key/restore", async (c) => {
  const s = stageParams(c);
  if (!s) return c.notFound();
  return back(c, "/stages", stageFlash(await restoreStage(c.var.db, s.p, s.key, c.var.user), "stage-restored"));
});

export default app;
