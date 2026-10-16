// Quotes from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings and its customers as <who>, a quote as its proposal
// page (src/proposals) at a link, and "proposal" to tick its components and
// say what happens when they sign. `--help` for usage.
import { quotesCli } from "../src/invoices/cli";
import { winFromQuotes } from "../src/crm/deals";
import { cfg, invoicesCfg } from "../src/config";
import { sendEmail } from "../src/data/send";
import { stripeFrom } from "../src/payments/stripe";
import { quoteById } from "../src/invoices/quotes";
import { linkReady } from "../src/proposals/link";
import { production } from "../src/proposals/serving";
import { COMPONENTS, PICKABLE } from "../src/proposals/components";
import { afterAccepted, afterDeclined, onAcceptSentence, proposalDocument, type AnswerDeps } from "../src/proposals/sign";
import { chosenKeys, ensureProposal, markEmailed, newLink, proposalOf, sampleWarning, saveProposal, storePage, type ProposalOpts } from "../src/proposals/store";
import { printPdf } from "../src/pdf";
import { cliSettings, done, fail, flag, has, misused, out } from "./lib";

const settings = cliSettings("quotes");
const opts: ProposalOpts = { business: invoicesCfg?.name ?? "", word: invoicesCfg?.word ?? "Quote", timeZone: cfg.time_zone };
const deps: AnswerDeps = {
  opts,
  stripe: () => stripeFrom(settings.env),
  send: (mail) => sendEmail(settings.env, mail),
  print: printPdf,
  daysUntilDue: invoicesCfg?.days_until_due ?? 30,
};

/** Production's address for a link, or why there is none (link.ts says the same on the pages). */
async function base(): Promise<{ ok: true; base: string } | { ok: false; why: string }> {
  if (settings.env.PROPOSAL_BASE_URL) return { ok: true, base: settings.env.PROPOSAL_BASE_URL.replace(/\/+$/, "") };
  const p = await production();
  if (!p) return { ok: false, why: "Task & Tool did not say where production is just now." };
  if (!p.url) return { ok: false, why: "this app has no production address yet." };
  if (!p.deployed) return { ok: false, why: "this app has never been deployed to production, where customers open the link." };
  return { ok: true, base: p.url.replace(/\/+$/, "") };
}

const pickable = PICKABLE.map((c) => c.key).join(",");

await quotesCli(process.argv.slice(2), {
  ...settings,
  word: opts.word,
  afterSend: async (db, doc, by) => {
    await settings.afterSend?.(db, doc, by);
    if (doc.kind === "quote") await storePage(db, doc.id, opts);
  },
  // A yes wins the deal the quote is for, and does what "After they sign" says.
  afterDecide: async (db, qt, by) => {
    const won = (await winFromQuotes(db, by)).map((d) => `deal #${d.id} ${d.title} won`);
    const after = qt.status === "accepted" ? (await afterAccepted(db, qt, by, deps)).lines : [];
    if (qt.status === "declined") await afterDeclined(db, qt, by);
    return [...won, ...after];
  },
  proposal: {
    saved: async (db, qt) => {
      await ensureProposal(db, qt);
      const r = await storePage(db, qt.id, opts);
      if (!r.ok) console.error(`its page was not made again: ${r.why}`);
    },
    ready: async () => {
      const b = await base();
      return b.ok ? linkReady(b.base) : b.why;
    },
    mint: async (db, qt, by) => {
      const b = await base();
      if (!b.ok) throw new Error(b.why);
      const stored = await storePage(db, qt.id, opts);
      if (!stored.ok) throw new Error(stored.why);
      return newLink(db, qt.id, by, b.base);
    },
    emailed: (db, qt) => markEmailed(db, qt.id),
    document: (db, qt) => proposalDocument(db, qt, opts),
    onAccept: (db, qt) => onAcceptSentence(db, qt),
    warning: (db, qt) => sampleWarning(db, qt.id),
  },
  more: {
    help: `  proposal <id>                        its components (ticked or not), title and what happens when they sign
  proposal <id> [--components ${pickable.split(",").slice(0, 3).join(",")},...] [--title "..."]
            [--first-invoice none|draft|send] [--deposit 50|full]
                                       ticks exactly the components named; the page is made again
  The components: ${pickable}. Pricing and the sign-off are on every one, a plain quote;
  a component's design and words are its file in src/proposals/components/.`,
    flags: { proposal: ["components", "title", "first-invoice", "deposit", "as"] },
    commands: {
      proposal: async (db, a, rest, by) => {
        const at = "quotes proposal";
        const json = has(a, "json");
        if (!rest[0] || !/^\d{1,18}$/.test(rest[0])) misused(`${at}: name the quote by its id (#12 is 12)`, "node scripts/quotes.mjs list");
        const qt = await quoteById(db, rest[0]);
        if (!qt) fail(`${at}: no quote ${rest[0]}`, "node scripts/quotes.mjs list");
        await ensureProposal(db, qt);
        const changing = ["components", "title", "first-invoice", "deposit"].some((f) => has(a, f));
        if (changing) {
          const p = await proposalOf(db, qt.id);
          const wanted = has(a, "components") ? (flag(a, "components") ?? "").split(",").map((s) => s.trim()).filter(Boolean) : await chosenKeys(db, qt.id);
          const odd = wanted.filter((k) => !PICKABLE.some((c) => c.key === k));
          if (odd.length) misused(`${at}: ${odd.join(", ")} ${odd.length === 1 ? "is not a component" : "are not components"}; they are ${pickable}`, `node scripts/quotes.mjs proposal ${qt.id} --components about,reviews`);
          const first = flag(a, "first-invoice") ?? p?.first_invoice ?? "none";
          if (!["none", "draft", "send"].includes(first)) misused(`${at}: --first-invoice is none, draft or send`, `node scripts/quotes.mjs proposal ${qt.id} --first-invoice draft`);
          const dep = flag(a, "deposit");
          const pct = dep === undefined ? (p?.deposit_percent ? String(p.deposit_percent) : "") : dep === "full" ? "" : dep.replace(/%$/, "");
          const r = await saveProposal(db, qt.id, { title: flag(a, "title") ?? p?.title ?? "", first_invoice: first, deposit_percent: pct, components: wanted }, by);
          if (!r.ok) fail(`${at}: not saved\n${Object.entries(r.errors).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`, `node scripts/quotes.mjs proposal ${qt.id}`);
          const stored = await storePage(db, qt.id, opts);
          if (!stored.ok) fail(`${at}: saved, but its page was not made: ${stored.why}`, "node scripts/quotes.mjs proposal --help");
        }
        const [p, keys] = await Promise.all([proposalOf(db, qt.id), chosenKeys(db, qt.id)]);
        const view = {
          id: qt.id, number: qt.number, status: qt.status, title: p?.title ?? null,
          components: COMPONENTS.filter((c) => c.always || keys.includes(c.key)).map((c) => ({ key: c.key, sample: c.sample })),
          first_invoice: p?.first_invoice ?? "none", deposit_percent: p?.deposit_percent ?? null,
        };
        if (json) return out(true, view, String);
        return done(at, `${changing ? "saved " : ""}${opts.word.toLowerCase()} ${qt.number}${view.title ? ` "${view.title}"` : ""}`, {
          lines: [
            `components: ${view.components.map((c) => c.key + (c.sample ? " (sample words)" : "")).join(", ")}`,
            `after they sign: ${view.first_invoice === "none" ? "nothing" : `${view.first_invoice === "draft" ? "a draft" : "a sent"} invoice for ${view.deposit_percent ? `a ${view.deposit_percent}% deposit` : "the full total"}`}`,
            `preview: /invoices/quotes/${qt.id}/document on dev`,
          ],
          next: `node scripts/quotes.mjs send ${qt.id}`,
        });
      },
    },
  },
});
