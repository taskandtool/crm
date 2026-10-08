// The public side: POST /forms/:key takes a submission, GET /forms/:key/thanks
// says it arrived, and embedForm puts a form on any page. A form with steps
// (fields.ts stepsOf) keeps a draft between them: POST /forms/:key takes each
// step, GET /forms/:key/next?k=<key> shows the one they are on, and a booking
// or payment step is run by the adapter the app passes in `steps` (steps.ts). Runs on the machine
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
import { envOf } from "../data/env";
import { afterResponse, sendEmail } from "../data/send";
import { HONEYPOT, MIN_FILL_MS, STAMP, makeStamp, verdict } from "../data/spam";
import { newToken, tokenHash, TOKEN_SHAPE } from "../data/token";
import { DRAFT_FIELD, FORM_KEY, STEP_FIELD, sitePath, stepsOf, validate, type Answer, type Errors, type Form, type Input, type Step, type Submission } from "./fields";
import type { FormSteps, StepContext } from "./steps";
import { cameFrom, originFields, readOrigin, REFERRER_FIELD, UTM_FIELD, type Origin } from "./origin";
import { FormView, StepFrame } from "./render";
import { priceOf, withLines, type Price } from "./price";
import { formatMoney } from "../payments/money";
import { draftByKey, finishDraft, finishStep, insertSubmission, loadForm, rewindDraft, saveStep, startDraft, submissionById, type Draft } from "./store";

/** Wraps a body in the app's own page and its content width, so a form with errors looks like the rest of the site. */
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
  /** What runs a form's `booking` and `payment` steps (steps.ts); a form that has one needs it here. */
  steps?: FormSteps;
  /**
   * A submission has just become complete in a visitor's request (forms ending
   * in payment complete in the payments webhook instead: completePaidSubmission).
   * Runs once per submission; a failure is logged, never shown to the visitor.
   * The booking skill confirms a form's booking here (confirm.ts).
   */
  onComplete?: (c: Context, submissionId: string) => void | Promise<void>;
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

    // A later step of a form with steps carries the visitor's key, which only
    // a first step that passed the spam check could have got.
    const steps = stepsOf(form.fields);
    if (!steps.length) return c.notFound();
    const stepped = steps.length > 1 || steps[0].kind !== "fields";
    if (stepped && one(input[DRAFT_FIELD])) return takeStep(c, db, form, steps, input, "ok");

    // A bot is told it succeeded, so it learns nothing to adapt to.
    const stamp = one(input[STAMP]);
    const v = await verdict(form.key, { honeypot: one(input[HONEYPOT]), stamp }, Date.now(), opts.minFillMs ?? MIN_FILL_MS);
    if (v === "drop") return thanks();
    if (stepped) return takeStep(c, db, form, steps, input, v);

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

    const data = { ...withLines(form.fields, r.submission.data), ...origin };
    const id = await insertSubmission(db, { ...r.submission, data, form_key: form.key, source: opts.source, page, status: v === "fast" ? "spam" : "new" });
    if (v === "ok") {
      notifyOwner(c, form, id, r.submission, page, origin);
      await completed(c, String(id));
    }
    return thanks();
  });

  /** Tell the form's notify_emails, through the owner's sender, after the response. */
  /** The submission is complete: what the app does then (opts.onComplete), never in the visitor's way. */
  async function completed(c: Context, submissionId: string) {
    try {
      await opts.onComplete?.(c, submissionId);
    } catch (e) {
      console.error(`forms: onComplete failed for submission ${submissionId}:`, e);
    }
  }

  function notifyOwner(c: Context, form: Form, id: number | string, sub: Submission, page: string | null, origin: Origin) {
    if (opts.notify === false || !form.notify_emails.length) return;
    const link = `${new URL(c.req.url).origin}${opts.adminPath ?? "/admin/forms"}/submissions/${id}`;
    afterResponse(
      c,
      sendEmail(envOf(c), {
        to: form.notify_emails,
        subject: `New ${form.title} submission from ${sub.name || sub.email || "someone"}`,
        text: summary(form, sub, page, link, origin),
        replyTo: sub.email,
      }).then((n) => {
        if (n.status === "failed") console.error(`forms: telling the owner about submission ${id} failed via ${n.via}: ${n.error}`);
      }),
    );
  }

  // ---- forms with steps ------------------------------------------------------

  const thanksPath = (form: Form) => form.redirect_to ?? `/forms/${form.key}/thanks`;
  const nextPath = (form: Form, key: string) => `/forms/${form.key}/next?k=${encodeURIComponent(key)}`;
  /** The questions are all answered once the draft is past the last page of them. */
  const questionsDone = (steps: Step[], step: number) => steps.slice(step).every((st) => st.kind !== "fields");

  /**
   * The questions are done: the draft becomes the submission (once, whichever
   * request gets there), and the owner hears of it once. Also called where a
   * request that saved the last page was cut off before this ran.
   */
  async function submissionOf(c: Context, db: Db, form: Form, steps: Step[], draft: Draft): Promise<string | null> {
    if (draft.submission_id) return draft.submission_id;
    if (!questionsDone(steps, draft.step)) return null;
    const complete = draft.step >= steps.length;
    const done = await finishDraft(db, draft.id, complete);
    if (done?.made && !draft.spam) {
      const sub = await submissionById(db, done.submissionId);
      if (sub) notifyOwner(c, form, done.submissionId, { name: sub.name, email: sub.email, phone: sub.phone, data: sub.data as Submission["data"] }, sub.page, sub.data as Origin);
      if (complete) await completed(c, done.submissionId);
    }
    return done?.submissionId ?? null;
  }

  async function stepContext(c: Context, db: Db, form: Form, steps: Step[], draft: Draft, key: string, at: number): Promise<StepContext | null> {
    const st = steps[at];
    const id = await submissionOf(c, db, form, steps, draft);
    const submission = id ? await submissionById(db, id) : null;
    if (!submission || st.kind === "fields") return null;
    const origin = new URL(c.req.url).origin;
    let price: Price | null = null;
    try {
      price = priceOf(form, submission.data);
    } catch (e) {
      console.error(`forms: ${form.key} submission ${submission.id}: ${(e as Error).message}`);
    }
    return {
      form, field: st.field, submission, action: `/forms/${form.key}`, price,
      hidden: <><input type="hidden" name={DRAFT_FIELD} value={key} /><input type="hidden" name={STEP_FIELD} value={String(at)} /></>,
      next: origin + (at + 1 < steps.length ? nextPath(form, key) : thanksPath(form)),
      self: origin + nextPath(form, key),
    };
  }

  /**
   * Before a step runs, the steps before it still stand (a held time not
   * released). The first that does not sends them back to it, its charge gone.
   */
  async function rewound(c: Context, db: Db, form: Form, steps: Step[], draft: Draft, key: string): Promise<Draft | null> {
    for (let i = 0; i < draft.step; i++) {
      const st = steps[i];
      const run = st.kind === "fields" ? null : opts.steps?.[st.kind];
      if (!run?.stillValid || st.kind === "fields") continue;
      const ctx = await stepContext(c, db, form, steps, draft, key, i);
      if (ctx && !(await run.stillValid(c, ctx))) {
        await rewindDraft(db, draft.id, ctx.submission.id, i, st.field.name);
        return { ...draft, step: i };
      }
    }
    return null;
  }

  /** The step they are on, as a page: a page of questions, or the booking or payment adapter's body. */
  async function showStep(c: Context, db: Db, form: Form, steps: Step[], draft: Draft, key: string, shown: { errors?: Errors; values?: Input; notice?: string } = {}, status = 200) {
    c.header("Referrer-Policy", "no-referrer"); // the key is in this page's address
    c.header("Cache-Control", "no-store");
    const st = steps[draft.step];
    const where = { index: draft.step, count: steps.length, label: st.label, key };
    const notice = shown.notice ? <p role="status" class="rounded-card border border-line-strong bg-panel p-4">{shown.notice}</p> : null;
    if (st.kind === "fields") {
      const body = <>{notice}<FormView form={form} fields={st.fields} step={where} values={shown.values} errors={shown.errors} /></>;
      return c.html(await opts.page(c, form.title, body), status as 200);
    }
    const run = opts.steps?.[st.kind];
    const ctx = run && (await stepContext(c, db, form, steps, draft, key, draft.step));
    if (!run || !ctx) return notWired(c, form, st.kind);
    const body = <StepFrame form={form} step={where}>{notice}{await run.render(c, ctx, shown)}</StepFrame>;
    return c.html(await opts.page(c, form.title, body), status as 200);
  }

  async function notWired(c: Context, form: Form, kind: "booking" | "payment") {
    console.error(`forms: ${form.key} has a ${kind} step, but formRoutes was given no steps.${kind} (the ${kind === "booking" ? "booking" : "payments"} skill's ${kind}Step)`);
    const body = <div><h1 class="text-title font-semibold">This form is not ready yet</h1><p class="mt-4">Its next step cannot run here yet. Nothing you sent is lost.</p></div>;
    return c.html(await opts.page(c, form.title, body), 500);
  }

  async function gone(c: Context, form: Form) {
    const body = <div><h1 class="text-title font-semibold">Start the form again</h1><p class="mt-4">This form could not be found where you left it. <a href={`/forms/${form.key}/start`}>Start again</a>.</p></div>;
    return c.html(await opts.page(c, form.title, body), 404);
  }

  const RELEASED = "The time you picked was not paid for in time and has been released. Pick a time again.";

  /** One step of a form with steps: the first makes the draft, each after it moves it on. */
  async function takeStep(c: Context, db: Db, form: Form, steps: Step[], input: Input, v: "ok" | "fast") {
    const posted = one(input[DRAFT_FIELD]);
    let key: string, draft: Draft;
    if (!posted) {
      // The first page of questions. checkFields keeps questions first, so it is one.
      const st = steps[0];
      if (st.kind !== "fields") return notWired(c, form, st.kind);
      const page = sitePath(one(input._page));
      const origin = readOrigin(one(input[UTM_FIELD]), one(input[REFERRER_FIELD]));
      const r = validate(st.fields, input);
      if (!r.ok) {
        const carried = { utm: one(input[UTM_FIELD]), ref: one(input[REFERRER_FIELD]) };
        const where = { index: 0, count: steps.length, label: st.label };
        const body = <FormView form={form} fields={st.fields} step={where} stamp={one(input[STAMP])} page={page ?? undefined} origin={carried} values={r.values} errors={r.errors} />;
        return c.html(await opts.page(c, form.title, body), 422);
      }
      key = newToken();
      const data = { ...withLines(st.fields, r.submission.data), ...origin };
      draft = await startDraft(db, { ...r.submission, data, form_key: form.key, key_hash: await tokenHash(key), source: opts.source, page, spam: v === "fast" });
    } else {
      const found = TOKEN_SHAPE.test(posted) ? await draftByKey(db, form.key, await tokenHash(posted)) : null;
      if (!found) return gone(c, form);
      key = posted;
      draft = found;
      // A page posted again, or from another tab, is not the step they are on now: show that one, change nothing.
      const at = one(input[STEP_FIELD]);
      if (at !== "" && Number(at) !== draft.step) return c.redirect(nextPath(form, key), 303);
      if (draft.step >= steps.length) {
        await submissionOf(c, db, form, steps, draft);
        return c.redirect(thanksPath(form), 303);
      }
      const st = steps[draft.step];
      if (st.kind === "fields") {
        const r = validate(st.fields, input);
        if (!r.ok) return showStep(c, db, form, steps, draft, key, { errors: r.errors, values: r.values }, 422);
        const data = withLines(st.fields, r.submission.data);
        if (!(await saveStep(db, draft.id, draft.step, { ...r.submission, data }))) return c.redirect(nextPath(form, key), 303);
        draft = { ...draft, step: draft.step + 1 };
      } else {
        // A form sent too fast to be a person books and charges nothing; it is thanked.
        if (draft.spam) return c.redirect(thanksPath(form), 303);
        const back = await rewound(c, db, form, steps, draft, key);
        if (back) return showStep(c, db, form, steps, back, key, { notice: RELEASED });
        const run = opts.steps?.[st.kind];
        const ctx = run && (await stepContext(c, db, form, steps, draft, key, draft.step));
        if (!run || !ctx) return notWired(c, form, st.kind);
        const r = await run.take(c, ctx, input);
        if (!r.ok) return showStep(c, db, form, steps, draft, key, { errors: r.errors, values: input }, 422);
        // A payment that sends them to pay stays the current step: a cancelled
        // checkout comes back to it, and its page says when it is paid.
        const advance = st.kind !== "payment" || !r.redirect;
        const last = draft.step === steps.length - 1;
        const moved = await finishStep(db, draft.id, ctx.submission.id, draft.step, st.field.name, r.charge ?? null, advance, last);
        if (moved && advance && last) await completed(c, ctx.submission.id);
        return c.redirect(r.redirect ?? ctx.next, 303);
      }
    }
    if (questionsDone(steps, draft.step)) await submissionOf(c, db, form, steps, draft);
    return c.redirect(draft.step < steps.length ? nextPath(form, key) : thanksPath(form), 303);
  }

  app.get("/forms/:key/next", async (c) => {
    const formKey = c.req.param("key");
    if (!FORM_KEY.test(formKey)) return c.notFound();
    const db = getDb(c);
    const form = await loadForm(db, formKey);
    if (!form || !form.active) return c.notFound();
    const key = c.req.query("k") ?? "";
    let draft = TOKEN_SHAPE.test(key) ? await draftByKey(db, form.key, await tokenHash(key)) : null;
    if (!draft) return gone(c, form);
    const steps = stepsOf(form.fields);
    if (!steps.length) return c.notFound();
    if (draft.step >= steps.length) {
      await submissionOf(c, db, form, steps, draft);
      return c.redirect(thanksPath(form), 303);
    }
    if (steps[draft.step].kind !== "fields") {
      if (draft.spam) return c.redirect(thanksPath(form), 303);
      const back = await rewound(c, db, form, steps, draft, key);
      if (back) return showStep(c, db, form, steps, back, key, { notice: RELEASED });
    }
    return showStep(c, db, form, steps, draft, key);
  });

  // A form with steps on a page of its own, for a link: its first page, freshly stamped.
  app.get("/forms/:key/start", async (c) => {
    const formKey = c.req.param("key");
    if (!FORM_KEY.test(formKey)) return c.notFound();
    const form = await loadForm(getDb(c), formKey);
    if (!form || !form.active || !stepsOf(form.fields).length) return c.notFound();
    return c.html(await opts.page(c, form.title, await firstPage(c, form)));
  });

  app.get("/forms/:key/thanks", async (c) => {
    const key = c.req.param("key");
    if (!FORM_KEY.test(key)) return c.notFound();
    const form = await loadForm(getDb(c), key);
    if (!form) return c.notFound();
    const body = (
      <div>
        <h1 class="text-title font-semibold">Thank you</h1>
        <p class="mt-4">{form.success_message || "Your message has arrived. We will be in touch soon."}</p>
        {c.req.query("paid") ? <p class="mt-4">Your payment is being confirmed. You will get a receipt by email.</p> : null}
        <div data-cart-clear={form.key} hidden></div>
      </div>
    );
    return c.html(await opts.page(c, "Thank you", body));
  });

  return app;
}

/** The form for a page, freshly stamped, or null when it does not exist or is switched off. */
export async function embedForm(c: Context, db: Db, key: string) {
  const form = await loadForm(db, key);
  if (!form || !form.active || !stepsOf(form.fields).length) return null;
  return firstPage(c, form);
}

/** A form's first page, freshly stamped, saying where the visitor came from. */
async function firstPage(c: Context, form: Form) {
  const steps = stepsOf(form.fields);
  const first = steps[0]?.kind === "fields" ? steps[0] : null;
  const step = steps.length > 1 && first ? { index: 0, count: steps.length, label: first.label } : undefined;
  return (
    <FormView form={form} fields={first?.fields} step={step} stamp={await makeStamp(form.key)} page={c.req.path} origin={originFields(c)} />
  );
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
    if (f.type === "items" || !Object.hasOwn(s.data, f.name)) continue;
    lines.push(`${f.label}: ${show(s.data[f.name]).replace(/\n/g, "\n    ")}`);
  }
  // What was ordered, at the prices it was taken at, and the total. This is
  // sent once the questions are answered, before a booking or payment step.
  let price: Price | null = null;
  try {
    price = priceOf(form, s.data);
  } catch (e) {
    console.error(`forms: no total for the email about form ${form.key}:`, e);
  }
  if (price) {
    lines.push("");
    for (const l of price.lines) lines.push(`${l.quantity > 1 ? `${l.quantity} x ${l.label}` : l.label}: ${formatMoney(l.quantity * l.unit_cents, price.currency)}`);
    const step = (type: string) => form.fields.find((f) => f.type === type);
    lines.push(`Total${step("payment")?.tax_rate_id ? " before tax" : ""}: ${formatMoney(price.subtotal_cents, price.currency)}`);
    if (step("booking")) lines.push("A booking's price, if it has one, is added when they pick a time.");
    if (step("payment")) lines.push("They pay next, by card through Stripe; the submission shows when it is paid.");
  }
  if (page) lines.push("", `Sent from ${page}`);
  const from = cameFrom(origin);
  if (from) lines.push(`Came from ${from}`);
  return lines.join("\n");
}
