// The texting box under a form's or the booking page's phone field: the
// words carriers want (who texts, about what, rates, HELP and STOP, the
// business's terms and privacy pages), naming the business as it is set
// once for the project (data/business.ts). What a person ticked is kept
// word for word on their submission or booking.
//
// The box shows once the business has a number, before texting is
// approved: the carriers' reviewers look for it on the live form, and turn
// down a registration whose opt-in they can't see (Twilio 30925). It needs
// the business's name, since a box naming another business is turned down
// too (30927). Edge-safe.
//
//   formRoutes(getDb, { ..., textConsent: (c) => textingBox(getDb(c), "request") })
import { businessOf, type Business } from "../data/business";
import type { Db } from "../data/db";

/** The box's words for a business and its pages. */
export function consentWords(business: string, about: "request" | "booking", pages: Pick<Business, "privacyUrl" | "termsUrl">): string {
  const links = [pages.termsUrl && `Terms: ${pages.termsUrl}`, pages.privacyUrl && `Privacy: ${pages.privacyUrl}`].filter(Boolean).join(" ");
  return `Text me about this ${about} from ${business}. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.${links ? ` ${links}` : ""}`;
}

/** The box's words, or null to leave it off: no business number yet (the phone skill's phone_numbers), or no name. */
export async function textingBox(db: Db, about: "request" | "booking"): Promise<string | null> {
  const [n] = await db.sql<{ yes: boolean }>`select exists (select 1 from phone_numbers) as yes`.catch(() => []);
  if (!n?.yes) return null;
  const b = await businessOf(db);
  return b.name ? consentWords(b.name, about, b) : null;
}
