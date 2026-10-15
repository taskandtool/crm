#!/usr/bin/env node
// What the proposal's components are written from, read in one go: the
// business's own site into raw/site/<host>/ (tt-crawl brand: the homepage
// and the pages its menu links to; then, as the Website's from-site does,
// tt-crawl add for the pages a proposal draws on that it did not read:
// two photo pages, a reviews page, the about and team pages), then its Google listing (tt-crawl places) into
// raw/places/ when a google-places connection is granted to this app. The
// brand skill turns both into the notes; nothing here writes a note.
//
//   node scripts/proposal-read.mjs https://theirsite.com
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { done, fail, flag, machineEnv, misused, parseArgs, plain } from "../src/data/cli.mjs";

const HELP = `usage: node scripts/proposal-read.mjs <their site> [--max-pages 12]

Reads what the proposal's components are written from: the site with
tt-crawl brand (its homepage and the pages its menu links to, then any
photo, reviews, about or team page those link to that it has not read)
into raw/site/<host>/, and, when this app has a
google-places connection, the business's own Google listing (rating, its
count, named reviews, hours) into raw/places/. A listing whose website is
another site is left out. Safe to run again: the crawl refreshes in place.

  --max-pages   pages of the site to read (default 12)

Prints the pages, pictures and reviews read, the listing's rating and
reviews (or that there was none to read), the folders, then Next:. Exit 1
when the site cannot be read; 2 when misused.`;

const a = parseArgs(process.argv.slice(2));
plain(a, HELP, "proposal-read", { flags: ["max-pages"], args: true });
const tryCmd = "node scripts/proposal-read.mjs https://theirsite.com";
if (a._.length !== 1) misused(`proposal-read: name their site (given ${a._.length})`, tryCmd);
let site;
try {
  site = new URL(a._[0]);
  if (!/^https?:$/.test(site.protocol)) throw new Error("not http");
} catch {
  misused(`proposal-read: ${a._[0]} is not a web address`, tryCmd);
}
const maxText = flag(a, "max-pages") ?? "12";
if (!/^\d{1,3}$/.test(maxText) || Number(maxText) < 1) misused(`proposal-read: --max-pages ${maxText}; a number from 1 to 999`, tryCmd);
const host = site.hostname.replace(/^www\./, "");

const run = (args, env) => execFileSync("tt-crawl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, maxBuffer: 1 << 24 });
const last = (out) => JSON.parse(out.trim().split("\n").pop());

let crawl;
try {
  crawl = last(run(["brand", site.href, "--max-pages", maxText, "--json"], process.env));
} catch (e) {
  if (e.code === "ENOENT") fail("proposal-read: tt-crawl is not installed", "bash .taskandtool/setup.sh");
  const why = String(e.stderr || e.message).trim().split("\n").filter(Boolean).pop() ?? "";
  fail(`proposal-read: ${site.href} could not be read (${why.slice(0, 200)})`, `tt-crawl brand ${site.href} --max-pages 1`);
}
const folder = crawl.out;
const read = (f, fallback) => { try { return JSON.parse(readFileSync(join(folder, "_index", f), "utf8")); } catch { return fallback; } };

// The pages a proposal draws on, by their address, from the URLs the crawl
// found: the same picks as the Website's from-site, and the about and team pages.
const ours = (u) => { try { return new URL(u).hostname.replace(/^www\./, "") === host; } catch { return false; } };
const found = (read("inventory.json", {}).records || []).map((r) => r.url).filter(ours);
const pathOf = (u) => new URL(u).pathname;
const readNow = new Set((read("manifest.json", {}).pages || []).map((p) => p.url));
const unread = (u) => !readNow.has(u);
const picks = [
  ...found.filter((u) => unread(u) && /\/(gallery|photos?|portfolio|projects|our-work|work)(\/|$)/i.test(pathOf(u))).slice(0, 2),
  found.find((u) => /\/(testimonials?|reviews?|clients?|case-studies)\/?$/i.test(pathOf(u))),
  found.find((u) => /\/(about|about-us|our-story|who-we-are)[^/]*\/?$/i.test(pathOf(u))),
  found.find((u) => /\/(team|our-team|staff|meet-the-team|our-people)\/?$/i.test(pathOf(u))),
].filter((u) => u && unread(u));
let added = 0;
const toAdd = [...new Set(picks)];
if (toAdd.length) {
  try {
    added = last(run(["add", "--out", folder, "--json", ...toAdd], process.env)).new ?? toAdd.length;
  } catch {
    // The crawl stands without them.
  }
}
const card = read("business-card.json", {});

// The listing through the app's google-places connection: its gateway URL,
// with the machine token as the key (the gateway swaps in the real one).
function placesEnv() {
  const env = machineEnv();
  if (env.GOOGLE_PLACES_API_KEY || !env.MACHINE_TOKEN) return env.GOOGLE_PLACES_API_KEY ? env : null;
  try {
    const listed = execFileSync("python3", [join(homedir(), "tools", "taskandtool.py"), "list-connections", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const places = (JSON.parse(listed)?.connections || []).find((c) => c.provider === "google-places" && c.gateway_url);
    return places ? { ...env, GOOGLE_PLACES_API_URL: places.gateway_url.replace(/\/$/, "") + "/v1", GOOGLE_PLACES_API_KEY: env.MACHINE_TOKEN } : null;
  } catch {
    return null;
  }
}

let kept = null;
function listing() {
  const where = [card.address?.locality, card.address?.region].filter(Boolean).join(", ");
  if (!card.name) return "Google listing: not looked up (the site gives no business name)";
  const env = placesEnv();
  if (!env) return "Google listing: not read (no google-places connection)";
  try {
    const answer = last(run(["places", where ? `${card.name}, ${where}` : card.name, "--first", "--out", "raw/places", "--json"], env));
    const d = JSON.parse(readFileSync(join("raw/places", `${answer.place_id}.summary.json`), "utf8"));
    const listed = (() => { try { return new URL(d.website).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    if (listed !== host) {
      // Not theirs: its files go, so nothing reads them as the business's.
      for (const ext of [".json", ".summary.json", ".md"]) rmSync(join("raw/places", answer.place_id + ext), { force: true });
      return `Google listing: the one found for "${card.name}" is ${d.name || "another place"} (${listed || "no website"}), not ${host}; left out (tt-crawl places --place-id <theirs> --out raw/places reads the right one)`;
    }
    kept = answer.place_id;
    const rating = d.rating ? `rated ${d.rating} from ${d.review_count ?? "?"} Google reviews, ` : "";
    return `Google listing: ${d.name}, ${rating}${(d.reviews || []).length} reviews quoted, in raw/places/${answer.place_id}.summary.json`;
  } catch (e) {
    return `Google listing: not read (${String(e.stderr || e.message).trim().split("\n").filter(Boolean).pop()?.slice(0, 160)})`;
  }
}

const places = listing();
done("proposal-read", `${host}: ${crawl.pages + added} pages read${added ? ` (${added} added: photos, reviews, about, team)` : ""}`, {
  lines: [
    `${folder}/: pages/, images/ (${read("run.json", {}).images?.on_disk ?? crawl.images} pictures), _index/ (${crawl.reviews} reviews on the site, the business card, styles)`,
    places,
  ],
  next: `the brand skill's notes from ${folder}${kept ? ` and raw/places/${kept}.summary.json` : ""}, then the components (references/money.md)`,
});
