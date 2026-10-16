// Setting a number up: the app's inbound address for Twilio, buying or
// choosing a number and pointing its calls and texts here, and calling a
// customer from the CRM. The inbound address is minted by Task & Tool from
// the machine (`inboundUrl`), so a number is chosen from the team's address,
// which the machine serves; it is kept on the number for later.
import type { Db } from "../data/db";
import { setting, type Env } from "../data/env";
import { newToken, tokenHash } from "../data/token";
import { addNumber, record, removeNumber, setHooks, toE164, type PhoneNumber } from "./store";
import type { Hooks, Provider } from "./twilio";

/** The app's inbound address for Twilio's webhooks (`https://hooks.<zone>/<token>/hooks/twilio`), from Task & Tool. Machine only. */
export async function inboundUrl(env: Env, doFetch: typeof fetch = fetch): Promise<{ ok: true; url: string } | { ok: false; why: string }> {
  const set = setting(env, "TWILIO_HOOKS_URL");
  if (set) return { ok: true, url: set.replace(/\/+$/, "") };
  const base = setting(env, "PHOENIX_URL");
  const token = setting(env, "MACHINE_TOKEN");
  if (!base || !token) return { ok: false, why: "Choose the number from the CRM's team address: only the machine can ask Task & Tool for the webhook address." };
  try {
    const res = await doFetch(`${base.replace(/\/+$/, "")}/api/machine/inbound-url`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: "/hooks/twilio" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !body.url) return { ok: false, why: body.error === "inbound_not_configured" ? "Task & Tool has no webhook route set up here yet." : `Task & Tool didn't give a webhook address (${body.error ?? res.status}).` };
    return { ok: true, url: body.url.replace(/\/+$/, "") };
  } catch (e) {
    return { ok: false, why: `Task & Tool didn't answer: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * A number's webhook addresses: calls and texts carry its secret as
 * basic-auth credentials, and retry a slow start; the status reports name
 * what they are about. The
 * fallback, when the app can't answer a call, only rings the owner's cell.
 */
function hooksFor(base: string, numberId: string, secret: string | null, ringTo: string | null): Hooks {
  const withSecret = (path: string) => {
    const u = new URL(`${base}/${path}`);
    if (secret) {
      u.username = "tw";
      u.password = secret;
    }
    u.searchParams.set("n", numberId);
    // Twilio's connection overrides: two retries on a slow connect or a 5xx (a machine waking up), not one on connect only.
    // Safe to repeat: a call is kept once per CallSid, a text once per MessageSid.
    u.hash = "rc=2&rp=ct,5xx";
    return u.href;
  };
  const plain = (path: string) => `${base}/${path}?n=${numberId}`;
  return {
    voice: withSecret("voice"), sms: withSecret("sms"), status: plain("status"),
    fallback: ringTo ? forwardTo(ringTo) : null,
  };
}

/** Twilio's forwarding twimlet, ringing one phone: the fallback while the app is pointed at, and the whole answer once it isn't. */
const forwardTo = (phone: string) => `https://twimlets.com/forward?PhoneNumber=${encodeURIComponent(phone)}`;

/**
 * Stop using a number here, keeping it on the owner's Twilio: calls ring
 * straight through to the phone it rang (no press 1, no voicemail of ours),
 * texts are no longer sent to this app. Releasing the number for good is
 * the owner's, in Twilio's Console (Twilio holds a released number 10 days).
 */
export async function unhook(db: Db, tw: Provider, n: PhoneNumber): Promise<void> {
  await tw.pointNumber(n.provider_id, { voice: n.ring_to ? forwardTo(n.ring_to) : "", sms: "", status: "", fallback: null });
  await removeNumber(db, n.id);
}

/** Point a number we keep at this app, with a fresh secret. */
export async function point(db: Db, tw: Provider, env: Env, n: PhoneNumber): Promise<{ ok: true } | { ok: false; why: string }> {
  const base = n.hooks_url ? { ok: true as const, url: n.hooks_url } : await inboundUrl(env);
  if (!base.ok) return base;
  const secret = newToken();
  // Kept first, so a call that arrives the moment Twilio has the new secret is let in; the old one is put back if Twilio refuses.
  await setHooks(db, n.id, base.url, await tokenHash(secret));
  try {
    await tw.pointNumber(n.provider_id, hooksFor(base.url, n.id, secret, n.ring_to));
  } catch (e) {
    if (n.hooks_url && n.hook_secret_hash) await setHooks(db, n.id, n.hooks_url, n.hook_secret_hash);
    throw e;
  }
  return { ok: true };
}

/** Buy a number Twilio offered and point it here. */
export async function buy(db: Db, tw: Provider, env: Env, o: { e164: string; label: string; ringTo: string | null }, by: string): Promise<{ ok: true; number: PhoneNumber } | { ok: false; why: string }> {
  const e164 = toE164(o.e164);
  if (!e164) return { ok: false, why: "That isn't a phone number." };
  const base = await inboundUrl(env);
  if (!base.ok) return base;
  // Bought pointing nowhere, then pointed with its own id and secret: one number's secret never opens another's hooks.
  const owned = await tw.buyNumber(e164, { voice: `${base.url}/voice`, sms: `${base.url}/sms`, status: `${base.url}/status` }, o.label);
  const n = await addNumber(db, { e164: owned.e164, label: o.label, provider_id: owned.id, ring_to: o.ringTo }, by);
  const pointed = await point(db, tw, env, { ...n, hooks_url: base.url });
  return pointed.ok ? { ok: true, number: { ...n, hooks_url: base.url } } : pointed;
}

/** Use a number already on the account (one bought in Twilio's Console, or by another app). */
export async function adopt(db: Db, tw: Provider, env: Env, o: { providerId: string; label: string; ringTo: string | null }, by: string): Promise<{ ok: true; number: PhoneNumber } | { ok: false; why: string }> {
  const mine = (await tw.ownedNumbers()).find((x) => x.id === o.providerId);
  if (!mine) return { ok: false, why: "That number isn't on your Twilio account." };
  const base = await inboundUrl(env);
  if (!base.ok) return base;
  const n = await addNumber(db, { e164: mine.e164, label: o.label, provider_id: mine.id, ring_to: o.ringTo }, by);
  const pointed = await point(db, tw, env, { ...n, hooks_url: base.url });
  return pointed.ok ? { ok: true, number: { ...n, hooks_url: base.url } } : pointed;
}

/**
 * Call a customer from the CRM: the owner's phone rings first; when they
 * answer, Twilio rings the customer from the business number (hooks.ts
 * /bridge). The call is kept on the customer's thread.
 */
export async function callOut(db: Db, tw: Provider, n: PhoneNumber, to: string, user: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const customer = toE164(to);
  if (!customer) return { ok: false, why: "That isn't a phone number we can call." };
  if (!n.ring_to) return { ok: false, why: "Set the phone to ring first (Settings, Phone and texts, Calls)." };
  if (!n.hooks_url) return { ok: false, why: "The number isn't pointed at this app yet." };
  const call = await tw.startCall({
    from: n.e164, to: n.ring_to, twimlUrl: `${n.hooks_url}/bridge?n=${n.id}&to=${encodeURIComponent(customer)}`, statusUrl: `${n.hooks_url}/status?n=${n.id}`,
  });
  await record(db, { phoneNumberId: n.id, local: n.e164, remote: customer, kind: "call", direction: "out", status: "queued", sentBy: user, providerId: call.id });
  await db.sql`update communications set answered_by = ${user} where provider = 'twilio' and provider_id = ${call.id}`;
  return { ok: true };
}
