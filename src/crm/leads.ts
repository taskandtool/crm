// Leads: one enquiry each from a contact, as Pipedrive's leads and Jobber's
// requests are (docs/plans/crm-contacts-leads-deals.md). The customers skill
// makes them as people arrive (saveLead: a form submission, an online
// booking) and the team adds one for a phone call; here they are read,
// converted to a deal or archived with a reason. Open, converted or
// archived; never deleted.
import { likePattern } from "../admin/query";
import type { Db } from "../data/db";
import type { LeadSource } from "../customers/customer";
import { BOOKING_PAGE, saveSubmitter } from "../forms/store";
import { cfg, dealsCfg, newLeadTask } from "../config";
import { createDeal } from "./deals";
import { listStages } from "./stages";
import { todayIn } from "../reports/sql";
import { EVENT_OF, spliced } from "./sql";
import { addTask } from "./tasks";
import { present as presentTables } from "./tables";

export type LeadStatus = "open" | "converted" | "archived";
export const LEAD_STATUSES: LeadStatus[] = ["open", "converted", "archived"];

/** Where a lead came from, as a row says it; a form's title follows "Website form". */
export const SOURCE_LABELS: Record<LeadSource, string> = {
  form: "Website form", booking: "Online booking", phone: "Phone", walk_in: "Walk-in", referral: "Referral", other: "Other",
};
/** What the team adds by hand: everything but what only the website makes. */
export const MANUAL_SOURCES: LeadSource[] = ["phone", "walk_in", "referral", "other"];
/** Why a lead was archived, as HubSpot's Disqualification reason. */
export const ARCHIVE_REASONS = ["Not a fit", "Spam", "Duplicate", "Other"];

export type Lead = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_company: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  source: LeadSource;
  title: string;
  notes: string | null;
  owner: string | null;
  status: LeadStatus;
  archived_reason: string | null;
  deal_id: string | null;
  deal_title: string | null;
  submission_id: string | null;
  booking_id: string | null;
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  updated_by: string | null;
  /** The submission's answers, for the lead's page. */
  answers: Record<string, unknown> | null;
  /** What they said: the lead's notes, else the submission's message. */
  said: string | null;
  /** The contact's newest open deal, shown beside the lead. */
  open_deal_id: string | null;
  open_deal_title: string | null;
  /** The contact's next scheduled event. */
  next_event_id: string | null;
  next_event_at: Date | null;
};

// A lead with its contact, its deal, what they wrote, and what the contact already has. The
// submission's answers come only where the project has a submissions table (tables.ts).
const leadTexts = (submissions: boolean) =>
  spliced({
    columns: `l.id::text as id, l.customer_id::text as customer_id, c.name as customer_name, c.company as customer_company, c.email::text as customer_email, c.phone as customer_phone,
      l.source, l.title, l.notes, l.owner::text as owner, l.status, l.archived_reason, l.deal_id::text as deal_id, d.title as deal_title,
      l.submission_id::text as submission_id, l.booking_id::text as booking_id, l.created_at, l.created_by::text as created_by,
      l.updated_at, l.updated_by::text as updated_by, ${submissions ? "s.data" : "null::jsonb"} as answers,
      od.id::text as open_deal_id, od.title as open_deal_title, ne.id::text as next_event_id, ne.starts_at as next_event_at`,
    from: `leads l
      join customers c on c.id = l.customer_id
      left join deals d on d.id = l.deal_id
      ${submissions ? "left join submissions s on s.id = l.submission_id" : ""}
      left join lateral (
        select d2.id, d2.title from deals d2
        where d2.customer_id = l.customer_id and d2.closed_at is null and d2.archived_at is null
        order by d2.created_at desc, d2.id desc limit 1) od on true
      left join lateral (
        select b.id, b.starts_at from bookings b
        where b.status = 'confirmed' and b.starts_at >= now() and ${EVENT_OF}
        order by b.starts_at limit 1) ne on true`,
    event_of: EVENT_OF,
  });
const WITH_SUBMISSIONS = leadTexts(true);
const WITHOUT_SUBMISSIONS = leadTexts(false);
const sqlFor = async (db: Db) => ((await presentTables(db)).submissions ? WITH_SUBMISSIONS : WITHOUT_SUBMISSIONS).sql(db);

/** The first answer worth reading: a message if there is one, else the first text. */
export function firstText(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const entries = Object.entries(data).filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim());
  const msg = entries.find(([k]) => /message|comment|note|details|question|enquiry|inquiry|about|reason|issue|problem|describe/i.test(k)) ?? entries[0];
  return msg ? String(msg[1]).slice(0, 300) : null;
}

/** Where it came from and what it is: "Website form · Request service", "Online booking · Free estimate", "Phone · New furnace". */
export const sourceText = (l: Pick<Lead, "source" | "title">) => `${SOURCE_LABELS[l.source]} · ${l.title}`;

/**
 * What a deal made from a lead is called. A lead the team typed says what the
 * work is ("Thermostat swap"); one a form or an online booking made says only
 * the form or the service, so its deal is named for who it is for: their
 * company, as Salesforce names a converted opportunity, else the person, as
 * Pipedrive's leads are ("Acme Bakery deal", "Rosa Delgado deal"). Either can be renamed.
 */
export const dealTitleFor = (l: Pick<Lead, "source" | "title" | "customer_name" | "customer_company">) =>
  l.source === "form" || l.source === "booking" ? `${l.customer_company?.trim() || l.customer_name} deal` : l.title;

const toLead = (r: Omit<Lead, "said">): Lead => ({ ...r, said: r.notes ?? firstText(r.answers) });

/** The leads in one status, newest first; `q` matches the contact's name, email or phone, or the lead's title. */
export async function listLeads(db: Db, f: { status: LeadStatus; source?: string | null; owner?: string | null; q?: string | null }, limit = 200): Promise<Lead[]> {
  const pat = likePattern(f.q);
  const rows = await (await sqlFor(db))<Omit<Lead, "said">>`
    select {columns} from {from}
    where l.status = ${f.status} and (${f.source ?? null}::text is null or l.source = ${f.source ?? null}::text)
      and (${f.owner ?? null}::citext is null or l.owner = ${f.owner ?? null}::citext)
      and (${pat}::text is null or c.name ilike ${pat} or c.email::text ilike ${pat} or c.phone ilike ${pat} or l.title ilike ${pat})
    order by l.created_at desc, l.id desc
    limit ${limit}`;
  return rows.map(toLead);
}

export async function getLead(db: Db, id: string): Promise<Lead | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [r] = await (await sqlFor(db))<Omit<Lead, "said">>`select {columns} from {from} where l.id = ${id}::bigint`;
  return r ? toLead(r) : null;
}

/** A contact's leads, open first, then newest: their page's Leads section. */
export async function contactLeads(db: Db, customerId: string): Promise<Lead[]> {
  if (!/^\d{1,18}$/.test(customerId)) return [];
  const rows = await (await sqlFor(db))<Omit<Lead, "said">>`
    select {columns} from {from} where l.customer_id = ${customerId}::bigint
    order by (l.status = 'open') desc, l.created_at desc, l.id desc limit 50`;
  return rows.map(toLead);
}

/** The leads a deal came from: its page's "Where it came from". */
export async function dealLeads(db: Db, dealId: string): Promise<Lead[]> {
  if (!/^\d{1,18}$/.test(dealId)) return [];
  const rows = await (await sqlFor(db))<Omit<Lead, "said">>`select {columns} from {from} where l.deal_id = ${dealId}::bigint order by l.created_at, l.id`;
  return rows.map(toLead);
}

/** How many are open: the sidebar's count. */
export async function openLeadCount(db: Db): Promise<number> {
  const [r] = await db.sql<{ n: number }>`select count(*)::int as n from leads where status = 'open'`;
  return r.n;
}

/**
 * Converted into a deal, from the page or the deals command: off Open, with
 * the deal named; the booking it came from (if any) is the deal's; and the
 * deal gets its first step, "Call back <name>" (the deal's contact) today
 * for whoever converted it, unless crm.config.json's tasks.new_lead is false.
 */
export async function convertLead(db: Db, id: string, dealId: string, user: string, taskOwner: string | null = user): Promise<boolean> {
  const [lead] = await db.sql<{ submission_id: string | null; booking_id: string | null; customer_id: string; name: string }>`
    update leads l set status = 'converted', deal_id = ${dealId}::bigint, archived_reason = null, updated_at = now(), updated_by = ${user}
    from deals d join customers c on c.id = d.customer_id
    -- Open, or claimed by autoDeals (converted, its deal not made yet).
    where l.id = ${id}::bigint and (l.status = 'open' or (l.status = 'converted' and l.deal_id is null)) and d.id = ${dealId}::bigint
    returning l.submission_id::text as submission_id, l.booking_id::text as booking_id, d.customer_id::text as customer_id, c.name`;
  if (lead?.booking_id) {
    await db.sql`update bookings set deal_id = ${dealId}::bigint, updated_at = now(), updated_by = ${user} where id = ${lead.booking_id}::bigint and deal_id is null`;
  }
  // Its form submission is dealt with too: done in the forms list.
  await submissionFollows(db, lead?.submission_id, "done", user);
  if (lead && newLeadTask) {
    await addTask(db, lead.customer_id, { kind: "call", title: `Call back ${lead.name}`, due_on: todayIn(cfg.time_zone), due_time: null, owner: taskOwner, deal_id: dealId }, user);
  }
  return !!lead;
}

/**
 * Leads a form or a service says are deals straight away (forms.deals,
 * booking_types.deals), as Pipedrive's web forms save a deal and Jobber's job
 * booking converts its request: each made a deal in the first open stage,
 * named as a convert names it, with what they wrote as its notes and the
 * booking's amount (else the service's price) as its value, then converted
 * as Convert to deal does (its submission done, its booking on the deal, a
 * "Call back" task). The lead stays, converted, as the deal's "Where it came
 * from". Each is claimed before its deal is made, so two requests at once
 * make one deal; a lead with no open stage to land in is let go, and a claim
 * left unfinished (the process stopped between) is taken up again after a
 * few minutes. Cheap when none is waiting; run before the team's pages and
 * the AI's lists.
 */
export async function autoDeals(db: Db): Promise<number> {
  const sql = spliced((await presentTables(db)).forms ? AUTO_FORMS : NO_FORMS).sql(db);
  const waiting = await sql<{ id: string; amount_cents: string | null; currency: string | null; stage: string | null; host: string | null }>`
    select l.id::text as id, coalesce(b.amount_cents, t.price_cents)::text as amount_cents, coalesce(b.currency, t.currency) as currency,
           {form_stage} as stage, r.email::text as host
    from leads l
    left join bookings b on b.id = l.booking_id
    left join booking_types t on t.id = b.type_id
    left join resources r on r.id = b.resource_id
    {forms_join}
    where (l.status = 'open' or ({claim_left})) and (coalesce(t.deals, false) {forms_deal})
    order by l.created_at, l.id
    limit 20`;
  if (!waiting.length) return 0;
  // The form's stage when it is still an open one; else the first open stage.
  const open = (await listStages(db, "deals")).filter((s) => s.kind === "open" && !s.archived);
  if (!open.length) return 0;
  let made = 0;
  for (const w of waiting) {
    // Claimed: off Open first, so a second request finds nothing to do.
    const [claimed] = await CLAIM.sql(db)<{ id: string }>`
      update leads l set status = 'converted', updated_at = now() where l.id = ${w.id}::bigint and (l.status = 'open' or ({claim_left})) returning l.id::text as id`;
    if (!claimed) continue;
    const lead = (await getLead(db, w.id))!;
    const by = SOURCE_LABELS[lead.source];
    const stage = open.find((s) => s.key === w.stage) ?? open[0];
    // Whose: the lead's (the form's owner), else for a booking the person who takes it, as HubSpot gives a booked meeting's deal to its owner.
    const owner = lead.owner ?? w.host;
    // Deals keep their currency as the config writes it ("USD"); a service's price is kept lowercase.
    const currency = ((w.amount_cents && w.currency) || dealsCfg.currency).toUpperCase();
    const release = () => db.sql`update leads set status = 'open' where id = ${w.id}::bigint and status = 'converted' and deal_id is null`;
    const deal = await createDeal(db, lead.customer_id, {
      title: dealTitleFor(lead), value_cents: w.amount_cents ? Number(w.amount_cents) : null, currency,
      owner, expected_close: null, notes: lead.said,
    }, stage.key, by).catch(async (e) => { await release(); throw e; });
    if (!deal) {
      await release();
      continue;
    }
    await convertLead(db, w.id, deal.id, by, owner);
    made++;
  }
  return made;
}
/** A claim nobody finished: converted, no deal, a few minutes old. */
const CLAIM_LEFT = "l.status = 'converted' and l.deal_id is null and l.updated_at < now() - interval '5 minutes'";
const AUTO_FORMS = {
  forms_join: "left join submissions s on s.id = l.submission_id left join forms f on f.key = s.form_key",
  // By name from the row: a forms table an older app made, without these yet, reads as off.
  forms_deal: "or coalesce((to_jsonb(f) ->> 'deals')::boolean, false)",
  form_stage: "to_jsonb(f) ->> 'deal_stage'",
  claim_left: CLAIM_LEFT,
};
const NO_FORMS = { forms_join: "", forms_deal: "", form_stage: "null::text", claim_left: CLAIM_LEFT };
const CLAIM = spliced({ claim_left: CLAIM_LEFT });

/** Archived with a reason (Not a fit, Spam, ...); its form submission follows: archived, or spam. */
export async function archiveLead(db: Db, id: string, reason: string, user: string): Promise<boolean> {
  const rows = await db.sql<{ submission_id: string | null }>`
    update leads set status = 'archived', archived_reason = ${reason.slice(0, 200)}, updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint and status = 'open' returning submission_id::text as submission_id`;
  await submissionFollows(db, rows[0]?.submission_id, reason === "Spam" ? "spam" : "done", user);
  return rows.length > 0;
}

/** A lead's form submission takes the lead's state, so the forms list agrees with Leads. The CRM writes no other column of the forms skill's table. */
async function submissionFollows(db: Db, submissionId: string | null | undefined, status: "read" | "done" | "spam", user: string) {
  if (!submissionId) return;
  await db.sql`update submissions set status = ${status}, updated_at = now(), updated_by = ${user} where id = ${submissionId}::bigint and status <> ${status}`;
}

/** Open again: Undo after Archive, or Unarchive on an archived lead. A converted one stays with its deal. */
export async function reopenLead(db: Db, id: string, user: string): Promise<boolean> {
  const rows = await db.sql<{ submission_id: string | null }>`
    update leads set status = 'open', archived_reason = null, updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint and status = 'archived' returning submission_id::text as submission_id`;
  await submissionFollows(db, rows[0]?.submission_id, "read", user);
  return rows.length > 0;
}

/** Its own details changed: what they need, whose it is, the notes (Pipedrive's lead details are edited in place). */
export async function saveLeadDetails(db: Db, id: string, d: { title: string; owner: string | null; notes: string | null }, user: string): Promise<boolean> {
  const rows = await db.sql`
    update leads set title = ${d.title.slice(0, 200)}, owner = ${d.owner}, notes = ${d.notes}, updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint returning id`;
  return rows.length > 0;
}

/**
 * Leads for what was already waiting when leads began: each form request
 * still open (new or read, not spam) and each online booking still to come
 * that the team did not make. Run by setup at start and deploy; once each (saveLead keeps one per submission and booking).
 */
export async function leadsForOpenItems(db: Db): Promise<number> {
  const before = (await db.sql<{ n: number }>`select count(*)::int as n from leads`)[0].n;
  const subs = !(await presentTables(db)).submissions ? [] : await db.sql<{ id: string }>`
    select s.id::text as id from submissions s
    where s.status in ('new', 'read') and s.form_key <> ${BOOKING_PAGE.key}
      and not exists (select 1 from leads l where l.submission_id = s.id)
    order by s.created_at, s.id`;
  for (const s of subs) await saveSubmitter(db, s.id);
  await WITH_SUBMISSIONS.sql(db)`
    insert into leads (customer_id, source, booking_id, title, created_at, updated_at)
    select c.id, 'booking', b.id, coalesce(t.name, 'Booking'), b.created_at, b.created_at
    from bookings b
    left join booking_types t on t.id = b.type_id
    join lateral (select c.id from customers c where {event_of} order by c.id limit 1) c on true
    where b.status = 'confirmed' and b.starts_at >= now() and b.hold_until is null and b.submission_id is null
      and coalesce(b.source, '') <> 'crm'
      and not exists (select 1 from leads l where l.booking_id = b.id)
    on conflict do nothing`;
  return (await db.sql<{ n: number }>`select count(*)::int as n from leads`)[0].n - before;
}
