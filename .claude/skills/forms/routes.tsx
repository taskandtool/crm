// The public side: POST /forms/:key takes a submission, GET /forms/:key/thanks
// says it arrived, and embedForm puts a form on any page. Runs on the machine
// and in the edge Worker alike: web APIs only, the database through a Db.
//
//   import { formRoutes, embedForm } from "./forms/routes";
//   const getDb = (c: Context) => fromNeon(envVar(c, "DATABASE_URL"));
//   const page = (c: Context, title: string, body: Child) => render({ path: c.req.path, title, description: title }, body);
//   app.route("/", formRoutes(getDb, { source: "website", page }));
//   app.get("/contact", async (c) => {
//     const form = await embedForm(c, getDb(c), "contact");
//     return c.html(render(Contact.page, <Contact.Body form={form} />));
//   });
//
// The page with the form is a route, not a pre-rendered page: it reads the
// definition the owner last saved, stamps the time it was served, and reads
// where the visitor came from (origin.ts).
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import type { Db, GetDb } from "../data/db";
import { envOf, envVar } from "../data/env";
import { afterResponse, sendEmail } from "../data/send";
import { HONEYPOT, MIN_FILL_MS, STAMP, makeStamp, verdict } from "../data/spam";
import { FORM_KEY, sitePath, validate, type Answer, type Form, type Input, type Submission } from "./fields";
import { cameFrom, originFields, readOrigin, REFERRER_FIELD, UTM_FIELD, type Origin } from "./origin";
import { FormView } from "./render";
import { insertSubmission, loadForm } from "./store";

/** Wraps a body in the app's own page, so a form with errors looks like the rest of the site. */
export type PageRenderer = (c: Context, title: string, body: Child) => string | Promise<string>;

export type FormRoutesOptions = {
  /** This app's slug, stored as the submission's source. */
  source: string;
  page: PageRenderer;
  /** Where the private submission views are mounted, for the link in the owner's email. */
  adminPath?: string;
  /** Email the form's notify_emails through the connected sender (data/send.ts). Default true. */
  notify?: boolean;
  minFillMs?: number;
};

/** A post larger than this is refused before it is read. */
export const MAX_BODY = 32 * 1024;

export function formRoutes(getDb: GetDb, opts: FormRoutesOptions) {
  const app = new Hono();

  app.post("/forms/:key", async (c) => {
    const key = c.req.param("key");
    if (!FORM_KEY.test(key)) return c.notFound();
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.text("This form is too large to send.", 413);
    if (!(c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      return c.text("Send this form from its page.", 415);
    }
    // Content-Length is only a claim, and a chunked post has none: stop
    // reading once the body passes the limit instead of buffering it whole.
    const text = await readCapped(c.req.raw, MAX_BODY);
    if (text === null) return c.text("This form is too large to send.", 413);
    const input = readInput(text);

    const db = getDb(c);
    const form = await loadForm(db, key);
    if (!form || !form.active) return c.notFound();
    const thanks = () => c.redirect(form.redirect_to ?? `/forms/${form.key}/thanks`, 303);

    // A bot is told it succeeded, so it learns nothing to adapt to.
    const stamp = one(input[STAMP]);
    const secret = envVar(c, "SPAM_SECRET");
    const v = await verdict(form.key, { honeypot: one(input[HONEYPOT]), stamp }, secret, Date.now(), opts.minFillMs ?? MIN_FILL_MS);
    if (v === "drop") return thanks();

    const page = sitePath(one(input._page));
    const origin = readOrigin(one(input[UTM_FIELD]), one(input[REFERRER_FIELD]));
    const r = validate(form.fields, input);
    if (!r.ok) {
      // The stamp they were served goes back unchanged, so fixing one answer
      // quickly is not mistaken for a bot; where they came from goes back too.
      const carried = { utm: one(input[UTM_FIELD]), ref: one(input[REFERRER_FIELD]) };
      const body = <FormView form={form} stamp={stamp} page={page ?? undefined} origin={carried} values={r.values} errors={r.errors} />;
      return c.html(await opts.page(c, form.title, body), 422);
    }

    const data = { ...r.submission.data, ...origin };
    const id = await insertSubmission(db, { ...r.submission, data, form_key: form.key, source: opts.source, page, status: v === "fast" ? "spam" : "new" });
    if (v === "ok" && opts.notify !== false && form.notify_emails.length) {
      const link = `${new URL(c.req.url).origin}${opts.adminPath ?? "/admin/forms"}/submissions/${id}`;
      afterResponse(
        c,
        sendEmail(envOf(c), {
          to: form.notify_emails,
          subject: `New ${form.title} submission from ${r.submission.name || r.submission.email || "someone"}`,
          text: summary(form, r.submission, page, link, origin),
          replyTo: r.submission.email,
        }).then((n) => {
          if (n.status === "failed") console.error(`forms: telling the owner about submission ${id} failed via ${n.via}: ${n.error}`);
        }),
      );
    }
    return thanks();
  });

  app.get("/forms/:key/thanks", async (c) => {
    const key = c.req.param("key");
    if (!FORM_KEY.test(key)) return c.notFound();
    const form = await loadForm(getDb(c), key);
    if (!form) return c.notFound();
    const body = (
      <section class="mx-auto max-w-xl px-5 py-12">
        <h1 class="text-title font-semibold">Thank you</h1>
        <p class="mt-4">{form.success_message || "Your message has arrived. We will be in touch soon."}</p>
      </section>
    );
    return c.html(await opts.page(c, "Thank you", body));
  });

  return app;
}

/** The form for a page, freshly stamped, or null when it does not exist or is switched off. */
export async function embedForm(c: Context, db: Db, key: string) {
  const form = await loadForm(db, key);
  if (!form || !form.active) return null;
  return <FormView form={form} stamp={await makeStamp(form.key, envVar(c, "SPAM_SECRET"))} page={c.req.path} origin={originFields(c)} />;
}

async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) {
    all.set(ch, at);
    at += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

// No prototype: a posted "__proto__" is a plain key, never the object's prototype.
function readInput(text: string): Input {
  const params = new URLSearchParams(text);
  const input: Input = Object.create(null);
  for (const k of new Set(params.keys())) {
    const all = params.getAll(k);
    input[k] = all.length > 1 ? all : all[0];
  }
  return input;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The owner's email about one submission, as plain text. */
export function summary(form: Form, s: Submission, page: string | null, link: string, origin: Origin = {}): string {
  const show = (v: Answer) => (Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : String(v));
  // The link comes first, and a long answer's later lines are indented, so
  // what a visitor typed cannot pass for a line of ours.
  const lines = [`New submission to ${form.title}.`, `Open it: ${link}`, ""];
  if (s.name) lines.push(`Name: ${s.name}`);
  if (s.email) lines.push(`Email: ${s.email}`);
  if (s.phone) lines.push(`Phone: ${s.phone}`);
  for (const f of form.fields) {
    if (Object.hasOwn(s.data, f.name)) lines.push(`${f.label}: ${show(s.data[f.name]).replace(/\n/g, "\n    ")}`);
  }
  if (page) lines.push("", `Sent from ${page}`);
  const from = cameFrom(origin);
  if (from) lines.push(`Came from ${from}`);
  return lines.join("\n");
}
