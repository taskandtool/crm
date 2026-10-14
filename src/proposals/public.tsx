// The customer's side: /q/<token>, the one path of the CRM a customer
// opens, on production (where a person opened /q/ to customers in Task &
// Tool) and on localhost. It serves the page stored on the quote, with
// Accept drawn in; it records each open; it takes the signature or the
// decline as a POST to the same link, checked same-origin. The page runs no
// script and loads nothing: its headers say so.
//
// /q/ itself answers with X-Proposals and nothing else, so Send can tell a
// production that serves proposals from one that does not (link.ts).
import { Hono, type Context } from "hono";
import { sameOrigin, whoIs } from "../admin/guard";
import type { Db } from "../data/db";
import { todayIn } from "../invoices/document";
import { ONLINE, quoteById } from "../invoices/quotes";
import { PROPOSAL_CSS } from "./style";
import { PROPOSALS_HEADER } from "./link";
import { fillPage } from "./page";
import { confirmSignature, declineProposal, signedState, signProposal, type AnswerDeps } from "./sign";
import { proposalOf, quoteIdByToken, recordView } from "./store";

export type PublicOpts = {
  /** This request's database, or null while it is not up. */
  db: (c: Context) => { db: Db | null; close?: () => Promise<void> };
  deps: (c: Context) => AnswerDeps;
  /** The reasons a customer may give for declining (crm.config.json deals.lost_reasons). */
  reasons: string[];
};

const CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function headers(c: Context) {
  c.header(PROPOSALS_HEADER, "1");
  c.header("Content-Security-Policy", CSP);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Content-Type-Options", "nosniff");
  // no-transform: the edge adds nothing to the page (Cloudflare's analytics beacon, for one).
  c.header("Cache-Control", "no-store, no-transform");
}

/** The one page every dead or unknown link gets. */
function dead(c: Context, business: string, status = 404) {
  const who = business ? escapeHtml(business) : "the business that sent it";
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex"/>` +
      `<title>This link no longer works</title><style>${PROPOSAL_CSS}</style></head>` +
      `<body class="bg-canvas font-body text-body text-ink"><main class="mx-auto max-w-read px-5 py-24"><h1 class="font-display text-section">This link no longer works.</h1>` +
      `<p class="mt-3 text-muted">Ask ${who} for a new one.</p></main></body></html>`,
    status as 404,
  );
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ipOf = (c: Context) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? null;

export function proposalPages(opts: PublicOpts) {
  const app = new Hono();

  // Every answer here: the database for the request, closed after, and the headers.
  app.use("*", async (c, next) => {
    headers(c);
    await next();
    headers(c);
  });

  app.get("/", (c) => c.text("Proposals open here."));

  /** The quote a link opens, with its proposal; null for a dead or unknown link. */
  const open = async (c: Context, db: Db) => {
    const id = await quoteIdByToken(db, c.req.param("token") ?? "");
    if (!id) return null;
    const [qt, p] = await Promise.all([quoteById(db, id), proposalOf(db, id)]);
    return qt && p?.page_html && p.page_sha256 ? { qt, p } : null;
  };

  const withDb = async (c: Context, fn: (db: Db) => Promise<Response>) => {
    const opened = opts.db(c);
    if (!opened.db) return c.text("Back in a moment: this page is starting up.", 503);
    try {
      return await fn(opened.db);
    } finally {
      if (opened.close) await opened.close().catch(() => {});
    }
  };

  /** The page, as it stands for this link now. `problem` and `name` come back after a refused POST. */
  const show = async (c: Context, db: Db, problem?: string, name?: string, status = 200) => {
    const deps = opts.deps(c);
    const w = deps.opts.word;
    const found = await open(c, db);
    if (!found) return dead(c, deps.opts.business);
    const { qt, p } = found;
    // Signed: the page they signed (stored, and frozen since), with the signature and where each invoice stands now.
    if (qt.status === "accepted" && qt.decided_by === ONLINE.accepted) return c.html(fillPage(p.page_html!, await signedState(db, qt.id, deps.opts), w));
    if (qt.status === "declined" && qt.decided_by === ONLINE.declined) return c.html(fillPage(p.page_html!, { kind: "declined" }, w));
    const expired = !!qt.valid_until && qt.valid_until < todayIn(deps.opts.timeZone);
    if (qt.status !== "sent" || expired) return dead(c, deps.opts.business);
    if (!problem) await recordView(db, qt.id, !!whoIs(c), ipOf(c), c.req.header("user-agent") ?? null);
    const action = new URL(c.req.url).pathname.replace(/\/+$/, "");
    return c.html(fillPage(p.page_html!, { kind: "open", action, sha: p.page_sha256!, reasons: opts.reasons, problem, name }, w), status as 200);
  };

  app.get("/:token{[A-Za-z0-9_-]{43}}", (c) => withDb(c, (db) => show(c, db)));

  app.post("/:token{[A-Za-z0-9_-]{43}}", (c) => withDb(c, async (db) => {
    if (!sameOrigin(c)) return c.text("Cross-site request refused.", 403);
    const deps = opts.deps(c);
    const found = await open(c, db);
    if (!found) return dead(c, deps.opts.business);
    const body = await c.req.parseBody();
    const r = await signProposal(db, found.qt.id, { name: body.name, agree: body.agree, page: body.page }, { ip: ipOf(c), browser: c.req.header("user-agent") ?? null }, deps);
    if (!r.ok) return show(c, db, r.message, typeof body.name === "string" ? body.name : undefined, r.reason === "stale" ? 409 : 422);
    // Their copy, by email: after the signature, never before it; a failure is logged and the page still shows it.
    const link = new URL(c.req.url);
    const sent = await confirmSignature(db, found.qt.id, `${link.origin}${link.pathname}`, deps);
    if (sent.status === "failed") console.error(`quote ${found.qt.id}: the signed copy did not go: ${sent.error}`);
    return c.redirect(link.pathname, 303);
  }));

  app.post("/:token{[A-Za-z0-9_-]{43}}/decline", (c) => withDb(c, async (db) => {
    if (!sameOrigin(c)) return c.text("Cross-site request refused.", 403);
    const deps = opts.deps(c);
    const found = await open(c, db);
    if (!found) return dead(c, deps.opts.business);
    const body = await c.req.parseBody();
    await declineProposal(db, found.qt.id, { reason: body.reason, note: body.note }, opts.reasons, deps);
    return c.redirect(new URL(c.req.url).pathname.replace(/\/decline$/, ""), 303);
  }));

  // Anything else under /q/ is a link that does not work.
  app.all("*", (c) => dead(c, opts.deps(c).opts.business));
  return app;
}
