// The business's name, its privacy and terms pages and its address from chat: the same
// row as Settings, Business (the data skill's `business`), which every text,
// quote and the texting box on the forms use. `node scripts/business.mjs --help`.
import { ADDRESS_MAX, businessOf, checkBusiness, NAME_MAX, saveBusiness, type Business } from "../src/data/business";
import { done, fail, flag, misused, noMore, parseArgs, usage, who, withDb } from "./lib";

const HELP = `business.mjs <command> [--as <email>]

  show                                  the business's name, pages and address, as texts, quotes and forms use them
  set [--name "<name>"] [--privacy <url>] [--terms <url>] [--address "<one line>"]
                                        change any of them; the rest keep what they had. "" clears a page
                                        or the address. The name is up to ${NAME_MAX} letters (every text
                                        names it); the address up to ${ADDRESS_MAX}, ending the follow-up emails.

Prints what happened first, then Next:. A re-run with the same values says
"already" and changes nothing. Errors go to stderr with a Try: line; exit 1
when refused, 2 when misused.`;

const FLAGS: Record<string, string[]> = { show: [], set: ["name", "privacy", "terms", "address", "as"] };

const a = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = a._;
usage(a, cmd, Object.keys(FLAGS), HELP, "business", FLAGS);
const at = `business ${cmd}`;
noMore(rest, 0, at);

const lines = (b: Business) => [
  `name: ${b.name ?? "not set (texts say \"it's us\", and the texting box stays off the forms)"}`,
  `privacy page: ${b.privacyUrl ?? "none (carriers want one before the number can text)"}`,
  `terms page: ${b.termsUrl ?? "none"}`,
  `address: ${b.address ?? "none (the follow-up emails that ask for a booking or a review end with one)"}`,
];

await withDb(async (db) => {
  const now = await businessOf(db);
  if (cmd === "show") return done(at, now.name ?? "no name yet", { lines: lines(now), next: now.name ? "node scripts/phone.mjs registration" : 'node scripts/business.mjs set --name "<the name customers know>"' });
  const given = { name: flag(a, "name"), privacyUrl: flag(a, "privacy"), termsUrl: flag(a, "terms"), address: flag(a, "address") };
  if (Object.values(given).every((v) => v === undefined)) misused(`${at}: say what to change: --name, --privacy, --terms or --address`, 'node scripts/business.mjs set --name "Acme Plumbing"');
  const c = checkBusiness(given);
  const TRY: Record<keyof Business, string> = { name: 'name "Acme Plumbing"', privacyUrl: "privacy https://acme.com/privacy", termsUrl: "terms https://acme.com/terms", address: 'address "12 Main St, Austin, TX 78701"' };
  const tryField = (f: keyof Business) => `node scripts/business.mjs set --${TRY[f]}`;
  if (!c.ok) fail(`${at}: ${c.why}`, tryField(c.field));
  if ((Object.keys(c.value) as (keyof Business)[]).every((k) => c.value[k] === now[k])) return done(at, "already as given; left alone", { lines: lines(now), next: "node scripts/business.mjs show" });
  const r = await saveBusiness(db, given, who(a));
  if (!r.ok) fail(`${at}: ${r.why}`, tryField(r.field));
  return done(at, `saved: ${r.business.name ?? "no name yet"}`, { lines: lines(r.business), next: "node scripts/business.mjs show, and tell the owner it is in Settings, Business" });
});
