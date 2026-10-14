// Quotes from chat: the invoices skill's command (src/invoices/cli.ts) with
// this CRM's settings and its customers as <who>, a quote as its proposal
// page (src/proposals) at a link, and "proposal" to tick its sections, give
// it its words, and say what happens when they sign. `--help` for usage.
import { quotesCli } from "../src/invoices/cli";
import { winFromQuotes } from "../src/crm/deals";
import { cfg, invoicesCfg } from "../src/config";
import { sendEmail } from "../src/data/send";
import { stripeFrom } from "../src/payments/stripe";
import { quoteById } from "../src/invoices/quotes";
import { linkReady } from "../src/proposals/link";
import { production } from "../src/proposals/serving";
import { SECTIONS, TICKABLE, sectionDef } from "../src/proposals/sections";
import { afterAccepted, onAcceptSentence, type AnswerDeps } from "../src/proposals/sign";
import { ensureProposal, freezeSections, markEmailed, newLink, pageFor, proposalOf, resolvedSections, saveProposal, storePage, type ProposalOpts } from "../src/proposals/store";
import { fillPage } from "../src/proposals/page";
import { printPdf } from "../src/pdf";
import { cliSettings, done, fail, flag, flags, has, misused, out } from "./lib";

const settings = cliSettings("quotes");
const opts: ProposalOpts = { business: invoicesCfg?.name ?? "", word: invoicesCfg?.word ?? "Quote", timeZone: cfg.time_zone, terms: invoicesCfg?.terms ?? null };
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

const tickable = TICKABLE.map((s) => s.key).join(",");

await quotesCli(process.argv.slice(2), {
  ...settings,
  word: opts.word,
  afterSend: async (db, doc, by) => {
    await settings.afterSend?.(db, doc, by);
    if (doc.kind === "quote") {
      await freezeSections(db, doc.id, opts);
      await storePage(db, doc.id, opts);
    }
  },
  // A yes wins the deal the quote is for, and does what "After they sign" says.
  afterDecide: async (db, qt, by) => {
    const won = (await winFromQuotes(db, by)).map((d) => `deal #${d.id} ${d.title} won`);
    const after = qt.status === "accepted" ? (await afterAccepted(db, qt, by, deps)).lines : [];
    return [...won, ...after];
  },
  proposal: {
    saved: async (db, qt) => {
      await ensureProposal(db, qt, opts);
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
      await freezeSections(db, qt.id, opts);
      const stored = await storePage(db, qt.id, opts);
      if (!stored.ok) throw new Error(stored.why);
      return newLink(db, qt.id, by, b.base);
    },
    emailed: (db, qt) => markEmailed(db, qt.id),
    document: async (db, qt) => fillPage((await pageFor(db, qt.id, opts))!.html, { kind: "preview" }, opts.word),
    onAccept: (db, qt) => onAcceptSentence(db, qt),
  },
  more: {
    help: `  proposal <id>                        its sections (ticked or not), title and what happens when they sign
  proposal <id> [--sections ${tickable.split(",").slice(0, 3).join(",")},...] [--title "..."]
            [--text <section>.<name>="..."]... [--first-invoice none|draft|send] [--deposit 50|full]
                                       ticks exactly the sections named; --text gives one its words for this
                                       quote (summary.heard, summary.propose, scope.included, scope.excluded,
                                       about.about, terms.terms, pricing.intro); the page is made again
  The sections: ${tickable}. Cover, pricing and accept are always there.`,
    flags: { proposal: ["sections", "title", "text", "first-invoice", "deposit", "as"] },
    commands: {
      proposal: async (db, a, rest, by) => {
        const at = "quotes proposal";
        const json = has(a, "json");
        if (!rest[0] || !/^\d{1,18}$/.test(rest[0])) misused(`${at}: name the quote by its id (#12 is 12)`, "node scripts/quotes.mjs list");
        const qt = await quoteById(db, rest[0]);
        if (!qt) fail(`${at}: no quote ${rest[0]}`, "node scripts/quotes.mjs list");
        await ensureProposal(db, qt, opts);
        const changing = ["sections", "title", "text", "first-invoice", "deposit"].some((f) => has(a, f));
        if (changing) {
          const current = await resolvedSections(db, qt.id, opts);
          const p = await proposalOf(db, qt.id);
          const wanted = has(a, "sections") ? (flag(a, "sections") ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
          const odd = (wanted ?? []).filter((k) => !TICKABLE.some((s) => s.key === k));
          if (odd.length) misused(`${at}: ${odd.join(", ")} ${odd.length === 1 ? "is not a section" : "are not sections"}; they are ${tickable}`, `node scripts/quotes.mjs proposal ${qt.id} --sections summary,scope,terms`);
          const sections = Object.fromEntries(current.map((s) => [s.key, { ticked: wanted ? wanted.includes(s.key) || !!sectionDef(s.key)!.always : s.ticked, title: s.content.title, texts: { ...s.content.texts }, entries: s.content.entries }]));
          for (const t of flags(a, "text")) {
            const m = /^([a-z]+)\.([a-z_]+)=([\s\S]*)$/.exec(t);
            const def = m && sectionDef(m[1]);
            if (!m || !def || !def.texts.some((x) => x.name === m[2])) misused(`${at}: --text ${t.slice(0, 40)}: write it as <section>.<name>="words", e.g. summary.heard="..."`, "node scripts/quotes.mjs proposal --help");
            (sections[m[1]].texts as Record<string, string>)[m[2]] = m[3];
          }
          const first = flag(a, "first-invoice") ?? p?.first_invoice ?? "none";
          if (!["none", "draft", "send"].includes(first)) misused(`${at}: --first-invoice is none, draft or send`, `node scripts/quotes.mjs proposal ${qt.id} --first-invoice draft`);
          const dep = flag(a, "deposit");
          const pct = dep === undefined ? (p?.deposit_percent ? String(p.deposit_percent) : "") : dep === "full" ? "" : dep.replace(/%$/, "");
          const r = await saveProposal(db, qt.id, { title: flag(a, "title") ?? p?.title ?? "", first_invoice: first, deposit_percent: pct, sections }, by, opts);
          if (!r.ok) fail(`${at}: not saved\n${Object.entries(r.errors).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`, `node scripts/quotes.mjs proposal ${qt.id}`);
          const stored = await storePage(db, qt.id, opts);
          if (!stored.ok) fail(`${at}: saved, but its page was not made: ${stored.why}`, "node scripts/quotes.mjs proposal --help");
        }
        const [p, sections] = await Promise.all([proposalOf(db, qt.id), resolvedSections(db, qt.id, opts)]);
        const view = {
          id: qt.id, number: qt.number, status: qt.status, title: p?.title ?? null,
          sections: sections.filter((s) => s.ticked).map((s) => s.key),
          first_invoice: p?.first_invoice ?? "none", deposit_percent: p?.deposit_percent ?? null,
        };
        if (json) return out(true, view, String);
        return done(at, `${changing ? "saved " : ""}${opts.word.toLowerCase()} ${qt.number}${view.title ? ` "${view.title}"` : ""}`, {
          lines: [
            `sections: ${SECTIONS.filter((d) => view.sections.includes(d.key)).map((d) => d.key).join(", ")}`,
            `after they sign: ${view.first_invoice === "none" ? "nothing" : `${view.first_invoice === "draft" ? "a draft" : "a sent"} invoice for ${view.deposit_percent ? `a ${view.deposit_percent}% deposit` : "the full total"}`}`,
            `preview: /invoices/quotes/${qt.id}/document on dev`,
          ],
          next: `node scripts/quotes.mjs send ${qt.id}`,
        });
      },
    },
  },
});
