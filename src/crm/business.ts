// The business's name, its privacy and terms pages and its address (the data skill's
// `business` row), for code that names the business without a database at
// hand: the sidebar, a quote's page, its emails. Loaded once per request
// (the middlewares in app.tsx) and by every script (scripts/lib.ts), as
// people.ts loads the team. Set in Settings, Business, or by
// `node scripts/business.mjs set`.
import { businessOf, type Business } from "../data/business";
import type { Db } from "../data/db";

let current: Business = { name: null, privacyUrl: null, termsUrl: null, address: null };

/** Read the business for this request. */
export async function loadBusiness(db: Db): Promise<Business> {
  current = await businessOf(db);
  return current;
}

/** The business as this request (or script) loaded it. */
export const business = (): Business => current;
