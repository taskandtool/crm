// The rows: the business's numbers, and every text and call on them. A
// thread is the rows for one remote number (its last ten digits); whose it
// is comes from the customers who have that number. Edge-safe.
import type { Db } from "../data/db";
import { phoneKey } from "../customers/customer";

export type PhoneNumber = {
  id: string;
  e164: string;
  label: string;
  provider: string;
  provider_id: string;
  ring_to: string | null;
  ring_seconds: number;
  voicemail: boolean;
  record_calls: boolean;
  texting: "none" | "pending" | "approved" | "failed";
  registration: Registration;
  hook_secret_hash: string;
  hooks_url: string | null;
};

/** What the CRM last read of the US texting registration (the owner makes it in Twilio's Console; registration.ts). */
export type Registration = {
  route?: "local" | "toll_free";
  profile?: { sid?: string; status?: string; errors?: string[] };
  brand?: { sid?: string; status?: string; errors?: string[] };
  /** The Messaging Service the number is in. */
  service?: { sid?: string; name?: string | null };
  campaign?: { sid?: string; status?: string; errors?: string[] };
  /** `edit_until`: a turned-down verification can be fixed and sent again until then. */
  toll_free?: { sid?: string; status?: string; errors?: string[]; edit_until?: string | null };
  /** The owner's privacy and terms pages: the texting box links them, and the registration names them. */
  input?: { privacyUrl?: string | null; termsUrl?: string | null };
  checked_at?: string;
  /** The last call that failed, in Twilio's words. */
  last_error?: string;
};

export type Communication = {
  id: string;
  phone_number_id: string | null;
  local_e164: string;
  remote_e164: string;
  remote_key: string;
  contact_id: string | null;
  kind: "text" | "call";
  direction: "in" | "out";
  status: string;
  body: string | null;
  media: { url: string; type: string }[];
  keyword: "stop" | "start" | "help" | null;
  sent_by: string | null;
  duration_s: number | null;
  answered_by: string | null;
  voicemail_sid: string | null;
  voicemail_s: number | null;
  transcript: string | null;
  recording_sid: string | null;
  error: string | null;
  provider_id: string | null;
  read_at: Date | null;
  created_at: Date;
};

const toNumber = (r: Record<string, any>): PhoneNumber => ({ ...r, id: String(r.id), registration: r.registration ?? {} }) as PhoneNumber;
const toComm = (r: Record<string, any>): Communication =>
  ({ ...r, id: String(r.id), phone_number_id: r.phone_number_id == null ? null : String(r.phone_number_id), contact_id: r.contact_id == null ? null : String(r.contact_id) }) as Communication;

/**
 * A phone as typed, in E.164, or null. US and Canada numbers may leave off
 * the +1; anything else must start with +.
 */
export function toE164(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s*(?:ext|extension|x|#)[.:\s]*[0-9]+\s*$/i, "");
  const d = s.replace(/[^0-9]/g, "");
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** How a number reads: (555) 201-0142 in North America, else as stored. */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

// ---- numbers -------------------------------------------------------------------

export async function numbers(db: Db): Promise<PhoneNumber[]> {
  const rows = await db.sql`select * from phone_numbers order by id`;
  return rows.map(toNumber);
}

/** The business number: the first one bought. */
export async function mainNumber(db: Db): Promise<PhoneNumber | null> {
  const [r] = await db.sql`select * from phone_numbers order by id limit 1`;
  return r ? toNumber(r) : null;
}

export async function numberById(db: Db, id: string): Promise<PhoneNumber | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [r] = await db.sql`select * from phone_numbers where id = ${id}::bigint`;
  return r ? toNumber(r) : null;
}

/** A number on the account, kept: its hooks are pointed at this app after (setup.ts). */
export async function addNumber(db: Db, n: { e164: string; label: string; provider_id: string; ring_to: string | null }, by: string): Promise<PhoneNumber> {
  const [r] = await db.sql`
    insert into phone_numbers (e164, label, provider_id, ring_to, hook_secret_hash, created_by)
    values (${n.e164}, ${n.label}, ${n.provider_id}, ${n.ring_to}, '', ${by}::citext)
    on conflict (e164) do update set provider_id = excluded.provider_id, updated_at = now()
    returning *`;
  return toNumber(r);
}

/** The number's webhook address and the hash of the secret in it. */
export async function setHooks(db: Db, id: string, hooksUrl: string, secretHash: string): Promise<void> {
  await db.sql`update phone_numbers set hooks_url = ${hooksUrl}, hook_secret_hash = ${secretHash}, updated_at = now() where id = ${id}::bigint`;
}

export async function removeNumber(db: Db, id: string): Promise<void> {
  await db.sql`delete from phone_numbers where id = ${id}::bigint`;
}

export type CallSettings = { label: string; ring_to: string | null; ring_seconds: number; voicemail: boolean; record_calls: boolean };

export async function saveCallSettings(db: Db, id: string, s: CallSettings): Promise<void> {
  await db.sql`
    update phone_numbers set label = ${s.label}, ring_to = ${s.ring_to}, ring_seconds = ${s.ring_seconds}, voicemail = ${s.voicemail},
      record_calls = ${s.record_calls}, updated_at = now()
    where id = ${id}::bigint`;
}

export async function saveRegistration(db: Db, id: string, texting: PhoneNumber["texting"], reg: Registration): Promise<void> {
  await db.sql`update phone_numbers set texting = ${texting}, registration = ${JSON.stringify(reg)}::jsonb, updated_at = now() where id = ${id}::bigint`;
}

/** The business number, once Twilio has approved it for texting. */
export async function canText(db: Db): Promise<PhoneNumber | null> {
  const n = await mainNumber(db);
  return n && n.texting === "approved" ? n : null;
}

// ---- whose number --------------------------------------------------------------

export type Match = { id: string; name: string };

/** The customers who have this number (by its last ten digits), the live ones first; at most five. */
async function contactsFor(db: Db, key: string): Promise<Match[]> {
  return db.sql<Match>`
    select id::text as id, name from customers
    where right(regexp_replace(regexp_replace(phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key}
    order by archived_at nulls first, updated_at desc
    limit 5`;
}

/**
 * Whose a number is: the contact already chosen on its thread, else the one
 * customer with it. Several and none chosen: null, and a person picks.
 */
export async function ownerOf(db: Db, key: string): Promise<{ contact: Match | null; choices: Match[] }> {
  const [chosen] = await db.sql<Match>`
    select c.id::text as id, c.name from communications m join customers c on c.id = m.contact_id
    where m.remote_key = ${key} order by m.created_at desc limit 1`;
  const choices = await contactsFor(db, key);
  if (chosen) return { contact: chosen, choices };
  return { contact: choices.length === 1 ? choices[0] : null, choices };
}

/** A person chose whose this number is: every row on it, from now on too (new rows read the latest). */
export async function setThreadContact(db: Db, key: string, contactId: string | null): Promise<void> {
  await db.sql`update communications set contact_id = ${contactId}::bigint, updated_at = now() where remote_key = ${key}`;
}

// ---- texts and calls -----------------------------------------------------------

export type NewCommunication = {
  phoneNumberId: string | null;
  local: string;
  remote: string;
  kind: "text" | "call";
  direction: "in" | "out";
  status: string;
  body?: string | null;
  media?: { url: string; type: string }[];
  /** STOP, START or HELP, or 'stop' for a send Twilio refused because they opted out (21610). */
  keyword?: Communication["keyword"];
  sentBy?: string | null;
  providerId?: string | null;
  contactId?: string | null;
  read?: boolean;
};

/**
 * One text or call, once: a webhook Twilio sends twice is one row (its id is
 * unique). Whose it is: given, or ownerOf's answer.
 */
/** Kept once per Twilio id; `inserted` is false when this id was already kept (a webhook delivered twice). */
export async function record(db: Db, n: NewCommunication): Promise<Communication & { inserted: boolean }> {
  const key = phoneKey(n.remote) ?? n.remote.replace(/[^0-9]/g, "").slice(-10);
  const contact = n.contactId ?? (await ownerOf(db, key)).contact?.id ?? null;
  const [r] = await db.sql`
    with ins as (
      insert into communications (phone_number_id, local_e164, remote_e164, remote_key, contact_id, kind, direction, status, body, media, keyword, sent_by, provider_id, read_at)
      values (${n.phoneNumberId}::bigint, ${n.local}, ${n.remote}, ${key}, ${contact}::bigint, ${n.kind}, ${n.direction}, ${n.status},
              ${n.body ?? null}, ${JSON.stringify(n.media ?? [])}::jsonb, ${n.keyword ?? null}, ${n.sentBy ?? null}, ${n.providerId ?? null},
              ${n.direction === "out" || n.read ? new Date().toISOString() : null}::timestamptz)
      on conflict (provider, provider_id) where provider_id is not null do nothing
      returning *)
    select *, true as inserted from ins
    union all
    select *, false from communications where provider = 'twilio' and provider_id = ${n.providerId ?? null} and ${n.providerId ?? null}::text is not null
    limit 1`;
  if (r) return { ...toComm(r), inserted: !!r.inserted };
  // The same id kept at this moment by another request: this statement's snapshot is older than its commit.
  const kept = await byProviderId(db, n.providerId ?? "");
  if (!kept) throw new Error(`communication ${n.providerId} was neither kept nor found`);
  return { ...kept, inserted: false };
}

/** The owner texted the business number: whether to answer them now (once an hour at most), marking it so. */
export async function ownerReplyDue(db: Db, numberId: string): Promise<boolean> {
  const rows = await db.sql`
    update phone_numbers set owner_replied_at = now()
    where id = ${numberId}::bigint and (owner_replied_at is null or owner_replied_at < now() - interval '1 hour') returning id`;
  return rows.length > 0;
}

export async function byProviderId(db: Db, providerId: string): Promise<Communication | null> {
  const [r] = await db.sql`select * from communications where provider = 'twilio' and provider_id = ${providerId}`;
  return r ? toComm(r) : null;
}

export async function communicationById(db: Db, id: string): Promise<Communication | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [r] = await db.sql`select * from communications where id = ${id}::bigint`;
  return r ? toComm(r) : null;
}

/** A text's delivery, or a call's end, as Twilio reports it; never back to an earlier state. */
/** Twilio's 21610: the person texted STOP to this number or its messaging service, perhaps before the app knew it. */
export const OPTED_OUT = 21610;

/**
 * A text's or a call's new state, as Twilio reports it. A text refused with
 * 21610 is kept as their STOP, so nothing more is tried (optedOut).
 */
export async function updateStatus(db: Db, providerId: string, u: { status: string; error?: string | null; durationS?: number | null; answeredBy?: string | null; errorCode?: number | null }): Promise<Communication | null> {
  const [r] = await db.sql`
    update communications set
      keyword = case when ${u.errorCode ?? null}::integer = ${OPTED_OUT} then 'stop' else keyword end,
      status = case when status in ('delivered', 'undelivered', 'failed', 'read') and ${u.status} in ('queued', 'sending', 'sent', 'accepted') then status else ${u.status} end,
      error = coalesce(${u.error ?? null}, error),
      duration_s = coalesce(${u.durationS ?? null}::integer, duration_s),
      answered_by = coalesce(${u.answeredBy ?? null}, answered_by),
      updated_at = now()
    where provider = 'twilio' and provider_id = ${providerId}
    returning *`;
  return r ? toComm(r) : null;
}

export async function attachVoicemail(db: Db, callSid: string, v: { recordingSid?: string | null; seconds?: number | null; transcript?: string | null }): Promise<Communication | null> {
  const [r] = await db.sql`
    update communications set voicemail_sid = coalesce(${v.recordingSid ?? null}, voicemail_sid), voicemail_s = coalesce(${v.seconds ?? null}::integer, voicemail_s),
      transcript = coalesce(${v.transcript ?? null}, transcript), read_at = case when ${v.recordingSid ?? null}::text is distinct from coalesce(voicemail_sid, '') and ${v.recordingSid ?? null}::text is not null then null else read_at end, updated_at = now()
    where provider = 'twilio' and provider_id = ${callSid}
    returning *`;
  return r ? toComm(r) : null;
}

export async function attachRecording(db: Db, callSid: string, recordingSid: string): Promise<void> {
  await db.sql`update communications set recording_sid = ${recordingSid}, updated_at = now() where provider = 'twilio' and provider_id = ${callSid}`;
}

/** Whether a number has said STOP more recently than START, or its contact is marked Don't text. */
export async function optedOut(db: Db, key: string): Promise<boolean> {
  const [r] = await db.sql<{ out: boolean }>`
    select coalesce((select keyword = 'stop' from communications where remote_key = ${key} and keyword in ('stop', 'start') order by created_at desc, id desc limit 1), false)
        or exists (select 1 from customers where texts_off and right(regexp_replace(regexp_replace(phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key}) as out`;
  return r.out;
}

/** Whether this number reached the business first: it called or texted. */
export async function reachedUs(db: Db, key: string): Promise<boolean> {
  const [r] = await db.sql<{ yes: boolean }>`select exists (select 1 from communications where remote_key = ${key} and direction = 'in') as yes`;
  return r.yes;
}

/** Whether the business has texted this number before: the first text carries the STOP line. */
/** Whether this number had a text from the business in the last 30 days: past that, the STOP line is said again (CTIA). */
export async function textedBefore(db: Db, key: string): Promise<boolean> {
  const [r] = await db.sql<{ yes: boolean }>`
    select exists (select 1 from communications where remote_key = ${key} and kind = 'text' and direction = 'out'
                     and status not in ('failed', 'undelivered') and created_at > now() - interval '30 days') as yes`;
  return r.yes;
}

// ---- Messages: threads ---------------------------------------------------------

export type Thread = {
  remote_key: string;
  remote_e164: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_owner: string | null;
  last_kind: "text" | "call";
  last_direction: "in" | "out";
  last_body: string | null;
  last_status: string;
  last_voicemail: boolean;
  last_at: Date;
  unread: number;
};

/**
 * Every number's thread, newest first: `unread` only, `q` a name or number,
 * `mine` threads whose contact is the user's or no one's. Keyset on `before`.
 */
export async function threads(db: Db, o: { unread?: boolean; q?: string | null; mine?: string | null; before?: Date | null; limit?: number } = {}): Promise<Thread[]> {
  const q = o.q?.trim() || null;
  const digits = q ? q.replace(/[^0-9]/g, "") : "";
  return db.sql<Thread>`
    with last as (
      select distinct on (remote_key) remote_key, remote_e164, contact_id, kind as last_kind, direction as last_direction, body as last_body,
             status as last_status, voicemail_sid is not null as last_voicemail, created_at as last_at
      from communications order by remote_key, created_at desc, id desc),
    counts as (select remote_key, count(*)::int as unread from communications where direction = 'in' and read_at is null group by remote_key)
    -- Whose it is: the contact chosen on the thread, else the one customer with that number (ownerOf's rule).
    select l.remote_key, l.remote_e164, coalesce(l.contact_id, m.id)::text as contact_id, c.name as contact_name, c.owner::text as contact_owner,
           l.last_kind, l.last_direction, l.last_body, l.last_status, l.last_voicemail, l.last_at, coalesce(n.unread, 0) as unread
    from last l
    left join lateral (
      select min(x.id) as id from customers x
      where right(regexp_replace(regexp_replace(x.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = l.remote_key
      having count(*) = 1) m on l.contact_id is null
    left join customers c on c.id = coalesce(l.contact_id, m.id)
    left join counts n on n.remote_key = l.remote_key
    where (${!!o.unread} = false or coalesce(n.unread, 0) > 0)
      and (${q}::text is null or c.name ilike '%' || ${q} || '%' or (${digits} <> '' and l.remote_key like '%' || ${digits} || '%'))
      and (${o.mine ?? null}::text is null or c.owner is null or c.owner = ${o.mine ?? null}::citext)
      and (${o.before?.toISOString() ?? null}::timestamptz is null or l.last_at < ${o.before?.toISOString() ?? null}::timestamptz)
    order by l.last_at desc
    limit ${o.limit ?? 50}`;
}

/** The unread conversations a user sees counted: theirs, nobody's, and unknown numbers (Podium's rule). */
export async function unreadThreads(db: Db, user: string): Promise<number> {
  const [r] = await db.sql<{ n: number }>`
    select count(distinct m.remote_key)::int as n from communications m left join customers c on c.id = m.contact_id
    where m.direction = 'in' and m.read_at is null and (c.owner is null or c.owner = ${user}::citext)`;
  return r.n;
}

/** One number's rows, oldest first: the latest `limit`. */
export async function thread(db: Db, key: string, limit = 200): Promise<Communication[]> {
  const rows = await db.sql`
    select * from (select * from communications where remote_key = ${key} order by created_at desc, id desc limit ${limit}) t order by created_at, id`;
  return rows.map(toComm);
}

/** A contact's rows, any number of theirs, newest first. */
export async function contactCommunications(db: Db, contactId: string, limit = 50): Promise<Communication[]> {
  const rows = await db.sql`select * from communications where contact_id = ${contactId}::bigint order by created_at desc, id desc limit ${limit}`;
  return rows.map(toComm);
}

/** Opening a thread reads it for everyone, as Jobber's shared read state. */
export async function markRead(db: Db, key: string): Promise<void> {
  await db.sql`update communications set read_at = now() where remote_key = ${key} and direction = 'in' and read_at is null`;
}

/** Mark unread: its latest text or call that came in counts as new again. */
export async function markUnread(db: Db, key: string): Promise<void> {
  await db.sql`
    update communications set read_at = null
    where id = (select id from communications where remote_key = ${key} and direction = 'in' order by created_at desc, id desc limit 1)`;
}

/** Someone has Messages open (its list, a thread, or the thread's ten-second refresh). */
export async function seeMessages(db: Db, user: string): Promise<void> {
  await db.sql`insert into messages_seen (email, seen_at) values (${user}::citext, now()) on conflict (email) do update set seen_at = excluded.seen_at`;
}

/** When anyone last had Messages open: the owner's cell is told of a text only when nobody has for ten minutes. */
export async function lastSeenMessages(db: Db): Promise<Date | null> {
  const [r] = await db.sql<{ at: Date | null }>`select max(seen_at) as at from messages_seen`;
  return r.at;
}

/** Calls missed and not yet answered by a call or a text back, newest first: Home's list. */
export async function missedCalls(db: Db, limit = 10): Promise<(Communication & { contact_name: string | null })[]> {
  const rows = await db.sql`
    select m.*, c.name as contact_name from communications m left join customers c on c.id = m.contact_id
    where m.kind = 'call' and m.direction = 'in' and m.answered_by is null and m.status <> 'ringing'
      and m.created_at > now() - interval '14 days'
      and not exists (select 1 from communications o where o.remote_key = m.remote_key and o.direction = 'out' and o.created_at > m.created_at and (o.kind = 'call' or o.sent_by not like 'flow:%'))
    order by m.created_at desc limit ${limit}`;
  return rows.map((r) => ({ ...toComm(r), contact_name: r.contact_name ?? null }));
}

/** This week's calls in: answered and missed, for Home. */
export async function callWeek(db: Db, since: Date): Promise<{ answered: number; missed: number }> {
  const [r] = await db.sql<{ answered: number; missed: number }>`
    select count(*) filter (where answered_by is not null)::int as answered, count(*) filter (where answered_by is null)::int as missed
    from communications where kind = 'call' and direction = 'in' and created_at >= ${since.toISOString()}::timestamptz`;
  return r;
}
