// Email from an app, through the sender the owner connected: Resend or
// Postmark. Task & Tool sends no email for an app, ever; there is no platform
// route for it. With no sender this sends nothing and says so
// ({ status: "none" }), and never throws: what the email was about is
// already saved.
//
// Configured once, for every skill that sends:
//   NOTIFY_FROM                         the From address, on a domain verified with that vendor
//   NOTIFY_VIA=resend|postmark[:slug]   which connection; slug when it is not the vendor's name
// Where the call goes (first match wins):
//   the key bound as <SLUG>_API_KEY     at the edge (delivery "edge") or in the machine's env
//                                        (delivery "machine"): straight to the vendor
//   PHOENIX_URL + MACHINE_TOKEN          on the machine (delivery "brokered"): through the gateway
// Without NOTIFY_VIA a bound RESEND_API_KEY, else POSTMARK_API_KEY, is used.
//
//   afterResponse(c, sendEmail(envOf(c), { to: ["owner@biz.example"], subject, text }));
//
// Edge-safe: fetch and btoa only.
import type { Context } from "hono";
import { keyName, setting, type Env } from "./env";
import { gatewayFetch } from "./gateway";

export type Attachment = { filename: string; content: string | Uint8Array; contentType: string };
export type Email = { to: string[]; subject: string; text: string; replyTo?: string | null; attachments?: Attachment[] };
export type Sent =
  | { status: "sent"; via: string }
  | { status: "none"; why: string }
  | { status: "failed"; via: string; error: string };

type Vendor = "resend" | "postmark";
export type Sender = { vendor: Vendor; slug: string; key?: string };

const DIRECT: Record<Vendor, string> = { resend: "https://api.resend.com/emails", postmark: "https://api.postmarkapp.com/email" };
const PATH: Record<Vendor, string> = { resend: "/emails", postmark: "/email" };

/** Which sender this runtime has (a bound key, or the gateway), or why there is none. */
export function senderOf(env: Env): Sender | string {
  const raw = setting(env, "NOTIFY_VIA");
  const via = raw ? /^(resend|postmark)(?::([a-z0-9][a-z0-9-]*))?$/.exec(raw) : null;
  if (raw && !via) return `NOTIFY_VIA is ${JSON.stringify(raw)}; it should be resend or postmark, optionally with :<connection slug>`;
  const choices: Sender[] = via
    ? [{ vendor: via[1] as Vendor, slug: via[2] ?? via[1] }]
    : [
        { vendor: "resend", slug: "resend" },
        { vendor: "postmark", slug: "postmark" },
      ];
  for (const s of choices) {
    const key = setting(env, keyName(s.slug));
    if (key) return { ...s, key };
  }
  if (via && setting(env, "PHOENIX_URL") && setting(env, "MACHINE_TOKEN")) return choices[0];
  return via ? `no ${keyName(choices[0].slug)} here and no gateway (not on the machine)` : "no email sender is connected to this app";
}

export async function sendEmail(env: Env, mail: Email, doFetch: typeof fetch = fetch): Promise<Sent> {
  let via = "none";
  try {
    if (!mail.to.length) return { status: "none", why: "nobody to send it to" };
    const sender = senderOf(env);
    if (typeof sender === "string") return { status: "none", why: sender };
    const from = setting(env, "NOTIFY_FROM");
    if (!from) return { status: "none", why: "NOTIFY_FROM is not set" };
    via = sender.key ? sender.vendor : `gateway:${sender.slug}`;

    const subject = mail.subject.replace(/[\r\n]+/g, " ").slice(0, 200);
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
    let res: Response;
    if (sender.key) {
      const auth: Record<string, string> = sender.vendor === "resend" ? { Authorization: `Bearer ${sender.key}` } : { "X-Postmark-Server-Token": sender.key };
      res = await doFetch(DIRECT[sender.vendor], { ...init, headers: { ...(init.headers as Record<string, string>), ...auth } });
    } else {
      res = await gatewayFetch(env, sender.slug, PATH[sender.vendor], init, doFetch);
    }
    if (res.ok) return { status: "sent", via };
    return { status: "failed", via, error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  } catch (e) {
    return { status: "failed", via, error: (e as Error).message };
  }
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
