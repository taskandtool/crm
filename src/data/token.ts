// A secret key a visitor holds (a booking's manage link, a form's place in
// its steps) and the hash stored in its place. 32 random bytes, URL-safe.
// Looking a row up by the hash is the constant-time comparison: the index
// lookup can only be timed on a hash, which says nothing about a real key.
//
//   const key = newToken();                       // give it to the visitor once
//   await db.sql`insert into … (key_hash) values (${await tokenHash(key)})`;
//
// Edge-safe: Web Crypto only.

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex SHA-256 of a key. */
export async function tokenHash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The shape newToken makes; anything else is not a key and is never looked up. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
