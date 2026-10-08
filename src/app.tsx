// The Hono app: the team-only gate, the database for the request, the
// routes. The whole CRM is private: every path but /healthz and Stripe's
// signed /hooks/stripe needs the
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
import { cfg, dealsCfg, invoicesCfg, newLeadFollowUp, showBooking, visitsCfg, KEY } from "./config";
import { normalizeEmail } from "./data/email";
import {
  createCustomer, facets, findMatch, getCustomer, listPage, readListCursor, saveDetails, sentTo, setArchived, setStage,
  type Customer, type ListFilter,
} from "./crm/customers";
import { csvColumns } from "./crm/columns";
import { readFields } from "./crm/fields";
import { everythingFrom } from "./crm/history";
import { addFromInbox, formChoices, inboxPage, markDone, readInboxCursor, type InboxKind } from "./crm/inbox";
import { board, createDeal, customerDeals, getDeal, saveDeal, setDealArchived, setDealStage, setLostReason, winFromQuotes, type DealInput } from "./crm/deals";
import {
  addFollowUp, customerFollowUps, doneFollowUp, followUpCounts, getFollowUp, inPlay, listFollowUps, moveFollowUp, nextFollowUps, nothingPlanned,
  pickFollowUpKind, readDay, readTime, addDays, FOLLOW_UP_VIEWS, type FollowUpView,
} from "./crm/follow-ups";
import { overview } from "./crm/overview";
import { mergeCustomers, mergePreview, possibleDuplicates } from "./crm/merge";
import { addNote, listNotes, pickNoteKind } from "./crm/notes";
import { phoneKey } from "./crm/phone";
import { addVisit, bookingsWithoutJob, customerVisits, dealVisits, getVisit, visitFromBooking, visitFromDeal, parseAmount, pickVisitStatus, saveVisit, setVisitStatus, visitCsvColumns, visitOwners, visitsPage, type Visit, type VisitFilter, type VisitInput } from "./crm/visits";
import { addStage, archiveStage, editStage, firstOpenStage, listStages, moveStage, pickKind, pickPipeline, restoreStage, stagesWithCounts, type Pipeline, type StageResult } from "./crm/stages";
import { missingSentence } from "./crm/tables";
import { clean, nowIn, parseTags, slugify, wallTime } from "./crm/text";
import type { AppEnv } from "./runtime";
import { CustomerPage } from "./views/customer";
import { CustomersPage, customerSpec, filterParams, Results } from "./views/customers";
import { InboxPage, InboxResults, InboxRows } from "./views/inbox";
import { Layout, WaitingView } from "./views/layout";
import { Board, CLOSED_DAYS, DealPage, DealsPage, PER_COLUMN, type BoardData } from "./views/deals";
import { FollowUpsPage } from "./views/follow-ups";
import { MergePage } from "./views/merge";
import { StagesPage } from "./views/stages";
import { bookingAdmin } from "./booking/admin";
import { confirmFormBooking } from "./booking/confirm";
import { emailSend, emailSender, notifyBooking } from "./booking/notify";
import { envOf } from "./data/env";
import { afterResponse } from "./data/send";
import { Section } from "./admin/detail";
import type { Db } from "./data/db";
import { buttonClass } from "./views/ui";
import { invoicesAdmin } from "./invoices/admin";
import { formsAdmin } from "./forms/admin";
import { completePaidSubmission } from "./forms/store";
import { paymentsAdmin } from "./payments/admin";
import { invoiceEvents } from "./invoices/webhook";
import { todayIn as todayInZone } from "./reports/sql";
import { stripeWebhook } from "./payments/webhook";
import { quoteById, quotesFor } from "./invoices/quotes";
import { invoicesFor, owed } from "./invoices/invoices";
import { run, seriesQuery, todayIn } from "./reports/sql";
import { PaidByMonth } from "./views/money";
import { jobFromQuote } from "./crm/quotes";
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
  const unmatched = c.req.query("unmatched") === "1";
  const asked = c.req.query("form") ?? "";
  const form = /^[a-z0-9][a-z0-9-]{0,62}$/.test(asked) ? asked : null;
  const after = readInboxCursor(c.req.query("after"));
  const [{ rows, next, present }, numbers] = await Promise.all([
    inboxPage(c.var.db, { inbox: cfg.inbox, unmatched, form }, after, PAGE),
    after || isPartial(c) ? null : overview(c.var.db, { timeZone: cfg.time_zone, currency: dealsCfg.currency, user: c.var.user }),
  ]);
  const filter = { unmatched: unmatched ? "1" : null, form };
  const self = listUrl("/", filter);
  const more = (cur: string) => listUrl("/", { ...filter, after: cur });
  if (isPartial(c) && after) return c.html(<InboxRows rows={rows} next={next} more={more} self={self} />);
  const missing = missingSentence(present, { submissions: true, bookings: cfg.inbox.bookings !== false, payments: cfg.inbox.payments !== false });
  // The filter box (htmx): everything under it.
  if (isPartial(c)) return c.html(<InboxResults rows={rows} next={next} more={more} self={self} unmatched={unmatched} paged={false} missing={missing} />);
  return c.html(
    <InboxPage user={c.var.user} rows={rows} next={next} more={more} self={self} unmatched={unmatched} form={form} forms={await formChoices(c.var.db, cfg.inbox)}
      paged={!!after} missing={missing} numbers={numbers ?? await overview(c.var.db, { timeZone: cfg.time_zone, currency: dealsCfg.currency, user: c.var.user })} flash={flashOf(c)} />,
  );
});

/**
 * A lead's follow-up: "Call back <name>" today, for whoever added them, unless
 * crm.config.json turns it off or they already have one open.
 */
async function newLeadCall(db: Db, customer: Customer, dealId: string | null, user: string) {
  if (!newLeadFollowUp) return;
  const open = await customerFollowUps(db, customer.id);
  if (open.open.length) return;
  await addFollowUp(db, customer.id, { kind: "call", title: `Call back ${customer.name}`, due_on: today(), due_time: null, owner: user, deal_id: dealId }, user);
}

app.post("/inbox/add", async (c) => {
  const body = await c.req.parseBody();
  const kind = str(body.kind);
  if (kind !== "submission" && kind !== "booking" && kind !== "payment") return back(c, "/", "gone");
  const stage = await firstOpenStage(c.var.db, "customers");
  if (!stage) return back(c, "/stages", "last-open");
  const r = await addFromInbox(c.var.db, kind as InboxKind, str(body.id), stage.key, c.var.user, cfg.fields);
  if (!r) return back(c, "/", "gone");
  if (r.created) await newLeadCall(c.var.db, r.customer, null, c.var.user);
  return back(c, `/customers/${r.customer.id}`, r.created ? "added" : "exists");
});

// Add as deal: the person (matched, or added as a customer) and a deal in the
// first open stage, named for what came in. A customer already here gets
// another deal: a repeat customer's new enquiry.
app.post("/inbox/deal", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const kind = str(body.kind);
  if (kind !== "submission" && kind !== "booking" && kind !== "payment") return back(c, "/", "gone");
  const [status, stage] = await Promise.all([firstOpenStage(db, "customers"), firstOpenStage(db, "deals")]);
  if (!status || !stage) return back(c, "/stages", "last-open");
  const r = await addFromInbox(db, kind as InboxKind, str(body.id), status.key, c.var.user, cfg.fields);
  if (!r) return back(c, "/", "gone");
  const deal = await createDeal(db, r.customer.id, { title: `${r.customer.name}, ${r.source}`.slice(0, 200), value_cents: null, currency: dealsCfg.currency, owner: c.var.user, expected_close: null, notes: null }, stage.key, c.var.user);
  if (!deal) return back(c, "/", "gone");
  await newLeadCall(db, r.customer, deal.id, c.var.user);
  return back(c, `/deals/${deal.id}`, "deal-added");
});

app.post("/inbox/done", async (c) => {
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", "/");
  return back(c, ret, (await markDone(c.var.db, str(body.id), c.var.user)) ? "done" : "gone");
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
  };
}

app.get("/customers", async (c) => {
  const db = c.var.db;
  const f = await readFilter(c);
  const after = readListCursor(c.req.query("after"));
  const [stages, rows] = await Promise.all([listStages(db, "customers"), listPage(db, f, after, PAGE)]);
  const { page, next } = cut(rows, PAGE);
  const ids = page.map((r) => r.id);
  const [dues, playing] = await Promise.all([nextFollowUps(db, ids), inPlay(db, ids)]);
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

app.post("/customers", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const email = normalizeEmail(body.email);
  const phone = clean(body.phone, 40);
  const name = clean(body.name, 200) ?? email ?? (phoneKey(phone) ? phone : null);
  if (!name) return back(c, "/customers", "name-needed");
  const stages = await listStages(db, "customers");
  const stage = stages.find((s) => s.key === str(body.stage)) ?? (await firstOpenStage(db, "customers"));
  if (!stage) return back(c, "/stages", "last-open");
  const r = await createCustomer(
    db,
    { name, email, phone, company: clean(body.company, 200), stage: stage.key, source: clean(body.source, 100) },
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
  const [stages, notes, visits, history, f, money, deals, dealStages, followUps] = await Promise.all([
    listStages(db, "customers"), listNotes(db, customer.id), visitsCfg ? customerVisits(db, customer.id, CUSTOMER_VISITS) : [], everythingFrom(db, customer), facets(db),
    invoicesCfg ? moneyFor(db, customer) : null,
    customerDeals(db, customer.id), listStages(db, "deals"), customerFollowUps(db, customer.id),
  ]);
  const duplicates = customer.archived_at ? [] : await possibleDuplicates(db, customer);
  const owners = [...new Set([c.var.user, ...f.owners])];
  return c.html(
    <CustomerPage user={c.var.user} customer={customer} stages={stages} notes={notes} visits={visits} history={history.items} present={history.present} owners={owners}
      deals={deals} dealStages={dealStages} followUps={followUps} today={today()}
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
  // `status` from the select (admin/status.tsx's StatusForm).
  const changed = await setStage(db, id, str(body.status) || str(body.stage), c.var.user);
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

// A follow-up for a customer, from their page, a deal's page, or Nothing planned.
app.post("/customers/:id/follow-ups", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const ret = localPath(str(body.return), "", `/customers/${id}`);
  const title = clean(body.title, 200);
  const on = readDay(body.on);
  if (!title || !on) return back(c, ret, "fu-needs");
  const f = await addFollowUp(c.var.db, id, {
    kind: pickFollowUpKind(body.kind) ?? "call", title, due_on: on, due_time: readTime(body.at), owner: clean(body.owner, 200), deal_id: clean(body.deal, 20),
  }, c.var.user);
  return f ? back(c, ret, "fu-added") : c.notFound();
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
    q ? listPage(db, { q, stage: null, tag: null, owner: null, archived: false }, null, 20) : [],
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
  const [vo, f, money] = await Promise.all([
    visitOwners(db), facets(db), invoicesCfg ? Promise.all([quotesFor(db, { visitId: visit.id }), invoicesFor(db, { visitId: visit.id })]) : null,
  ]);
  const owners = [...new Set([c.var.user, ...vo, ...f.owners])];
  return c.html(<VisitPage user={c.var.user} visit={visit} owners={owners} money={money ? { quotes: money[0], invoices: money[1] } : null} flash={flashOf(c)} />);
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

/** Make it a job: the customer (matched, or added, as from the Inbox), then the job. */
app.post("/bookings/:id/job", async (c) => {
  if (!showBooking || !visitsCfg) return c.notFound();
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  let customerId = idParam(str(body.customer));
  if (!customerId || !(await getCustomer(db, customerId))) {
    const stage = await firstOpenStage(db, "customers");
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
                  <button class={buttonClass}>Create {visitsCfg.one.toLowerCase()}</button>
                </form>
              )
            ) : null}
          </Section>
        );
      },
    }),
  );
}

// ---- forms ---------------------------------------------------------------------
// The forms skill's pages in the CRM's frame: every form's submissions,
// filtered by form ("orders" is the order form), each with the booking and
// payment it led to, the ones nobody finished, and the form editor. The
// Website takes the submissions; both read the same tables.

app.route(
  "/forms",
  formsAdmin(dbOf, {
    base: "/forms",
    css: "/crm.css",
    source: "crm",
    timeZone: cfg.time_zone,
    nav: [
      { href: "/forms/submissions", label: "Submissions" },
      { href: "/forms", label: "Forms" },
    ],
    links: {
      ...(showBooking ? { booking: (id: string) => `/bookings/${id}` } : {}),
      ...(invoicesCfg ? { payment: (id: string) => `/invoices/payments/${id}` } : {}),
    },
    Frame: ({ title, user, children }) => (
      <Layout title={title} user={user} section="forms">
        {children}
      </Layout>
    ),
  }),
);

// ---- quotes and invoices ------------------------------------------------------
// The invoices skill's pages in the CRM's frame. A quote leaves through the
// owner's own sender, with a PDF where this runtime can print one (dev); an
// invoice through the owner's Stripe account, which emails it.

/** Make it a job: an accepted quote's customer (matched, or added), then its job. */
app.post("/invoices/quotes/:id/job", async (c) => {
  if (!invoicesCfg || !visitsCfg) return c.notFound();
  const id = idParam(c.req.param("id"));
  const qt = id ? await quoteById(c.var.db, id) : null;
  if (!qt) return c.notFound();
  if (qt.status !== "accepted") return back(c, `/invoices/quotes/${qt.id}`, "not-now");
  const r = await jobFromQuote(c.var.db, qt, c.var.user);
  if (!r) return back(c, "/stages", "last-open");
  return back(c, `/visits/${r.visitId}`, "visit-added");
});

if (invoicesCfg) {
  // Every payment, where a refund is made: in the CRM's frame, before the invoice pages take /invoices/*.
  app.route(
    "/invoices/payments",
    paymentsAdmin(dbOf, {
      base: "/invoices/payments",
      css: "/crm.css",
      timeZone: cfg.time_zone,
      Frame: ({ title, user, children }) => (
        <Layout title={title} user={user} section="invoices">
          {children}
        </Layout>
      ),
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
      Frame: ({ title, user, children }) => (
        <Layout title={title} user={user} section="invoices">
          {children}
        </Layout>
      ),
      daysUntilDue: invoicesCfg.days_until_due,
      // A quote or an invoice that went out is contact with the customer.
      afterSend: async (c, doc) => sentTo(dbOf(c), doc.email, (c as unknown as C).var.user),
      // A yes on the quote's page wins the deal it is for.
      afterDecide: async (c) => void (await winFromQuotes(dbOf(c), (c as unknown as C).var.user)),
      nav: [
        { href: "/invoices/quotes", label: "Quotes" },
        { href: "/invoices", label: "Invoices" },
        { href: "/invoices/payments", label: "Payments" },
        { href: "/invoices/tax-rates", label: "Tax rates" },
      ],
      // Paid by month: this month and the eleven before, one row per currency ever paid in.
      invoicesTop: async (c) => {
        const db = dbOf(c);
        const currencies = await db.sql<{ currency: string }>`select distinct currency from invoices where status = 'paid' and livemode is true order by 1`;
        if (!currencies.length) return null;
        const to = todayIn(cfg.time_zone);
        const first = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 12, 1)).toISOString().slice(0, 10);
        const rows = await Promise.all(currencies.map(async ({ currency }) => ({
          currency, months: await run<{ bucket: string; value: number }>(db, seriesQuery("invoices_paid", { from: first, to }, "month", cfg.time_zone, currency)),
        })));
        return <PaidByMonth rows={rows} />;
      },
      // Beside an invoice: whose it is here, and its job.
      invoiceExtra: async (c, inv) => {
        const customer = await findMatch(dbOf(c), inv.email, inv.phone);
        if (!customer && !inv.visit_id) return null;
        return (
          <Section title={cfg.vocabulary.one}>
            {customer ? <p class="mb-2"><a href={`/customers/${customer.id}`}>{customer.name}</a></p> : null}
            {inv.visit_id && visitsCfg ? <p><a href={`/visits/${inv.visit_id}`}>The {visitsCfg.one.toLowerCase()}</a></p> : null}
          </Section>
        );
      },
      // Beside a quote: whose it is here, the deal it is for, and its job.
      quoteExtra: async (c, qt) => {
        const db = dbOf(c);
        const customer = await findMatch(db, qt.email, qt.phone);
        const job = visitsCfg?.one.toLowerCase();
        const deal = qt.deal_id ? await getDeal(db, qt.deal_id) : null;
        return (
          <Section title={cfg.vocabulary.one}>
            {customer ? <p class="mb-3"><a href={`/customers/${customer.id}`}>{customer.name}</a></p> : <p class="mb-3 text-ink-2">Not a {cfg.vocabulary.one.toLowerCase()} yet.</p>}
            {deal ? <p class="mb-3">For <a href={`/deals/${deal.id}`}>{deal.title}</a>{qt.status === "accepted" ? "" : `; a yes wins the ${dealsCfg.one.toLowerCase()}`}.</p> : null}
            {visitsCfg ? (
              qt.visit_id ? (
                <p><a href={`/visits/${qt.visit_id}`}>The {job}</a></p>
              ) : qt.status === "accepted" ? (
                <form method="post" action={`/invoices/quotes/${qt.id}/job`}>
                  <button class={buttonClass}>Create {job}</button>
                </form>
              ) : null
            ) : null}
          </Section>
        );
      },
    }),
  );
}

// ---- follow-ups -----------------------------------------------------------

app.get("/follow-ups", async (c) => {
  const db = c.var.db;
  const asked = c.req.query("view");
  const view: FollowUpView = FOLLOW_UP_VIEWS.includes(asked as FollowUpView) ? (asked as FollowUpView) : "due";
  const mine = c.req.query("who") !== "all";
  const owner = mine ? c.var.user : null;
  const day = today();
  const [rows, unplanned, counts] = await Promise.all([
    view === "none" ? [] : listFollowUps(db, view, day, owner, PAGE),
    view === "none" ? nothingPlanned(db, owner, PAGE) : [],
    followUpCounts(db, day, owner),
  ]);
  return c.html(
    <FollowUpsPage user={c.var.user} view={view} mine={mine} today={day} rows={rows.slice(0, PAGE)} unplanned={unplanned.slice(0, PAGE)}
      more={rows.length > PAGE || unplanned.length > PAGE} counts={counts} flash={flashOf(c)} />,
  );
});

// The nav's count: the viewer's follow-ups due today and overdue (htmx, after the page loads).
app.get("/follow-ups/count", async (c) => {
  const n = await followUpCounts(c.var.db, today(), c.var.user);
  const due = n.overdue + n.today;
  if (!due) return c.html(<span></span>);
  return c.html(
    <span class={"ml-1 rounded-control px-1 text-label font-semibold " + (n.overdue ? "bg-late text-accent-ink" : "bg-accent text-accent-ink")}>
      <span class="sr-only">, </span>{due}<span class="sr-only"> due{n.overdue ? `, ${n.overdue} overdue` : ""}</span>
    </span>,
  );
});

app.post("/follow-ups/:id/done", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const r = await doneFollowUp(c.var.db, id, clean(body.outcome, 10_000), c.var.user);
  if (!r) return c.notFound();
  return back(c, localPath(str(body.return), "", `/customers/${r.followUp.customer_id}`), r.already ? "fu-already" : "fu-done");
});

app.post("/follow-ups/:id/move", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const f = await getFollowUp(c.var.db, id);
  if (!f) return c.notFound();
  const ret = localPath(str(body.return), "", `/customers/${f.customer_id}`);
  const on = readDay(body.on);
  if (!on) return back(c, ret, "fu-needs");
  // A time box sent (even empty) sets the time; the Tomorrow and Next week buttons send none and keep it.
  const at = "at" in body ? readTime(body.at) : undefined;
  return back(c, ret, (await moveFollowUp(c.var.db, id, on, at, c.var.user)) ? "fu-moved" : "fu-already");
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
  return { stages, cards, totals, next: await nextFollowUps(db, [...new Set(cards.map((d) => d.customer_id))]), today: today() };
}

app.get("/deals", async (c) => {
  if (isPartial(c)) return c.html(<Board data={await boardData(c)} />);
  return c.html(<DealsPage user={c.var.user} data={await boardData(c)} flash={flashOf(c)} />);
});

// New deal from the board: the person (matched by email or phone, or added) and their deal.
app.post("/deals", async (c) => {
  const db = c.var.db;
  const body = await c.req.parseBody();
  const input = readDealForm(body);
  if (!input.deal.title) return back(c, "/deals", "deal-title-needed");
  const email = normalizeEmail(body.email);
  const phone = clean(body.phone, 40);
  const name = clean(body.name, 200) ?? email ?? (phoneKey(phone) ? phone : null);
  if (!name) return back(c, "/deals", "name-needed");
  const [status, stage] = await Promise.all([firstOpenStage(db, "customers"), dealStageOf(db, body.stage)]);
  if (!status || !stage) return back(c, "/stages", "last-open");
  const who = await createCustomer(db, { name, email, phone, stage: status.key }, c.var.user);
  const deal = await createDeal(db, who.customer.id, { ...input.deal, owner: input.deal.owner ?? c.var.user }, stage, c.var.user);
  return deal ? back(c, `/deals/${deal.id}`, input.invalid ? "invalid" : "deal-added") : back(c, "/deals", "gone");
});

app.get("/deals/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const deal = id ? await getDeal(db, id) : null;
  if (!deal) return c.notFound();
  const [stages, followUps, deals, f, quotes, jobs] = await Promise.all([
    listStages(db, "deals"),
    customerFollowUps(db, deal.customer_id),
    customerDeals(db, deal.customer_id),
    facets(db),
    invoicesCfg ? db.sql<{ id: string }>`select id::text as id from quotes where deal_id = ${deal.id}::bigint order by created_at desc, id desc` : null,
    visitsCfg ? dealVisits(db, deal.id) : [],
  ]);
  const full = quotes ? (await Promise.all(quotes.map((q) => quoteById(db, q.id)))).filter((q): q is NonNullable<typeof q> => !!q) : null;
  return c.html(
    <DealPage user={c.var.user} deal={deal} stages={stages} followUps={followUps} openDeals={deals.filter((d) => !d.closed_at).map((d) => ({ id: d.id, title: d.title }))}
      quotes={full} jobs={jobs} owners={[...new Set([c.var.user, ...f.owners])]} today={today()} flash={flashOf(c)} />,
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

// Make it a job: a won deal's planned job, once.
app.post("/deals/:id/job", async (c) => {
  if (!visitsCfg) return c.notFound();
  const id = idParam(c.req.param("id"));
  const r = id ? await visitFromDeal(c.var.db, id, c.var.user) : null;
  return r ? back(c, `/visits/${r.visit.id}`, "visit-added") : c.notFound();
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
