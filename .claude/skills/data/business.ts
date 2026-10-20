// The business itself, once for every app in the project (schema.sql
// `business`): its name, the privacy and terms pages, and its postal
// address. Texts sign with the name, quotes print it, and the texting box
// names it, so the box customers tick and the registration carriers
// approve say the same thing; a follow-up email ends with the address
// (CAN-SPAM asks it of an email that markets). Edge-safe.
//
//   const b = await businessOf(db);   // { name: null, ... } before it is set
import type { Db } from "./db";

export type Business = { name: string | null; privacyUrl: string | null; termsUrl: string | null; address: string | null };

const EMPTY: Business = { name: null, privacyUrl: null, termsUrl: null, address: null };

/** The business as set, or every part null: before anyone sets it, and in a project whose apps never made the table. */
export async function businessOf(db: Db): Promise<Business> {
  const [r] = await db.sql<{ name: string | null; privacy_url: string | null; terms_url: string | null; address: string | null }>`
    select name, privacy_url, terms_url, address from business`.catch(() => []);
  return r ? { name: r.name?.trim() || null, privacyUrl: r.privacy_url || null, termsUrl: r.terms_url || null, address: r.address || null } : EMPTY;
}

/** The longest name: every text carries it, so a long one can make a text two (flows.ts measures with 20 letters). */
export const NAME_MAX = 40;

export const ADDRESS_MAX = 200;

/** A part of the business made safe to save, or why it can't be. */
export function checkBusiness(b: Partial<Record<keyof Business, unknown>>): { ok: true; value: Partial<Business> } | { ok: false; field: keyof Business; why: string } {
  const value: Partial<Business> = {};
  if (b.name !== undefined) {
    const name = String(b.name ?? "").replace(/\s+/g, " ").trim();
    if (!name) return { ok: false, field: "name", why: "The business needs a name." };
    if (name.length > NAME_MAX) return { ok: false, field: "name", why: `At most ${NAME_MAX} letters: every text carries it.` };
    value.name = name;
  }
  for (const field of ["privacyUrl", "termsUrl"] as const) {
    if (b[field] === undefined) continue;
    const url = String(b[field] ?? "").trim();
    if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) return { ok: false, field, why: "A page's address starts with https://." };
    value[field] = url || null;
  }
  if (b.address !== undefined) {
    const address = String(b.address ?? "").replace(/\s+/g, " ").trim();
    if (address.length > ADDRESS_MAX) return { ok: false, field: "address", why: `At most ${ADDRESS_MAX} letters, on one line, like "12 Main St, Austin, TX 78701".` };
    value.address = address || null;
  }
  return { ok: true, value };
}

/** Save the parts given, checked first; the parts left out keep what they had. */
export async function saveBusiness(db: Db, b: Partial<Record<keyof Business, unknown>>, by: string): Promise<{ ok: true; business: Business } | { ok: false; field: keyof Business; why: string }> {
  const c = checkBusiness(b);
  if (!c.ok) return c;
  const v = c.value;
  await db.sql`
    insert into business (id, name, privacy_url, terms_url, address, updated_by)
    values (true, ${v.name ?? null}, ${v.privacyUrl ?? null}, ${v.termsUrl ?? null}, ${v.address ?? null}, ${by})
    on conflict (id) do update set
      name = case when ${v.name !== undefined}::boolean then excluded.name else business.name end,
      privacy_url = case when ${v.privacyUrl !== undefined}::boolean then excluded.privacy_url else business.privacy_url end,
      terms_url = case when ${v.termsUrl !== undefined}::boolean then excluded.terms_url else business.terms_url end,
      address = case when ${v.address !== undefined}::boolean then excluded.address else business.address end,
      updated_by = excluded.updated_by, updated_at = now()`;
  return { ok: true, business: await businessOf(db) };
}
