// The owner's Twilio, on the machine and at the edge: the only file that
// knows Twilio. Everything else (the tables, the flows, the screens) talks
// to a `Provider`, so another provider is another file.
//
//   const tw = twilioFrom(envOf(c));            // a route
//   const tw = twilioFrom(process.env);         // a script on the machine
//   await tw.sendText({ from: "+15552010142", to: "+15550100199", body: "Hi" });
//
// The key never reaches the app: every call goes through the app's
// connections (data/gateway.ts), in dev and production alike, and the
// Account SID is the connection's account in list-connections.
// Every Twilio path names the account. The owner gives its SID when they
// connect Twilio (an agency's client: that client's subaccount), because a
// Standard key cannot read the Accounts resource to find it.
//
// Twilio has three hosts the CRM uses: api (numbers, texts, calls,
// recordings), messaging (messaging services, campaigns, toll-free
// verification) and trusthub (the business profile). The catalogue lists
// each as an endpoint of the one connection.
//
// Edge-safe: fetch only.
import { setting, type Env } from "../data/env";
import { gatewayFetch, gatewayReachable, listConnections } from "../data/gateway";
import { prettyPhone } from "./store";

export type Host = "api" | "messaging" | "trusthub" | "lookups";
const HOSTS: Record<Host, { slug: string }> = {
  api: { slug: "twilio" },
  messaging: { slug: "twilio-messaging" },
  trusthub: { slug: "twilio-trusthub" },
  lookups: { slug: "twilio-lookups" },
};

export type Params = Record<string, string | number | boolean | null | undefined | string[]>;

/** Twilio's own error (`code`, `message`, `more_info`), or Task & Tool's refusal (`refusal`). */
export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly refusal?: string,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

export type Call = <T = any>(method: "GET" | "POST" | "DELETE", host: Host, path: string, params?: Params) => Promise<T>;

/** Whether this runtime reaches the app's Twilio connection. */
export const twilioReachable = (env: Env): boolean => gatewayReachable(env);

/** Form fields as Twilio reads them: a list repeats its key. */
export function formEncode(params: Params): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => out.append(k, item));
    else out.append(k, String(v));
  }
  return out.toString();
}

/** The raw caller: one request to one of Twilio's hosts. */
function twilioCall(env: Env, fetchImpl: typeof fetch = fetch): Call {
  if (!twilioReachable(env)) {
    throw new Error(
      `No Twilio here: this runtime reaches no connections. Ask the owner: python3 ~/tools/taskandtool.py request-connection twilio --why "<what it is for>" --auth api_key`,
    );
  }
  return async (method, host, path, params) => {
    const form = params ? formEncode(params) : "";
    const target = path + (method !== "POST" && form ? (path.includes("?") ? "&" : "?") + form : "");
    const headers: Record<string, string> = {};
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    const init: RequestInit = { method, headers, body: method === "POST" ? form : undefined, signal: AbortSignal.timeout(20_000) };
    const res = await gatewayFetch(env, HOSTS[host].slug, target, init, fetchImpl);
    if (method === "DELETE" && res.status === 204) return null as never;
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: reported below */
    }
    const refusal = res.headers.get("x-tasktool-refusal");
    if (refusal) throw new TwilioError(`Task & Tool refused the call: ${body?.error ?? refusal}`, res.status, undefined, refusal);
    if (!res.ok) throw new TwilioError(body?.message ?? `Twilio answered ${res.status}`, res.status, body?.code);
    return body;
  };
}

// ---- the provider: what the rest of the skill asks of Twilio ----------------

export type AvailableNumber = { e164: string; pretty: string; locality: string | null; region: string | null };
export type OwnedNumber = { id: string; e164: string; pretty: string; label: string | null };
export type SentText = { id: string; status: string };
export type Hooks = { voice: string; sms: string; status: string; fallback?: string | null };
/** What the setup page says about the account. A Standard API key may not read the account itself, so name and trial can be unknown. */
export type Account = { sid: string; name: string | null; balance: string | null; currency: string | null; trial: boolean | null };

export type Provider = {
  account(): Promise<Account>;
  searchNumbers(q: { areaCode?: string; near?: string; tollFree?: boolean; limit?: number }): Promise<AvailableNumber[]>;
  ownedNumbers(): Promise<OwnedNumber[]>;
  buyNumber(e164: string, hooks: Hooks, label: string): Promise<OwnedNumber>;
  pointNumber(id: string, hooks: Hooks): Promise<void>;
  sendText(m: { from: string; to: string; body: string; statusUrl?: string | null }): Promise<SentText>;
  startCall(c: { from: string; to: string; twimlUrl: string; statusUrl?: string | null }): Promise<{ id: string }>;
  recording(sid: string): Promise<Response>;
  /** What kind of line a number is (Twilio Lookup's line type: mobile, landline, fixedVoip, ...), or null when Lookup can't say. */
  lineType(e164: string): Promise<string | null>;
  call: Call;
};

/** A recording's id as Twilio writes one (RE and 32 hex): it becomes a path on Twilio's API, so nothing else is kept or fetched. */
export const isRecordingSid = (v: unknown): v is string => typeof v === "string" && /^RE[0-9a-f]{32}$/.test(v);

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

/**
 * The account every Twilio path names: the connection's account in Task &
 * Tool's list, else `TWILIO_ACCOUNT_SID` where the owner put the key on the
 * machine.
 */
async function accountSidOf(env: Env, fetchImpl: typeof fetch): Promise<string> {
  let listed: Error | null = null;
  const c = await listConnections(env, fetchImpl)
    .then((l) => l.find((x) => x.slug === HOSTS.api.slug))
    .catch((e: Error) => void (listed = e));
  if (c?.account && ACCOUNT_SID.test(c.account)) return c.account;
  const bound = setting(env, "TWILIO_ACCOUNT_SID");
  if (bound && ACCOUNT_SID.test(bound)) return bound;
  // Task & Tool did not answer: say so, not that the connection is wrong.
  if (listed) throw new TwilioError(`Could not ask Task & Tool for the Twilio account: ${(listed as Error).message}`, 503);
  throw new TwilioError("The Twilio connection names no Account SID. Ask the owner to connect Twilio again, with its Account SID.", 409);
}

/** The owner's Twilio as a Provider. The account SID is found once per caller. */
export function twilioFrom(env: Env, fetchImpl: typeof fetch = fetch): Provider {
  const call = twilioCall(env, fetchImpl);
  let sid: Promise<string> | null = null;
  const accountSid = () =>
    (sid ??= accountSidOf(env, fetchImpl).catch((e) => {
      sid = null;
      throw e;
    }));
  const acct = async (rest: string) => `/2010-04-01/Accounts/${await accountSid()}${rest}`;
  const owned = (n: any): OwnedNumber => ({ id: n.sid, e164: n.phone_number, pretty: prettyPhone(n.phone_number), label: n.friendly_name ?? null });
  const hookParams = (h: Hooks): Params => ({
    VoiceUrl: h.voice, VoiceMethod: "POST", VoiceFallbackUrl: h.fallback ?? undefined, VoiceFallbackMethod: h.fallback ? "POST" : undefined,
    StatusCallback: h.status, StatusCallbackMethod: "POST", SmsUrl: h.sms, SmsMethod: "POST",
  });

  return {
    call,
    async account() {
      const s = await accountSid();
      // Each may be refused: a Standard key cannot read the account itself, and a subaccount has no balance of its own.
      const [a, bal] = await Promise.all([
        call<{ friendly_name: string; type: string }>("GET", "api", `/2010-04-01/Accounts/${s}.json`).catch(() => null),
        call<{ balance: string; currency: string }>("GET", "api", `/2010-04-01/Accounts/${s}/Balance.json`).catch(() => null),
      ]);
      return { sid: s, name: a?.friendly_name ?? null, balance: bal?.balance ?? null, currency: bal?.currency ?? null, trial: a ? a.type === "Trial" : null };
    },
    async searchNumbers(q) {
      const kind = q.tollFree ? "TollFree" : "Local";
      const r = await call("GET", "api", await acct(`/AvailablePhoneNumbers/US/${kind}.json`), {
        AreaCode: q.areaCode || undefined, InPostalCode: q.near || undefined, SmsEnabled: true, VoiceEnabled: true, PageSize: q.limit ?? 10,
      });
      return (r.available_phone_numbers ?? []).map((n: any) => ({ e164: n.phone_number, pretty: prettyPhone(n.phone_number), locality: n.locality || null, region: n.region || null }));
    },
    async ownedNumbers() {
      // Every page: Twilio's next_page_uri is the path of the next one.
      const all: OwnedNumber[] = [];
      let r = await call("GET", "api", await acct("/IncomingPhoneNumbers.json"), { PageSize: 100 });
      for (let pages = 0; ; pages++) {
        all.push(...(r.incoming_phone_numbers ?? []).map(owned));
        if (!r.next_page_uri || pages >= 20) return all;
        r = await call("GET", "api", r.next_page_uri);
      }
    },
    async buyNumber(e164, hooks, label) {
      return owned(await call("POST", "api", await acct("/IncomingPhoneNumbers.json"), { PhoneNumber: e164, FriendlyName: label, ...hookParams(hooks) }));
    },
    async pointNumber(id, hooks) {
      await call("POST", "api", await acct(`/IncomingPhoneNumbers/${id}.json`), hookParams(hooks));
    },
    async sendText(m) {
      const r = await call("POST", "api", await acct("/Messages.json"), { From: m.from, To: m.to, Body: m.body, StatusCallback: m.statusUrl ?? undefined });
      return { id: r.sid, status: r.status };
    },
    async startCall(c) {
      const r = await call("POST", "api", await acct("/Calls.json"), { From: c.from, To: c.to, Url: c.twimlUrl, Method: "POST", StatusCallback: c.statusUrl ?? undefined });
      return { id: r.sid };
    },
    async lineType(e164) {
      const r = await call("GET", "lookups", `/v2/PhoneNumbers/${encodeURIComponent(e164)}`, { Fields: "line_type_intelligence" }).catch(() => null);
      return typeof r?.line_type_intelligence?.type === "string" ? r.line_type_intelligence.type : null;
    },
    async recording(rsid) {
      // The id becomes a path on Twilio's API: only a recording's own shape is fetched.
      if (!isRecordingSid(rsid)) return new Response(null, { status: 404 });
      return gatewayFetch(env, HOSTS.api.slug, await acct(`/Recordings/${rsid}.mp3`), {}, fetchImpl);
    },
  };
}

let reach: { at: number; ok: boolean } | null = null;

/**
 * Whether this app reaches the owner's Twilio, asked (one of the account's
 * numbers, the cheapest call a Standard key may make) and kept five minutes, a no half a minute, so the setup
 * page turns over soon after the owner connects. Null when Twilio could not
 * be asked in 3 seconds: a page should neither claim it missing nor wait.
 */
export async function twilioConnected(env: Env, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  if (reach && Date.now() - reach.at < (reach.ok ? 300_000 : 30_000)) return reach.ok;
  let ok = false;
  if (twilioReachable(env)) {
    try {
      const quick: typeof fetch = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(3000) });
      await twilioCall(env, quick)("GET", "api", `/2010-04-01/Accounts/${await accountSidOf(env, quick)}/IncomingPhoneNumbers.json`, { PageSize: 1 });
      ok = true;
    } catch (e) {
      if (!(e instanceof TwilioError) || (!e.refusal && ![401, 403, 404, 409].includes(e.status))) return null;
    }
  }
  reach = { at: Date.now(), ok };
  return ok;
}

// ---- TwiML: what Twilio does on a call ---------------------------------------

// A form's name reaches the screening words: characters XML can't hold are dropped, or the TwiML breaks.
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const VOICE = 'voice="Polly.Joanna"';

export const twiml = {
  /** Ring `to` (the owner's cell); `screen` is the press-1 step on their leg; `action` hears how it went. */
  dial(o: { to: string; callerId: string; timeout: number; action: string; screen: string; greeting?: string | null; record?: boolean; recordingStatus?: string }) {
    const rec = o.record ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(o.recordingStatus ?? "")}"` : "";
    return doc(
      (o.greeting ? `<Say ${VOICE}>${esc(o.greeting)}</Say>` : "") +
        `<Dial timeout="${o.timeout}" action="${esc(o.action)}" method="POST" callerId="${esc(o.callerId)}" answerOnBridge="true"${rec}>` +
        `<Number url="${esc(o.screen)}" method="POST">${esc(o.to)}</Number></Dial>`,
    );
  },
  /** The owner's leg, before it connects: press 1 or the call is not theirs. */
  screen(o: { say: string; action: string }) {
    return doc(`<Gather numDigits="1" timeout="6" action="${esc(o.action)}" method="POST"><Say ${VOICE}>${esc(o.say)}</Say></Gather><Hangup/>`);
  },
  /** After the press: 1 connects (an empty answer), anything else hangs up the owner's leg. */
  accepted(pressed: boolean) {
    return pressed ? doc("") : doc("<Hangup/>");
  },
  /** Nobody took it: the greeting, then a voicemail of up to two minutes, transcribed. */
  voicemail(o: { say: string; action: string; transcribe: string; recordingStatus: string }) {
    return doc(
      `<Say ${VOICE}>${esc(o.say)}</Say>` +
        `<Record maxLength="119" playBeep="true" timeout="5" action="${esc(o.action)}" method="POST" transcribe="true" transcribeCallback="${esc(o.transcribe)}" recordingStatusCallback="${esc(o.recordingStatus)}"/>`,
    );
  },
  say(text: string) {
    return doc(`<Say ${VOICE}>${esc(text)}</Say><Hangup/>`);
  },
  hangup() {
    return doc("<Hangup/>");
  },
  /** Calling out from the CRM: once the owner's phone answers, ring the customer from the business number. */
  bridge(o: { to: string; callerId: string; action: string; record?: boolean; recordingStatus?: string }) {
    const rec = o.record ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(o.recordingStatus ?? "")}"` : "";
    return doc(`<Dial callerId="${esc(o.callerId)}" action="${esc(o.action)}" method="POST"${rec}><Number>${esc(o.to)}</Number></Dial>`);
  },
  /** An empty answer to a text: the CRM replies, if at all, through the API. */
  noReply() {
    return doc("");
  },
};

function doc(inner: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
