// Spam checks for any public form, with no JavaScript and no third party: a
// honeypot field people never see, and a "started at" stamp so a form sent
// faster than a person could fill it is caught. Both are checked on the
// server. Forms and the booking page use the same two fields.
//
//   <SpamFields stamp={await makeStamp("contact", envVar(c, "SPAM_SECRET"))} />   // inside the <form>
//   const v = await verdict("contact", { honeypot: body[HONEYPOT], stamp: body[STAMP] }, envVar(c, "SPAM_SECRET"));
//   // "drop": a bot; answer as if it worked. "fast": keep it marked as spam, tell nobody. "ok": a person.
//
// The stamp is signed with HMAC-SHA-256 (Web Crypto, so it runs at the edge)
// when SPAM_SECRET is set, which stops a bot from simply posting an old time,
// and it names what it was made for (`scope`), so one form's stamp is no good
// on another. Without the secret the stamp is a plain number a bot can forge,
// and the honeypot does the work alone.
//
// The stamp is made when the page is served. A page pre-rendered at publish
// carries its build time, so the fill-time check passes for everyone there;
// that is why a page with a form is rendered per request.

export const HONEYPOT = "company_website";
export const STAMP = "_started";
export const MIN_FILL_MS = 3000;

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
export async function makeStamp(scope: string, secret: string | undefined, now = Date.now()): Promise<string> {
  const t = String(Math.floor(now));
  if (!secret) return t;
  return `${t}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc(`${scope}.${t}`)))}`;
}

/**
 * What to do with a post: "drop" a bot (honeypot filled, stamp missing,
 * forged or from the future), mark one sent too "fast" as spam, else "ok".
 */
export async function verdict(
  scope: string,
  body: { honeypot?: unknown; stamp?: unknown },
  secret: string | undefined,
  now = Date.now(),
  minFillMs = MIN_FILL_MS,
): Promise<Verdict> {
  if (typeof body.honeypot === "string" && body.honeypot.trim() !== "") return "drop";
  if (body.honeypot !== undefined && typeof body.honeypot !== "string") return "drop";
  const m = /^(\d{10,16})(?:\.([A-Za-z0-9_-]+))?$/.exec(typeof body.stamp === "string" ? body.stamp : "");
  if (!m) return "drop";
  const t = Number(m[1]);
  if (secret) {
    if (!m[2]) return "drop";
    let sig: Uint8Array<ArrayBuffer>;
    try {
      sig = fromB64url(m[2]);
    } catch {
      return "drop";
    }
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc(`${scope}.${m[1]}`)))) return "drop";
  }
  if (t > now + 60_000) return "drop";
  return now - t < minFillMs ? "fast" : "ok";
}

const enc = (s: string) => new TextEncoder().encode(s);

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
}
