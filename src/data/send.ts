// Email from an app, through a sender connected to it: Resend or Postmark
// (the owner's own, to anyone), or Task & Tool email (ours, free, only to the
// people who can open this app in Task & Tool). With no sender this sends
// nothing and says so ({ status: "none" }), and never throws: what the email
// was about is already saved.
//
// Configured once, for every skill that sends:
//   NOTIFY_FROM                         the From address, on a domain verified with that vendor
//                                        (not for Task & Tool email: the From is ours)
//   NOTIFY_VIA=resend|postmark|taskandtool[:slug]   which connection; slug when it is not the vendor's name
// Without NOTIFY_VIA, Task & Tool email. Every send goes through the app's
// connections (gatewayFetch), in dev and production alike: no key is here.
//
// Task & Tool email sends only mail marked `team: true`, to the people on
// this app; anything else (a customer's confirmation) reports that Resend or
// Postmark is needed, and never leaves the app.
//
//   afterResponse(c, sendEmail(envOf(c), { to: ["owner@biz.example"], subject, text, team: true }));
//
// Edge-safe: fetch and btoa only.
import type { Context } from "hono";
import { setting, type Env } from "./env";
import { gatewayFetch, gatewayReachable } from "./gateway";

export type Attachment = { filename: string; content: string | Uint8Array; contentType: string };
export type Email = {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string | null;
  attachments?: Attachment[];
  /** For the people who can open this app (a new submission, the morning email), not a customer. */
  team?: boolean;
};
export type Sent =
  /** `skipped`: addresses Task & Tool email would not send to, because they cannot open this app. */
  | { status: "sent"; via: string; skipped?: string[] }
  | { status: "none"; why: string }
  | { status: "failed"; via: string; error: string };

type Vendor = "resend" | "postmark" | "taskandtool";
export type Sender = { vendor: Vendor; slug: string };

/** Task & Tool email's connection slug. */
const OURS = "taskandtool-email";
const PATH: Record<Exclude<Vendor, "taskandtool">, string> = { resend: "/emails", postmark: "/email" };
const ONLY_TEAM = "Task & Tool email reaches only the people who can open this app; connect Resend or Postmark to email anyone else";

/** Which sender this app uses (NOTIFY_VIA, else Task & Tool email), or why there is none. */
export function senderOf(env: Env): Sender | string {
  const raw = setting(env, "NOTIFY_VIA");
  const via = raw ? /^(resend|postmark|taskandtool)(?::([a-z0-9][a-z0-9-]*))?$/.exec(raw) : null;
  if (raw && !via) return `NOTIFY_VIA is ${JSON.stringify(raw)}; it should be resend, postmark or taskandtool, optionally with :<connection slug>`;
  if (!gatewayReachable(env)) return "no email sender is connected to this app";
  const vendor = (via?.[1] ?? "taskandtool") as Vendor;
  return { vendor, slug: via?.[2] ?? (vendor === "taskandtool" ? OURS : vendor) };
}

/** Whether this app can email a customer: Resend or Postmark with NOTIFY_FROM (Task & Tool email reaches only the team). */
export function emailsCustomers(env: Env): boolean {
  const sender = senderOf(env);
  return typeof sender !== "string" && sender.vendor !== "taskandtool" && !!setting(env, "NOTIFY_FROM");
}

export async function sendEmail(env: Env, mail: Email, doFetch: typeof fetch = fetch): Promise<Sent> {
  let via = "none";
  try {
    if (!mail.to.length) return { status: "none", why: "nobody to send it to" };
    const sender = senderOf(env);
    if (typeof sender === "string") return { status: "none", why: sender };
    // One line and at most 200 characters, whoever sends it: no header injection.
    mail = { ...mail, subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 200) };
    if (sender.vendor === "taskandtool") return await sendOurs(env, sender, mail, doFetch);
    const from = setting(env, "NOTIFY_FROM");
    if (!from) return { status: "none", why: "NOTIFY_FROM is not set" };
    via = sender.vendor;

    const subject = mail.subject;
    const replyTo = mail.replyTo || undefined;
    const files = mail.attachments ?? [];
    const body =
      sender.vendor === "resend"
        ? {
            from, to: mail.to, subject, text: mail.text, reply_to: replyTo,
            attachments: files.length ? files.map((a) => ({ filename: a.filename, content: base64(a.content), content_type: a.contentType })) : undefined,
          }
        : {
            From: from, To: mail.to.join(","), Subject: subject, TextBody: mail.text, ReplyTo: replyTo, MessageStream: "outbound",
            Attachments: files.length ? files.map((a) => ({ Name: a.filename, Content: base64(a.content), ContentType: a.contentType })) : undefined,
          };
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) };
    const res = await gatewayFetch(env, sender.slug, PATH[sender.vendor as "resend" | "postmark"], init, doFetch);
    if (res.ok) return { status: "sent", via };
    if (res.headers.get("x-tasktool-refusal") === "unknown_connection") return { status: "none", why: `${sender.slug} is not connected to this app` };
    return { status: "failed", via, error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  } catch (e) {
    return { status: "failed", via, error: (e as Error).message };
  }
}

export type Person = { name: string; email: string };

/**
 * Who Task & Tool email reaches from this app (the people who can open it in
 * Task & Tool), or null when it is not this app's sender or cannot be asked.
 */
export async function teamOf(env: Env, doFetch: typeof fetch = fetch): Promise<Person[] | null> {
  const sender = senderOf(env);
  if (typeof sender === "string" || sender.vendor !== "taskandtool") return null;
  try {
    const res = await gatewayFetch(env, sender.slug, "/people", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) }, doFetch);
    return res.ok ? (((await res.json()) as { people?: Person[] }).people ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Task & Tool email: the team's mail only, through the app's connections,
 * which Task & Tool answers itself. No From (ours) and no attachments.
 */
async function sendOurs(env: Env, sender: Sender, mail: Email, doFetch: typeof fetch): Promise<Sent> {
  if (!mail.team) return { status: "none", why: ONLY_TEAM };
  if (mail.attachments?.length) return { status: "none", why: "Task & Tool email sends no attachments" };
  const res = await gatewayFetch(env, sender.slug, "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text, reply_to: mail.replyTo || undefined }),
  }, doFetch);
  // Not turned on for this app: there is no sender, which is not a failure.
  if (res.headers.get("x-tasktool-refusal") === "unknown_connection") return { status: "none", why: "no email sender is connected to this app" };
  if (!res.ok) return { status: "failed", via: "taskandtool", error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  const out = (await res.json()) as { sent?: string[]; skipped?: string[] };
  const skipped = out.skipped ?? [];
  if (!out.sent?.length) return { status: "none", why: `${skipped.join(", ") || "nobody"} cannot open this app in Task & Tool` };
  return skipped.length ? { status: "sent", via: "taskandtool", skipped } : { status: "sent", via: "taskandtool" };
}

function base64(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Run work after the response without holding it up. At the edge the Worker
 * must be told (waitUntil) or it stops before the work is done; on the
 * machine there is no execution context and the process outlives the
 * request. Failures are logged, never thrown into the response.
 */
export function afterResponse(c: Context, work: Promise<unknown>): void {
  const safe = work.catch((e) => console.error("after the response:", e));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // no execution context: the machine
  }
}
