// US texting registration on the owner's own Twilio account. The owner is
// Twilio's "direct customer", and for a direct customer Twilio documents one
// path: its Console's onboarding (the business profile, the brand, the
// campaign; or, for a toll-free number, its verification). The API calls
// that create a brand or a campaign are documented only for software vendors
// registering other businesses, on a Secondary Customer Profile, so the CRM
// never makes them. It gives the owner the words to paste, in order, and
// reads each step's state back (`check`), which the setup page and the
// hourly job both call; all of that is read-only but one documented change:
// the Messaging Service holding the number is set to send its texts to the
// number's own webhook, which is ours.
//
// Local number (10DLC), read from:
//   profile   trusthub /v1/CustomerProfiles (twilio-approved, in-review, ...)
//   brand     messaging /v1/a2p/BrandRegistrations (PENDING, IN_REVIEW, APPROVED, FAILED, ...)
//   service   messaging /v1/Services, the one whose PhoneNumbers hold the number
//   campaign  that service's /Compliance/Usa2p (campaign_status PENDING, IN_PROGRESS, VERIFIED, FAILED)
// Toll-free: messaging /v1/Tollfree/Verifications for the number
// (PENDING_REVIEW, IN_REVIEW, TWILIO_APPROVED, TWILIO_REJECTED).
//
// The words are ours (docs/plans/crm-calls-and-texts-messages.md, "For the
// texting registration"). The name and the privacy and terms pages are the
// business's, set once (data/business.ts), and the texting box on the
// forms says the same (forms/consent.ts): reviewers check one against the
// other on the live form the words name (`optInPage`).
import type { Business } from "../data/business";
import type { Db } from "../data/db";
import { consentWords } from "../forms/consent";
import { stepsOf, type Field } from "../forms/fields";
import { fill, keywordReplies, MEASURE, type FlowKey, type FlowSettings } from "./flows";
import type { Links } from "./send";
import { saveRegistration, type PhoneNumber, type Registration } from "./store";
import { TwilioError, type Provider } from "./twilio";

export type Step = {
  key: "profile" | "brand" | "campaign" | "toll_free"; label: string; state: "done" | "waiting" | "failed" | "todo"; says: string; errors: string[];
  /** Where in Twilio's Console, said as its menus read. */
  where?: string;
  /** The words to paste into Twilio's form, field by field. */
  paste?: { field: string; words: string }[];
};

const TOLL_FREE = /^\+18(00|33|44|55|66|77|88)\d{7}$/;
/** A toll-free number is verified; any other US number is registered for 10DLC. */
export const routeOf = (e164: string): "local" | "toll_free" => (TOLL_FREE.test(e164) ? "toll_free" : "local");

/**
 * A public page with the texting box, for reviewers to open: the page on
 * the customers' site a customer last sent a following-up form from
 * (`submissions.page`), else a following-up form's own page
 * (`/forms/<key>/start`), else the booking page. Null while customers
 * can't open the pages, or none shows the box.
 */
export async function optInPage(db: Db, links: Links | null): Promise<string | null> {
  if (!links) return null;
  // A page is a path on the site that took it: the Website's ("website"), or the CRM's /q ("crm").
  const [used] = await db.sql<{ page: string }>`
    select s.page from submissions s join forms f on f.key = s.form_key
    where f.active and f.follow_up and s.page like '/%' and s.status <> 'spam'
      and s.source = ${links.prefix ? "crm" : "website"}
    order by s.created_at desc limit 1`.catch(() => []);
  if (used) return `${links.base}${used.page}`;
  const forms = await db.sql<{ key: string; fields: Field[] }>`
    select key, fields from forms where active and follow_up order by id`.catch(() => []);
  const own = forms.find((f) => stepsOf(f.fields ?? []).length);
  if (own) return `${links.base}${links.prefix}/forms/${own.key}/start`;
  const [t] = await db.sql`select 1 from booking_types where active limit 1`.catch(() => []);
  return t ? `${links.base}${links.prefix}/book` : null;
}

const LINK = /\bhttps?:\/\/\S|\bwww\.\S|\b[a-z0-9-]+\.(com|net|org|co|us|io|biz|info|link|me)\b/i;
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

/**
 * The registration's words: what the business texts, how people agree (at
 * `optIn`, the page reviewers open), samples, whether texts carry links or
 * phone numbers, and the keyword replies. The samples and those two answers
 * are the texts as they are now (`settings`: the owner's words, on flows
 * that are on), since carriers turn down a campaign whose answers its
 * samples don't show (Twilio 30889): a text with a link, or a number, is
 * one of the samples.
 */
export function registrationWords(business: string, number: string, pages: Pick<Business, "privacyUrl" | "termsUrl">, optIn: string | null, settings: Record<FlowKey, FlowSettings>) {
  const filled = (words: string) => fill(words, { ...MEASURE, business });
  const texts = (Object.entries(settings) as [FlowKey, FlowSettings][]).filter(([, s]) => s.enabled).flatMap(([, s]) => Object.values(s.words)).map(filled);
  const withLink = texts.find((t) => LINK.test(t));
  const withPhone = texts.find((t) => PHONE.test(t));
  const samples = [filled(settings.missed_call.words.one), filled(settings.booked.words.one), filled(settings.reminder.words.one)];
  // A campaign takes up to five: a text with what the three don't show joins them.
  for (const [t, re] of [[withPhone, PHONE], [withLink, LINK]] as const) if (t && !samples.some((s) => re.test(s))) samples.push(t);
  const keywords = keywordReplies(business, number);
  return {
    description: `${business} texts customers who contact us, call us or book with us: replies to their requests, booking confirmations, reminders the day before a visit and a thank-you after it. No marketing.`,
    messageFlow: `Customers give their number on our website forms and booking page${optIn ? ` (for example ${optIn})` : ""}, with a box (unticked by default, never required) that reads: '${consentWords(business, "request", pages)}' Callers who call our number get one reply to their call, and a confirmation and reminder for a visit booked on that call. Customers can also text our number first.`,
    samples,
    links: !!withLink,
    phones: !!withPhone,
    keywords,
  };
}

const errorsOf = (r: any): string[] =>
  Array.isArray(r?.errors) && r.errors.length ? r.errors.map((e: any) => (typeof e === "string" ? e : e?.description ?? e?.message ?? (e?.code ? `Twilio error ${e.code}` : JSON.stringify(e)))).slice(0, 5)
  : r?.failure_reason ? [String(r.failure_reason)] : [];

/** Read where the registration is, as Twilio has it now, and keep it. Safe to call any time. */
export async function check(db: Db, tw: Provider, n: PhoneNumber): Promise<{ texting: PhoneNumber["texting"]; reg: Registration }> {
  const reg: Registration = { ...(n.registration ?? {}), route: routeOf(n.e164) };
  delete reg.last_error;
  let texting: PhoneNumber["texting"] = n.texting;
  try {
    // Read into a copy, so a read that fails halfway keeps the last full one.
    const read: Registration = { ...reg };
    texting = reg.route === "toll_free" ? await tollFree(tw, n, read) : await local(tw, n, read);
    Object.assign(reg, read);
  } catch (e) {
    reg.last_error = e instanceof TwilioError ? `Twilio: ${e.message}` : e instanceof Error ? e.message : String(e);
  }
  reg.checked_at = new Date().toISOString();
  await saveRegistration(db, n.id, texting, reg);
  return { texting, reg };
}

const pick = (list: any[], good: string, waiting: string[]) => list.find((x) => x.status === good) ?? list.find((x) => waiting.includes(x.status)) ?? list[0];

async function local(tw: Provider, n: PhoneNumber, reg: Registration): Promise<PhoneNumber["texting"]> {
  const profiles: any[] = (await tw.call("GET", "trusthub", "/v1/CustomerProfiles", { PageSize: 50 })).results ?? [];
  const p = pick(profiles, "twilio-approved", ["in-review", "pending-review"]);
  reg.profile = p ? { sid: p.sid, status: p.status, errors: errorsOf(p) } : { status: "missing", errors: [] };

  const brands: any[] = (await tw.call("GET", "messaging", "/v1/a2p/BrandRegistrations", { PageSize: 50 })).data ?? [];
  const b = pick(brands, "APPROVED", ["PENDING", "IN_REVIEW"]);
  reg.brand = b ? { sid: b.sid, status: b.status, errors: errorsOf(b) } : undefined;

  // The Messaging Service the number is in, and that service's campaign.
  reg.service = undefined;
  reg.campaign = undefined;
  const services: any[] = (await tw.call("GET", "messaging", "/v1/Services", { PageSize: 50 })).services ?? [];
  for (const s of services) {
    const nums: any[] = (await tw.call("GET", "messaging", `/v1/Services/${s.sid}/PhoneNumbers`, { PageSize: 50 })).phone_numbers ?? [];
    if (!nums.some((x) => x.sid === n.provider_id)) continue;
    // Texts to the number come to this app, not to a webhook the service has of its own.
    if (s.use_inbound_webhook_on_number !== true) await tw.call("POST", "messaging", `/v1/Services/${s.sid}`, { UseInboundWebhookOnNumber: true });
    reg.service = { sid: s.sid, name: s.friendly_name ?? null };
    const campaigns: any[] = (await tw.call("GET", "messaging", `/v1/Services/${s.sid}/Compliance/Usa2p`, { PageSize: 20 })).compliance ?? [];
    const c = campaigns.find((x) => x.campaign_status === "VERIFIED") ?? campaigns[0];
    if (c) reg.campaign = { sid: c.sid, status: c.campaign_status, errors: errorsOf(c) };
    break;
  }

  if (reg.campaign?.status === "VERIFIED") return "approved";
  if (reg.profile.status === "twilio-rejected" || reg.brand?.status === "FAILED" || reg.brand?.status === "SUSPENDED" || reg.campaign?.status === "FAILED") return "failed";
  if (reg.brand || reg.campaign || reg.profile.status === "in-review" || reg.profile.status === "pending-review") return "pending";
  return "none";
}

async function tollFree(tw: Provider, n: PhoneNumber, reg: Registration): Promise<PhoneNumber["texting"]> {
  const list: any[] = (await tw.call("GET", "messaging", "/v1/Tollfree/Verifications", { TollfreePhoneNumberSid: n.provider_id, PageSize: 20 })).verifications ?? [];
  const v = pick(list, "TWILIO_APPROVED", ["PENDING_REVIEW", "IN_REVIEW"]);
  reg.toll_free = v
    ? {
        sid: v.sid, status: v.status,
        errors: [v.rejection_reason, ...(v.rejection_reasons ?? []).map((x: any) => x?.reason ?? x)].filter(Boolean),
        edit_until: v.edit_allowed && v.edit_expiration ? v.edit_expiration : null,
      }
    : undefined;
  if (v?.status === "TWILIO_APPROVED") return "approved";
  if (v?.status === "TWILIO_REJECTED") return "failed";
  return v ? "pending" : "none";
}

/** The rows the setup page shows: each step's state in a sentence, where in Twilio's Console, and the words to paste. */
export function steps(n: PhoneNumber, business: Business, optIn: string | null, settings: Record<FlowKey, FlowSettings>): Step[] {
  const r = n.registration ?? {};
  const err = (x?: { errors?: string[] }) => x?.errors ?? [];
  const w = registrationWords(business.name ?? "us", n.e164, business, optIn, settings);
  const pages = [
    ...(optIn ? [{ field: "Opt-in page (where customers tick the box)", words: optIn }] : []),
    ...(business.privacyUrl ? [{ field: "Privacy policy URL", words: business.privacyUrl }] : []),
    ...(business.termsUrl ? [{ field: "Terms and conditions URL", words: business.termsUrl }] : []),
  ];
  if (routeOf(n.e164) === "toll_free") {
    const s = r.toll_free?.status;
    return [{
      key: "toll_free", label: "Toll-free verification",
      state: s === "TWILIO_APPROVED" ? "done" : s === "TWILIO_REJECTED" ? "failed" : s ? "waiting" : "todo",
      says: s === "TWILIO_APPROVED" ? "Approved: your number can text."
        : s === "TWILIO_REJECTED" ? (r.toll_free?.edit_until ? `Twilio turned it down. Fix what it says in the Console and send it again before ${r.toll_free.edit_until.slice(0, 10)}.` : "Twilio turned it down. Fix what it says and send a new verification in the Console.")
        : s ? "Twilio is reviewing it. This usually takes 3 to 5 business days."
        : "Free. Have your legal business name, EIN, address and a screenshot of a form with its texting box ready.",
      where: "Twilio Console: Phone Numbers, your number, Regulatory Information, toll-free verification",
      paste: s === "TWILIO_APPROVED" ? undefined : [
        { field: "Use case categories", words: "Account notifications, Customer care" },
        { field: "Use case summary", words: w.description },
        { field: "Sample message", words: w.samples[0] },
        { field: "Opt-in type", words: "Web form" },
        { field: "How customers opt in", words: w.messageFlow },
        { field: "Help message", words: w.keywords.help },
        ...pages,
      ],
      errors: err(r.toll_free),
    }];
  }
  const p = r.profile?.status, b = r.brand?.status, c = r.campaign?.status;
  const approved = c === "VERIFIED";
  return [
    {
      key: "profile", label: "1. Business profile",
      state: p === "twilio-approved" ? "done" : p === "twilio-rejected" ? "failed" : p && p !== "missing" && p !== "draft" ? "waiting" : "todo",
      says: p === "twilio-approved" ? "Approved." : p === "twilio-rejected" ? "Twilio turned it down. Fix it in the Console and submit it again." : p === "in-review" || p === "pending-review" ? "Twilio is reviewing your business. It can take 3 days." : "Your legal name, EIN, address, website and an authorised person.",
      where: "Twilio Console: Messaging, Regulatory Compliance, Onboarding (Create Customer Profile)",
      errors: err(r.profile),
    },
    {
      key: "brand", label: "2. Brand",
      state: b === "APPROVED" ? "done" : b === "FAILED" || b === "SUSPENDED" ? "failed" : b ? "waiting" : "todo",
      says: b === "APPROVED" ? "Approved." : b === "FAILED" ? "Twilio turned it down: fix what it says in the Console." : b === "SUSPENDED" ? "Twilio suspended it: see why in the Console." : b ? "Twilio is checking your brand. Usually minutes, sometimes a week." : "Low-Volume Standard suits most small businesses (under 6,000 texts a day); Standard costs more and allows more.",
      where: "Twilio Console: Messaging, Regulatory Compliance, Onboarding (Register Brand)",
      errors: err(r.brand),
    },
    {
      key: "campaign", label: "3. Campaign",
      state: approved ? "done" : c === "FAILED" ? "failed" : c ? "waiting" : "todo",
      says: approved ? `Approved: your number can text${r.service?.name ? ` (Messaging Service "${r.service.name}")` : ""}.` : c === "FAILED" ? "The carriers turned it down: fix what it says in the Console." : c ? "The carriers are reviewing it. Twilio says 10 to 15 days." : "Choose the use case Mixed, make a Messaging Service, and add this number to it.",
      where: "Twilio Console: Messaging, Regulatory Compliance, Onboarding (Campaign Registration)",
      paste: approved ? undefined : [
        { field: "Campaign use case", words: "Mixed" },
        { field: "Campaign description", words: w.description },
        ...w.samples.map((words, i) => ({ field: `Sample message ${i + 1}`, words })),
        { field: "How do end-users consent to receive messages?", words: w.messageFlow },
        { field: "Messages will include embedded links", words: w.links ? "Yes" : "No" },
        { field: "Messages will include phone numbers", words: w.phones ? "Yes" : "No" },
        { field: "Opt-in message", words: w.keywords.start },
        { field: "Opt-out message", words: w.keywords.stop },
        { field: "Help message", words: w.keywords.help },
        ...pages,
      ],
      errors: err(r.campaign),
    },
  ];
}
