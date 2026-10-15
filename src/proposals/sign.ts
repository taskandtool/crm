// The customer's answer at the link, and what a yes does.
//
// Signing records the typed name, the email the link went to, the time,
// where from, and the page exactly as signed, and accepts the quote, in one
// transaction, only if the page they read is still the current one. Then
// its deal is won, and "After they sign" runs: the first invoice, as a
// draft or sent through Stripe, which never holds up the signature. A
// confirmation goes to the signer with their copy's link.
//
// A decline names its reason; the quote is declined and its deal lost with it.
// Mark accepted on the team's page runs the same "After they sign"
// (afterAccepted), so a yes by phone reaches the same invoices.
import { q, type Db } from "../data/db";
import type { Email, Sent } from "../data/send";
import type { Stripe } from "../payments/stripe";
import { formatMoney } from "../payments/money";
import { taxRates } from "../payments/tax";
import { addTask } from "../crm/tasks";
import { findMatch } from "../crm/customers";
import { setDealStage, winFromQuotes } from "../crm/deals";
import { todayIn } from "../invoices/document";
import { invoiceFromQuote, invoicesFor } from "../invoices/invoices";
import { isEditable, ONLINE, quoteById, type Quote } from "../invoices/quotes";
import { sendInvoice } from "../invoices/stripe";
import { tokenHash } from "../data/token";
import { fillPage } from "./page";
import { afterSign, pageFor, proposalOf, storePage, type ProposalOpts } from "./store";

export type AnswerDeps = {
  opts: ProposalOpts;
  /** The owner's Stripe; throws when it is not connected. */
  stripe: () => Stripe;
  /** The owner's sender (data/send.ts); never throws. */
  send: (mail: Email) => Promise<Sent>;
  /** The PDF of a page, where this runtime can print (the machine). */
  print?: (html: string) => Promise<Uint8Array | null>;
  daysUntilDue: number;
};

/** What a yes did, in lines for the team; a failure is a task as well (taskFor). */
export type Accepted = { lines: string[] };

/** A task for whoever made the quote, on its customer, due today: how a failure after a yes is never lost. */
async function taskFor(db: Db, qt: Quote, title: string, deps: AnswerDeps): Promise<void> {
  const customer = await findMatch(db, qt.email, qt.phone);
  if (!customer) return console.error(`quote ${qt.number}: ${title} (no customer to put a task on)`);
  await addTask(db, customer.id, { kind: "task", title: title.slice(0, 300), due_on: todayIn(deps.opts.timeZone), due_time: null, owner: qt.created_by, deal_id: qt.deal_id }, "CRM");
}

/**
 * "After they sign", for an accepted quote: the first invoice it names,
 * made once (a repeat finds it and makes nothing), and sent through Stripe
 * when that was chosen. A Stripe failure leaves the draft and a task naming
 * the error.
 */
export async function afterAccepted(db: Db, qt: Quote, by: string, deps: AnswerDeps): Promise<Accepted> {
  const p = await proposalOf(db, qt.id);
  if (!p || p.first_invoice === "none" || qt.status !== "accepted") return { lines: [] };
  const share = p.deposit_percent ? { kind: "percent" as const, percent: p.deposit_percent } : { kind: "all" as const };
  const made = await invoiceFromQuote(db, qt.id, by, "crm", deps.daysUntilDue, { share, seen: 0 });
  if (!made.ok) {
    if (made.reason === "invoiced") return { lines: [] };
    const problem = `Make the first invoice for ${qt.name ?? qt.email} (${qt.number}) by hand: it was not made (${made.reason}).`;
    await taskFor(db, qt, problem, deps);
    return { lines: [problem] };
  }
  const inv = made.value;
  const what = `${p.deposit_percent ? `deposit invoice (${p.deposit_percent}%)` : "invoice"} for ${formatMoney(inv.total_cents, inv.currency)}`;
  if (p.first_invoice === "draft") return { lines: [`drafted the ${what}, to review and send`] };
  let stripe: Stripe;
  try {
    stripe = deps.stripe();
  } catch {
    const problem = `The ${what} for ${qt.name ?? qt.email} (${qt.number}) is a draft: Stripe is not connected, so it was not sent. Connect Stripe, then send it.`;
    await taskFor(db, qt, problem, deps);
    return { lines: [problem] };
  }
  const sent = await sendInvoice(db, stripe, inv.id, by);
  if (!sent.ok) {
    const problem = `Send the ${what} for ${qt.name ?? qt.email} (${qt.number}): Stripe said ${sent.message}`;
    await taskFor(db, qt, problem, deps);
    return { lines: [problem] };
  }
  return { lines: [`sent the ${what} through Stripe`] };
}

/** A signed quote's page as the customer keeps it: the signature drawn in, the invoices with where they stand. */
export async function signedState(db: Db, quoteId: string, opts: ProposalOpts) {
  const [sig] = await db.sql`select name, signed_at from quote_signatures where quote_id = ${quoteId}::bigint`;
  const invoices = (await invoicesFor(db, { quoteId })).filter((i) => i.status !== "void").reverse();
  const pay = invoices.find((i) => i.status === "open" && i.hosted_url) ?? null;
  return {
    kind: "signed" as const,
    name: sig?.name ?? "",
    when: sig ? signedWhen(new Date(sig.signed_at), opts) : "",
    invoices,
    pay,
  };
}

/** "Signed on October 14, 2026 at 2:14 PM MDT": the business's zone, named. */
function signedWhen(at: Date, opts: Pick<ProposalOpts, "timeZone" | "locale">): string {
  const f = new Intl.DateTimeFormat(opts.locale ?? "en-US", { timeZone: opts.timeZone, dateStyle: "long", timeStyle: "short" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? opts.timeZone;
  return `Signed on ${f.format(at)} ${zone}`;
}

export type Signing = { name: unknown; agree: unknown; page: unknown };
export type Meta = { ip: string | null; browser: string | null };
export type Signed =
  | { ok: true; accepted: Accepted }
  | { ok: false; reason: "stale" | "closed" | "invalid"; message: string };

/**
 * Sign the quote at its link. Refused when the name or the agree box is
 * missing (`invalid`), when the page they read is no longer the current one
 * (`stale`: they read it again), or when it is no longer open (`closed`).
 */
export async function signProposal(db: Db, quoteId: string, input: Signing, meta: Meta, deps: AnswerDeps): Promise<Signed> {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 120) return { ok: false, reason: "invalid", message: "Type your full name to sign." };
  if (input.agree !== "1") return { ok: false, reason: "invalid", message: "Tick the box to agree to the terms and to sign electronically." };
  const [qt, p] = await Promise.all([quoteById(db, quoteId), proposalOf(db, quoteId)]);
  if (!qt || !p?.page_html || !p.page_sha256) return { ok: false, reason: "closed", message: "This link no longer works." };
  const today = todayIn(deps.opts.timeZone);
  if (qt.status !== "sent" || (qt.valid_until && qt.valid_until < today)) return { ok: false, reason: "closed", message: "This is no longer open to sign." };
  const stale = { ok: false as const, reason: "stale" as const, message: `This ${deps.opts.word.toLowerCase()} was updated since you opened it. Review the latest version below, then sign.` };
  if (input.page !== p.page_sha256) return stale;
  // The page as the quote stands now: an edit since the page was stored (a
  // sent quote stays editable), or a page that failed to store, is not what
  // they read. The quote and its proposal must not change again before the lock.
  const [seen] = await db.sql<{ q: string; p: string }>`
    select q.updated_at::text as q, p.updated_at::text as p from quotes q join quote_proposals p on p.quote_id = q.id where q.id = ${quoteId}::bigint`;
  const current = await pageFor(db, quoteId, deps.opts);
  if (!seen || !current || current.sha !== p.page_sha256) {
    await storePage(db, quoteId, deps.opts).catch(() => {});
    return stale;
  }

  // The page as signed: the stored file with the signature drawn in, where Accept was.
  const signedAt = new Date();
  const asSigned = fillPage(p.page_html, { kind: "signed", name, when: signedWhen(signedAt, deps.opts), invoices: [], pay: null }, deps.opts.word);
  const out = await db.transaction([
    q`select status from quotes where id = ${quoteId}::bigint for update`,
    // Only the page they read, only while it is open: both checked behind the lock.
    q`insert into quote_signatures (quote_id, name, email, signed_at, ip, browser, page_html, page_sha256)
      select ${quoteId}::bigint, ${name}, qt.email, ${signedAt.toISOString()}::timestamptz, ${meta.ip?.slice(0, 64) ?? null}, ${meta.browser?.slice(0, 300) ?? null},
             ${asSigned}, ${await tokenHash(asSigned)}
      from quotes qt join quote_proposals p on p.quote_id = qt.id
      where qt.id = ${quoteId}::bigint and qt.status = 'sent' and (qt.valid_until is null or qt.valid_until >= ${today}::date)
        and p.page_sha256 = ${p.page_sha256} and qt.updated_at::text = ${seen.q} and p.updated_at::text = ${seen.p}
      on conflict do nothing
      returning quote_id`,
    q`update quotes set status = 'accepted', decided_at = now(), decided_by = ${ONLINE.accepted}, updated_by = ${name}, updated_at = now()
      where id = ${quoteId}::bigint and status = 'sent'
        and exists (select 1 from quote_signatures s where s.quote_id = ${quoteId}::bigint and s.signed_at = ${signedAt.toISOString()}::timestamptz)
      returning id`,
  ]);
  if (!out[2].length) {
    // Still open to sign: what changed under the lock was the quote or its page.
    const now = await quoteById(db, quoteId);
    return now?.status === "sent" ? stale : { ok: false, reason: "closed", message: "This is no longer open to sign." };
  }

  // After the signature commits: its deal won, then what signing does. Neither can undo it.
  await winFromQuotes(db, ONLINE.accepted).catch((e) => console.error(`quote ${quoteId}: winning its deal: ${e instanceof Error ? e.message : e}`));
  const accepted = await afterAccepted(db, (await quoteById(db, quoteId))!, ONLINE.accepted, deps).catch(async (e) => {
    const problem = `After ${qt.name ?? qt.email} signed ${qt.number}: ${e instanceof Error ? e.message : e}`;
    await taskFor(db, qt, problem, deps).catch(() => {});
    return { lines: [problem] } as Accepted;
  });
  return { ok: true, accepted };
}

/** The signer's confirmation: their copy's link, and the PDF where this runtime prints. Never throws. */
export async function confirmSignature(db: Db, quoteId: string, link: string, deps: AnswerDeps): Promise<Sent> {
  const qt = await quoteById(db, quoteId);
  const [sig] = await db.sql`select name, page_html from quote_signatures where quote_id = ${quoteId}::bigint`;
  if (!qt || !sig) return { status: "none", why: "nothing was signed" };
  const w = deps.opts.word;
  let pdf: Uint8Array | null = null;
  if (deps.print) pdf = await deps.print(sig.page_html).catch(() => null);
  const from = deps.opts.business ? ` with ${deps.opts.business}` : "";
  return deps.send({
    to: [qt.email],
    subject: `You signed ${w.toLowerCase()} ${qt.number}${from}`,
    text: [
      `Hello ${sig.name},`,
      "",
      `Thank you: you signed ${w.toLowerCase()} ${qt.number}${from} for ${formatMoney(qt.total_cents, qt.currency)}.`,
      "",
      `Your copy, with what happens next: ${link}`,
      ...(pdf ? ["", "It is attached as a PDF too."] : []),
      ...(deps.opts.business ? ["", deps.opts.business] : []),
    ].join("\n"),
    replyTo: qt.created_by,
    attachments: pdf ? [{ filename: `${w} ${qt.number}, signed.pdf`, content: pdf, contentType: "application/pdf" }] : undefined,
  });
}

/** The customer declined at the link: the quote declined, its deal lost with their reason. */
export async function declineProposal(db: Db, quoteId: string, input: { reason: unknown; note: unknown }, reasons: string[], deps: AnswerDeps): Promise<boolean> {
  const reason = typeof input.reason === "string" && [...reasons, "Other"].includes(input.reason) ? input.reason : "Other";
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
  const qt = await quoteById(db, quoteId);
  const today = todayIn(deps.opts.timeZone);
  if (!qt || qt.status !== "sent" || (qt.valid_until && qt.valid_until < today)) return false;
  const out = await db.transaction([
    q`update quotes set status = 'declined', decided_at = now(), decided_by = ${ONLINE.declined}, updated_by = ${ONLINE.declined}, updated_at = now()
      where id = ${quoteId}::bigint and status = 'sent' and (valid_until is null or valid_until >= ${today}::date) returning id`,
    q`update quote_proposals set decline_reason = ${reason}, decline_note = ${note || null}
      where quote_id = ${quoteId}::bigint and exists (select 1 from quotes where id = ${quoteId}::bigint and decided_by = ${ONLINE.declined})`,
  ]);
  if (!out[0].length) return false;
  if (qt.deal_id) {
    // Its deal is lost with their reason, if it is still open.
    const [lost] = await db.sql<{ key: string }>`
      select s.key from deal_stages s where s.kind = 'lost' and not s.archived
        and exists (select 1 from deals d join deal_stages ds on ds.key = d.stage where d.id = ${qt.deal_id}::bigint and ds.kind = 'open')
      order by s.position, s.key limit 1`;
    const why = note ? `${reason}: ${note}` : reason;
    if (lost) await setDealStage(db, qt.deal_id, lost.key, ONLINE.declined, why.slice(0, 200)).catch((e) => console.error(`quote ${quoteId}: losing its deal: ${e instanceof Error ? e.message : e}`));
  }
  return true;
}

/** The quote as its customer reads it, for Preview and the PDF: the signed copy once signed. */
export async function proposalDocument(db: Db, qt: Quote, opts: ProposalOpts): Promise<string> {
  const [sig] = await db.sql`select 1 from quote_signatures where quote_id = ${qt.id}::bigint`;
  const p = await proposalOf(db, qt.id);
  if (sig && p?.page_html) return fillPage(p.page_html, await signedState(db, qt.id, opts), opts.word);
  // A decided quote keeps the page it had; one still open is drawn as it stands.
  const html = isEditable(qt) || !p?.page_html ? (await pageFor(db, qt.id, opts))?.html ?? "" : p.page_html;
  return fillPage(html, { kind: "preview" }, opts.word);
}

/** What accepting it does, for the team, in a sentence (Mark accepted's page). */
export async function onAcceptSentence(db: Db, qt: Quote): Promise<string | null> {
  const p = await proposalOf(db, qt.id);
  if (!p || p.first_invoice === "none") return null;
  const full = await quoteById(db, qt.id);
  return full ? afterSign(p, full, await taxRates(db)).team.replace(/^When they sign: /, "Accepting it does this too: ") : null;
}
