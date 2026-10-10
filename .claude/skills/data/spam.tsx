// Spam checks for any public form, with no JavaScript and no third party: a
// honeypot field people never see, and a "started at" stamp so a form sent
// faster than a person could fill it is caught. Both are checked on the
// server. Forms and the booking page use the same two fields.
//
//   <SpamFields stamp={await makeStamp("contact")} />   // inside the <form>
//   const v = await verdict("contact", { honeypot: body[HONEYPOT], stamp: body[STAMP] });
//   // "drop": a bot; answer as if it worked. "fast": keep it marked as spam, tell nobody. "ok": a person.
//
// A stamp older than two days is treated like a fast one: a bot that saved a
// page cannot post with its stamp forever, and a person who left a tab open
// still has their answer kept (marked spam) or is asked to send it again.
//
// The stamp is signed with HMAC-SHA-256 (Web Crypto, so it runs at the edge),
// which stops a generic bot from simply posting an old time, and it names
// what it was made for (`scope`), so one form's stamp is no good on another.
// The key is a constant, not a setting: it is public in this code, so it
// stops bots that do not read it, which is the point, and nothing to set up.
//
// The stamp is made when the page is served. A page pre-rendered at publish
// carries its build time, so the fill-time check passes for everyone there;
// that is why a page with a form is rendered per request.
import { fromB64url, toB64url } from "./token";

export const HONEYPOT = "company_website";
export const STAMP = "_started";
export const MIN_FILL_MS = 3000;
export const MAX_STAMP_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export type Verdict = "ok" | "drop" | "fast";

/**
 * The two hidden fields. The honeypot is moved off screen rather than hidden
 * with display:none, which many bots recognise and skip; aria-hidden and
 * tabindex keep it from people using a screen reader or a keyboard.
 */
export function SpamFields({ stamp }: { stamp: string }) {
  return (
    <>
      <div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">
        <label>
          Leave this empty <input name={HONEYPOT} type="text" tabindex={-1} autocomplete="off" value="" />
        </label>
      </div>
      <input type="hidden" name={STAMP} value={stamp} />
    </>
  );
}

/** The value of the hidden STAMP field for a form served now. */
export async function makeStamp(scope: string, now = Date.now()): Promise<string> {
  const t = String(Math.floor(now));
  return `${t}.${toB64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc(`${scope}.${t}`))))}`;
}

/**
 * What to do with a post: "drop" a bot (honeypot filled, stamp missing,
 * forged or from the future), mark one sent too "fast" (or on a stamp over
 * two days old) as spam, else "ok".
 */
export async function verdict(
  scope: string,
  body: { honeypot?: unknown; stamp?: unknown },
  now = Date.now(),
  minFillMs = MIN_FILL_MS,
): Promise<Verdict> {
  if (typeof body.honeypot === "string" && body.honeypot.trim() !== "") return "drop";
  if (body.honeypot !== undefined && typeof body.honeypot !== "string") return "drop";
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]+)$/.exec(typeof body.stamp === "string" ? body.stamp : "");
  if (!m) return "drop";
  const t = Number(m[1]);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromB64url(m[2]);
  } catch {
    return "drop";
  }
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(), sig, enc(`${scope}.${m[1]}`)))) return "drop";
  if (t > now + 60_000) return "drop";
  return now - t < minFillMs || now - t > MAX_STAMP_AGE_MS ? "fast" : "ok";
}

const enc = (s: string) => new TextEncoder().encode(s);

const KEY = "taskandtool spam stamp";

function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

