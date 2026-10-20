// The team's side of the phone, private (teamOnly): the setup page (the
// number, its calls, the texting registration, the six automatic texts and
// each one's picture), and Messages (every number's thread, with the reply
// box). Built on admin/; every form works without JavaScript; the thread
// reloads every ten seconds with htmx while it is open.
//
//   app.route("/phone", phoneSettings(getDb, { base: "/phone", messages: "/messages", css, ctx, timeZone }));
//   app.route("/messages", messagesRoutes(getDb, { base: "/messages", settings: "/phone", css, ctx, timeZone }));
//
// Without Twilio the setup page shows the Connect Twilio panel and the
// flows as they would be; Messages is the app's to leave out of its nav.
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { businessOf, type Business } from "../data/business";
import type { GetDb } from "../data/db";
import { textingBox } from "../forms/consent";
import { Section } from "../admin/detail";
import { alertClass, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { sectionPages, type Frame, type NavItem } from "../admin/layout";
import { AskAi, EmptyState, SetupNeeded, When } from "../admin/list";
import { buttonClass, fieldClass, inputClass, linkClass, primaryClass, quietClass, Select, smallText } from "../admin/status";
import { phoneKey, saveLead, savePerson } from "../customers/customer";
import { fill, FILL_SAYS, FLOWS, flowOf, flowSettings, isFlowKey, resetWords, setEnabled, setWords, WORDS, EMAILS, type Fill, type FillKey, type Flow, type FlowKey, type FlowSettings, type Step as FlowStep } from "./flows";
import { exampleFill, flowCounts } from "./follow";
import { check, optInPage, steps as registrationSteps, type Step as RegStep } from "./registration";
import { fillEmail, sendText, type PhoneCtx } from "./send";
import { adopt, buy, callOut, point, unhook } from "./setup";
import {
  markRead, markUnread, numberById, numbers, seeMessages, ownerOf, prettyPhone, saveCallSettings, setThreadContact, thread, threads,
  toE164, unreadThreads, mainNumber, type Communication, type PhoneNumber, type Thread,
} from "./store";
import { twilioConnected, type AvailableNumber, type OwnedNumber } from "./twilio";

type Team = Context<{ Variables: TeamVars }>;

export type PhoneAdminOptions = {
  base: string;
  /** Where Messages is mounted, and where the setup page is. */
  messages: string;
  settings: string;
  css: string;
  Frame?: Frame;
  nav?: NavItem[];
  /** This request's phone context (send.ts PhoneCtx). */
  ctx: (c: Context) => PhoneCtx | Promise<PhoneCtx>;
  timeZone: string;
  /** A contact's page in the app ("/customers/12"). */
  contactHref?: (id: string) => string;
  /** A form's page, where its "Follow up automatically" switch is. */
  formHref?: (key: string) => string;
  /** The phone a new number rings until someone changes it: the person setting it up. */
  defaultRingTo?: (c: Team) => Promise<string | null> | string | null;
  /** A lead made from Messages (Create lead): the app adds its Call back task. */
  onLead?: (c: Team, l: { customerId: string; leadId: string; title: string }) => void | Promise<void>;
  /** Where the business's name and its privacy and terms pages are set (data/business.ts): the app's Business settings. */
  businessHref: string;
};

const MESSAGES: FlashMessages = {
  bought: "Your number is ready. Calls to it ring the phone below.",
  calls: "Saved.",
  "test-call": "Calling your phone now.",
  checked: "Checked with Twilio.",
  flow: "Saved.",
  words: "Saved. This is what goes from now on.",
  "words-reset": "Back to our words.",
  removed: "Removed. The number is still yours on Twilio, and its calls ring your phone directly.",
  "no-number": { error: "Choose a number first." },
  "twilio-error": { error: "Twilio didn't do it. The page says why." },
  sent: "Sent.",
  calling: "Calling your phone. Answer it and we'll ring them.",
  unread: "Marked unread.",
  lead: "Lead made.",
  contact: "Saved whose number it is.",
};

const STATE_DOT: Record<string, string> = { done: "bg-accent", waiting: "bg-ink-3", failed: "bg-ink", todo: "bg-line-strong" };

// ---- the setup page --------------------------------------------------------------

export function phoneSettings(getDb: GetDb, opts: PhoneAdminOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const framed = sectionPages({ Frame: opts.Frame, css: opts.css, label: "Phone and texts", links: opts.nav ?? [], messages: MESSAGES });
  const back = (c: Team, code: string, hash = "") => c.redirect(withFlash(base, code) + hash, 303);
  const problem = async (c: Team, why: string) => {
    const ctx = await opts.ctx(c);
    return framed(c, base, "Phone and texts", <><p role="alert" class={"mb-4 " + alertClass}>{why}</p>{await page(c, ctx)}</>, 422);
  };

  async function page(c: Team, ctx: PhoneCtx): Promise<Child> {
    const db = getDb(c);
    const connected = ctx.provider ? await twilioConnected(ctx.env) : false;
    const [settings, all, counts] = await Promise.all([flowSettings(db), numbers(db), flowCounts(db)]);
    const main = all[0] ?? null;
    const name = ctx.unnamed ? (
      <section class="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 class="mb-1 text-base/7 font-semibold text-ink">Give your texts the business's name</h2>
        <p class="max-w-prose text-ink-2">Every text names the business, so customers know who it is. Until it's set, they say "it's us", and the texting box stays off your forms.</p>
        <a href={opts.businessHref} class={primaryClass + " mt-3 inline-block no-underline"}>Set the name</a>
      </section>
    ) : null;
    if (connected === false || !ctx.provider) {
      return (
        <div class="space-y-6">
          {name}
          <SetupNeeded title="Connect Twilio for a business number" ask="Connect my Twilio account so customers can call and text my business number.">
            Customers call and text one number. It rings your phone, a missed call gets a text back, and replies land in Messages. Twilio bills you
            directly, about $1.15 a month for the number and under a cent a text. Connect Twilio to this app in Task &amp; Tool, on the app's Connections tab.
          </SetupNeeded>
          <FlowList base={base} settings={settings} counts={counts} texting={false} />
        </div>
      );
    }
    const account = await ctx.provider.account().catch(() => null);
    const area = c.req.query("area") ?? "";
    const offered: AvailableNumber[] = !main && /^\d{3}$/.test(area) ? await ctx.provider.searchNumbers({ areaCode: area, limit: 10 }).catch(() => []) : [];
    const owned: OwnedNumber[] = !main && c.req.query("owned") === "1" ? await ctx.provider.ownedNumbers().catch(() => []) : [];
    const ringTo = main?.ring_to ?? (await opts.defaultRingTo?.(c)) ?? "";
    return (
      <div class="space-y-6">
        {name}
        <Section title="1. Twilio account">
          <p>
            Connected{account ? <>: <strong>{account.name}</strong>{account.balance ? <>, balance {account.currency === "USD" ? "$" : ""}{Number(account.balance).toFixed(2)}{account.currency && account.currency !== "USD" ? ` ${account.currency}` : ""}</> : null}</> : "."}
            {account?.trial ? " A trial account rings and texts only the numbers you verify in Twilio." : null}
          </p>
          {account?.balance && Number(account.balance) < 5 ? <p class="mt-2 font-semibold">Your Twilio balance is low. Calls and texts stop when it runs out.</p> : null}
        </Section>

        <Section title="2. Your number">
          {main ? (
            <div class="space-y-3">
              {all.map((n) => (
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p><strong class="tabular-nums">{prettyPhone(n.e164)}</strong> <span class="text-ink-2">{n.label}</span></p>
                  {n.id !== main.id ? (
                    <form method="post" action={`${base}/numbers/${n.id}/remove`}><button class={quietClass}>Stop using</button></form>
                  ) : null}
                </div>
              ))}
              <details class="pt-2">
                <summary class={linkClass + " cursor-pointer"}>Add another number</summary>
                <p class={smallText + " mt-2 text-ink-2"}>One for the van or an ad: calls and texts to it come here too, and show which number they came in on.</p>
                <NumberSearch base={base} area={area} offered={offered} owned={owned} label="Van" />
              </details>
            </div>
          ) : (
            <div class="space-y-3">
              <p>Pick a number customers will call and text. It's yours on your Twilio account, about $1.15 a month.</p>
              <NumberSearch base={base} area={area} offered={offered} owned={owned} label="Business number" />
              <p class={smallText + " text-ink-2"}>
                Keep your current number instead? Twilio can move it to your account: start in Twilio's Console, under Phone Numbers, Port a number.
                It takes a week or more; meanwhile, forward your old number to the new one.
              </p>
            </div>
          )}
        </Section>

        {main ? (
          <Section title="3. Calls">
            <form method="post" action={`${base}/numbers/${main.id}/calls`} class="grid gap-4 sm:max-w-lg">
              <label class={fieldClass}>The phone to ring
                <input name="ring_to" type="tel" value={ringTo} required class={inputClass} autocomplete="tel" />
                <span class={smallText + " text-ink-2"}>Your cell. You'll hear "Press 1 to answer" first, so your own voicemail never takes a customer's call.</span>
              </label>
              <label class={fieldClass}>Ring for
                <Select name="ring_seconds" class="w-40">
                  {[15, 20, 25, 30].map((s) => <option value={String(s)} selected={main.ring_seconds === s}>{s} seconds</option>)}
                </Select>
              </label>
              <label class="flex items-center gap-2"><input type="checkbox" name="voicemail" value="1" checked={main.voicemail} /> Take a voicemail when nobody answers</label>
              <label class="flex items-start gap-2"><input type="checkbox" name="record_calls" value="1" checked={main.record_calls} class="mt-1.5" />
                <span>Record calls<span class={"block " + smallText + " text-ink-2"}>Callers and you will hear "This call may be recorded." Some states require both people to know.</span></span>
              </label>
              <input type="hidden" name="label" value={main.label} />
              <div class="flex flex-wrap gap-2">
                <button class={primaryClass}>Save</button>
              </div>
            </form>
            <form method="post" action={`${base}/numbers/${main.id}/test`} class="mt-3">
              <button class={buttonClass} disabled={!main.ring_to}>Call me to try it</button>
            </form>
            <p class={smallText + " mt-3 text-ink-2"}>When nobody answers, callers hear your closed message outside the team's hours (Settings, Team).</p>
          </Section>
        ) : null}

        {main ? <Registration base={base} n={main} settings={settings} business={await businessOf(db)} optIn={await optInPage(db, await ctx.links())} box={await textingBox(db, "request")} businessHref={opts.businessHref} /> : null}

        <section>
          <h2 class="mb-1 text-base/7 font-semibold text-ink">{main ? "5. Automatic texts" : "Automatic texts"}</h2>
          <p class={smallText + " mb-3 text-ink-2"}>
            {main?.texting === "approved" ? "Switch each on or off. Open one to see what it sends." : "You can switch them on now; they start once your number can text."}
            {" "}Where a text can't go, flows that can send an email instead.
          </p>
          <FlowList base={base} settings={settings} counts={counts} texting={main?.texting === "approved"} />
        </section>
      </div>
    );
  }

  app.get("/", async (c) => {
    const ctx = await opts.ctx(c);
    return framed(c, base, { title: "Phone and texts", sub: "Your business number, its calls, and the texts that go on their own." }, await page(c, ctx));
  });

  app.post("/buy", async (c) => {
    const ctx = await opts.ctx(c);
    if (!ctx.provider) return problem(c, "Connect Twilio first.");
    const f = await c.req.parseBody();
    const first = !(await mainNumber(getDb(c)));
    const ring = toE164(String(f.ring_to ?? "")) ?? toE164((await opts.defaultRingTo?.(c)) ?? "");
    const r = await buy(getDb(c), ctx.provider, ctx.env, { e164: String(f.e164 ?? ""), label: String(f.label ?? "").trim().slice(0, 60) || (first ? "Business number" : "Another number"), ringTo: ring }, c.get("user")).catch((e) => ({ ok: false as const, why: `Twilio: ${e.message}` }));
    return r.ok ? back(c, "bought") : problem(c, r.why);
  });

  app.post("/adopt", async (c) => {
    const ctx = await opts.ctx(c);
    if (!ctx.provider) return problem(c, "Connect Twilio first.");
    const f = await c.req.parseBody();
    const ring = toE164((await opts.defaultRingTo?.(c)) ?? "");
    const r = await adopt(getDb(c), ctx.provider, ctx.env, { providerId: String(f.sid ?? ""), label: String(f.label ?? "").trim().slice(0, 60) || "Business number", ringTo: ring }, c.get("user")).catch((e) => ({ ok: false as const, why: `Twilio: ${e.message}` }));
    return r.ok ? back(c, "bought") : problem(c, r.why);
  });

  app.post("/numbers/:id/calls", async (c) => {
    const db = getDb(c);
    const n = await numberById(db, c.req.param("id"));
    if (!n) return c.notFound();
    const f = await c.req.parseBody();
    const ringTo = toE164(String(f.ring_to ?? ""));
    if (!ringTo) return problem(c, "Enter the phone to ring, like (555) 201-0142.");
    const secs = [15, 20, 25, 30].includes(Number(f.ring_seconds)) ? Number(f.ring_seconds) : 20;
    await saveCallSettings(db, n.id, { label: String(f.label ?? n.label).slice(0, 60) || n.label, ring_to: ringTo, ring_seconds: secs, voicemail: f.voicemail === "1", record_calls: f.record_calls === "1" });
    // The fallback rings this phone: point the number again when it changes.
    const ctx = await opts.ctx(c);
    if (ctx.provider && ringTo !== n.ring_to) {
      const p = await point(db, ctx.provider, ctx.env, { ...n, ring_to: ringTo }).catch((e) => ({ ok: false as const, why: e.message }));
      if (!p.ok) return problem(c, `Saved, but Twilio wasn't updated: ${p.why}`);
    }
    return back(c, "calls");
  });

  app.post("/numbers/:id/test", async (c) => {
    const db = getDb(c);
    const n = await numberById(db, c.req.param("id"));
    const ctx = await opts.ctx(c);
    if (!n || !ctx.provider || !n.ring_to || !n.hooks_url) return problem(c, "Set the phone to ring first.");
    try {
      // Fixed words (hooks.ts /test), and nothing kept: the owner's own phone is not a thread in Messages.
      await ctx.provider.startCall({ from: n.e164, to: n.ring_to, twimlUrl: `${n.hooks_url}/test?n=${n.id}` });
    } catch (e) {
      return problem(c, `Twilio didn't call: ${e instanceof Error ? e.message : String(e)}`);
    }
    return back(c, "test-call");
  });

  app.post("/numbers/:id/remove", async (c) => {
    const db = getDb(c);
    const n = await numberById(db, c.req.param("id"));
    const main = await mainNumber(db);
    if (!n || n.id === main?.id) return c.notFound();
    const ctx = await opts.ctx(c);
    // Twilio must be told first, or its calls and texts would keep coming here to a number this app no longer knows.
    if (!ctx.provider) return problem(c, "Connect Twilio first, so its calls can be pointed back at your phone.");
    try {
      await unhook(db, ctx.provider, n);
    } catch (e) {
      return problem(c, `Twilio didn't take the change: ${e instanceof Error ? e.message : String(e)}`);
    }
    return back(c, "removed");
  });

  app.post("/registration/check", async (c) => {
    const db = getDb(c);
    const ctx = await opts.ctx(c);
    const n = await mainNumber(db);
    if (!n || !ctx.provider) return back(c, "no-number");
    const r = await check(db, ctx.provider, n);
    return r.reg.last_error ? problem(c, r.reg.last_error) : back(c, "checked", "#texting");
  });

  app.post("/flows/:key", async (c) => {
    const key = c.req.param("key");
    if (!isFlowKey(key)) return c.notFound();
    const f = await c.req.parseBody();
    await setEnabled(getDb(c), key, f.enabled === "1", c.get("user"));
    const to = f.return === "flow" ? `${base}/flows/${key}` : base;
    return c.redirect(withFlash(to, "flow"), 303);
  });

  // The owner's own words for one of a flow's texts, checked as the AI's command checks them; "Use ours" puts ours back.
  app.post("/flows/:key/words", async (c) => {
    const key = c.req.param("key");
    if (!isFlowKey(key)) return c.notFound();
    const f = await c.req.parseBody();
    const variant = typeof f.variant === "string" ? f.variant : "";
    if (!Object.hasOwn(WORDS[key], variant)) return c.notFound();
    if (f.reset === "1") {
      await resetWords(getDb(c), key, variant, c.get("user"));
      return c.redirect(withFlash(`${base}/flows/${key}`, "words-reset"), 303);
    }
    const r = await setWords(getDb(c), key, variant, typeof f.words === "string" ? f.words : "", c.get("user"));
    if (!r.ok) return flowPage(c, key, { variant, words: String(f.words ?? ""), why: r.why });
    return c.redirect(withFlash(`${base}/flows/${key}`, "words"), 303);
  });

  app.get("/flows/:key", async (c) => {
    const key = c.req.param("key");
    if (!isFlowKey(key)) return c.notFound();
    return flowPage(c, key);
  });

  /** A flow's page; `refused`: words the owner tried, kept in their box with why they didn't save. */
  async function flowPage(c: Team, key: FlowKey, refused?: { variant: string; words: string; why: string }) {
    const db = getDb(c);
    const ctx = await opts.ctx(c);
    const [settings, counts, example, main, forms] = await Promise.all([flowSettings(db), flowCounts(db), exampleFill(ctx), mainNumber(db), formsFor(db, key)]);
    const flow = flowOf(key);
    const s = settings[key];
    const texting = !!ctx.provider && main?.texting === "approved";
    return framed(c, base, { title: flow.name, back: { href: base, label: "Phone and texts" }, sub: flow.summary }, (
      <FlowPicture flow={flow} s={s} example={example} nameHref={ctx.unnamed ? opts.businessHref : null} count={counts[key]} texting={texting} hasNumber={!!main} forms={forms} formHref={opts.formHref} action={`${base}/flows/${key}`} refused={refused} />
    ), refused ? 422 : 200);
  }

  return app;
}

/** The forms a flow runs on, for its header. */
async function formsFor(db: ReturnType<GetDb>, key: FlowKey): Promise<{ key: string; title: string }[] | null> {
  if (key !== "thanks" && key !== "unbooked") return null;
  const rows = await db.sql<{ key: string; title: string; fields: { type: string }[] }>`
    select key, title, fields from forms f where to_jsonb(f)->>'follow_up' = 'true' and active order by title`.catch(() => []);
  return rows.filter((r) => (key === "unbooked") === (r.fields ?? []).some((f) => f.type === "booking")).map((r) => ({ key: r.key, title: r.title }));
}

function NumberSearch({ base, area, offered, owned, label }: { base: string; area: string; offered: AvailableNumber[]; owned: OwnedNumber[]; label: string }) {
  return (
    <div class="mt-3 space-y-3">
      <form method="get" action={base} class="flex flex-wrap items-end gap-2">
        <label class={fieldClass}>Area code
          <input name="area" value={area} inputmode="numeric" pattern="[0-9]{3}" maxlength={3} required class={inputClass + " w-28"} />
        </label>
        <button class={buttonClass}>Find numbers</button>
        <a href={`${base}?owned=1`} class={quietClass}>Use one already on my Twilio account</a>
      </form>
      {area && !offered.length ? <p class="text-ink-2">No numbers with that area code just now. Try a neighbouring one.</p> : null}
      {offered.length ? (
        <ul class="divide-y divide-line rounded-card border border-line">
          {offered.map((n) => (
            <li class="flex items-center justify-between gap-2 px-3 py-2">
              <span><strong class="tabular-nums">{n.pretty}</strong> <span class="text-ink-2">{[n.locality, n.region].filter(Boolean).join(", ")}</span></span>
              <form method="post" action={`${base}/buy`}>
                <input type="hidden" name="e164" value={n.e164} />
                <input type="hidden" name="label" value={label} />
                <button class={buttonClass}>Choose</button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
      {owned.length ? (
        <ul class="divide-y divide-line rounded-card border border-line">
          {owned.map((n) => (
            <li class="flex items-center justify-between gap-2 px-3 py-2">
              <span><strong class="tabular-nums">{n.pretty}</strong> <span class="text-ink-2">{n.label}</span></span>
              <form method="post" action={`${base}/adopt`}>
                <input type="hidden" name="sid" value={n.id} />
                <input type="hidden" name="label" value={label} />
                <button class={buttonClass}>Use this one</button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The texting registration, made by the owner in Twilio's Console (the path
 * Twilio documents for a business registering itself): each step's state as
 * Twilio has it, where it is in the Console, and our words to paste.
 */
function Registration({ base, n, settings, business, optIn, box, businessHref }: { base: string; n: PhoneNumber; settings: Record<FlowKey, FlowSettings>; business: Business; optIn: string | null; box: string | null; businessHref: string }) {
  const rows = registrationSteps(n, business, optIn, settings);
  const next = rows.find((r) => r.state !== "done");
  const set = <a href={businessHref} class={linkClass}>Settings, Business</a>;
  return (
    <section id="texting" class="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 class="mb-1 text-base/7 font-semibold text-ink">4. Texting</h2>
      <p class={smallText + " mb-3 max-w-prose text-ink-2"}>
        {n.texting === "approved" ? "Your number can text." : <>US carriers block business texts until the number is registered. Calls work now. You register in Twilio's Console, at <a href="https://console.twilio.com" target="_blank" rel="noopener" class={linkClass}>console.twilio.com</a>, with the words below; this page follows each step, checking every hour.</>}
      </p>
      {n.texting !== "approved" ? (
        <div class="mb-4 space-y-2 rounded-control bg-panel p-3">
          <p class="font-medium">What carriers check</p>
          <p>
            <strong>Name:</strong> {business.name ?? <span class="font-semibold">not set yet</span>}.{" "}
            <strong>Privacy page:</strong> {business.privacyUrl ?? <span class="font-semibold">none yet</span>}.{" "}
            <strong>Terms page:</strong> {business.termsUrl ?? "none"}. Change them in {set}.
          </p>
          {box ? (
            <>
              <p><strong>The texting box on your forms reads:</strong> {box}</p>
              <p>{optIn ? <>Reviewers open <a href={optIn} target="_blank" rel="noopener" class={linkClass}>{optIn}</a> to see it, so keep it public.</> : <span class="font-semibold">Customers can't open a page with the box yet. Before you register, put a form with "Follow up automatically" on where customers can open it.</span>}</p>
            </>
          ) : <p class="font-semibold">The texting box shows on your forms once the business has a name. Carriers turn down a registration whose box they can't see.</p>}
        </div>
      ) : null}
      <ol class="space-y-4">
        {rows.map((r) => <RegistrationStep r={r} open={r === next} />)}
      </ol>
      {n.registration.last_error ? <p role="alert" class="mt-3 font-semibold">{n.registration.last_error}</p> : null}
      {n.texting !== "approved" ? (
        <form method="post" action={`${base}/registration/check`} class="mt-4"><button class={buttonClass}>Check with Twilio now</button></form>
      ) : null}
    </section>
  );
}

/** One registration step: its state, where in the Console, and each field's words with a Copy button. */
function RegistrationStep({ r, open }: { r: RegStep; open: boolean }) {
  return (
    <li class="flex gap-3">
      <span aria-hidden="true" class={"mt-2 size-2 shrink-0 rounded-full " + STATE_DOT[r.state]}></span>
      <div class="min-w-0 flex-1">
        <p><strong>{r.label}</strong>: {r.says}</p>
        {r.errors.length ? <ul class="mt-1 list-disc pl-5 text-ink-2">{r.errors.map((e) => <li>{e}</li>)}</ul> : null}
        {r.where && r.state !== "done" ? <p class={smallText + " mt-1 text-ink-2"}>{r.where}</p> : null}
        {r.paste?.length ? (
          <details class="mt-2" open={open}>
            <summary class={linkClass + " cursor-pointer text-label"}>The words to paste</summary>
            <dl class="mt-2 space-y-3">
              {r.paste.map((p) => (
                <div>
                  <dt class="text-label font-medium text-ink-2">{p.field}</dt>
                  <dd class="mt-1 flex items-start gap-2">
                    <span class="min-w-0 flex-1 rounded-control bg-panel px-2 py-1">{p.words}</span>
                    <button type="button" class={buttonClass} onclick={`navigator.clipboard.writeText(${JSON.stringify(p.words)}).then(() => { this.textContent = "Copied" })`}>Copy</button>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function FlowList({ base, settings, counts, texting }: { base: string; settings: Record<FlowKey, FlowSettings>; counts: Record<string, { sent: number; outcome: number }>; texting: boolean }) {
  return (
    <ul class="divide-y divide-line rounded-card border border-line bg-surface shadow-card">
      {FLOWS.map((f) => {
        const s = settings[f.key];
        const n = counts[f.key];
        return (
          <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div class="min-w-0">
              <a href={`${base}/flows/${f.key}`} class="font-semibold text-ink no-underline hover:underline">{f.name}</a>
              <p class={smallText + " text-ink-2"}>
                {f.summary}{n?.sent ? ` ${outcomeText(f, n)}` : ""}
                {texting ? null : f.email ? " Goes by email until your number can text." : " Starts once your number can text."}
              </p>
            </div>
            <Switch action={`${base}/flows/${f.key}`} on={s.enabled} label={f.name} />
          </li>
        );
      })}
    </ul>
  );
}

const outcomeText = (f: Flow, n: { sent: number; outcome: number }) =>
  `Last 30 days: ${n.sent} sent${f.outcome === "booked" ? `, ${n.outcome} booked` : f.outcome === "replied" ? `, ${n.outcome} replied` : ""}.`;

/** An on/off switch, as a form: a press posts the other state. Drawn as a toggle, not a button, so a page of them has no primary. */
function Switch({ action, on, label, back }: { action: string; on: boolean; label: string; back?: string }) {
  return (
    <form method="post" action={action} class="flex shrink-0 items-center gap-2">
      <input type="hidden" name="enabled" value={on ? "0" : "1"} />
      {back ? <input type="hidden" name="return" value={back} /> : null}
      <span aria-hidden="true" class="text-label text-ink-2">{on ? "On" : "Off"}</span>
      <button role="switch" aria-checked={on ? "true" : "false"} aria-label={label}
        class={"relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " + (on ? "bg-accent" : "bg-line-strong")}>
        <span class={"size-5 rounded-full bg-surface shadow-card transition-transform " + (on ? "translate-x-5" : "translate-x-0")}></span>
      </button>
    </form>
  );
}

const STEP_LABEL: Record<FlowStep["kind"], string> = { start: "Starts", wait: "Waits", text: "Sends", end: "Ends" };

/**
 * A flow as a list of its steps, top to bottom: when it starts, each wait,
 * each text as a bubble with a real contact's details filled in (and its
 * other wordings as side notes), the replies it understands, and what stops
 * it. Drawn from the flow's own definition, so it shows what is sent.
 */
export function FlowPicture(props: {
  flow: Flow; s: FlowSettings; example: Fill & { sample: boolean }; nameHref: string | null; count?: { sent: number; outcome: number }; texting: boolean; hasNumber: boolean;
  forms: { key: string; title: string }[] | null; formHref?: (key: string) => string; action: string;
  refused?: { variant: string; words: string; why: string };
}) {
  const { flow, s, example, nameHref, count, texting, hasNumber, forms, formHref, action, refused } = props;
  const words = (v: string) => fill(s.words[v] ?? WORDS[flow.key][v] ?? "", example);
  const emailOf = (v: string) => EMAILS[flow.key]?.[v];
  const channel = texting ? "text" : flow.email ? "email" : null;
  return (
    <div class="space-y-6">
      <div class="flex flex-wrap items-start justify-between gap-3 rounded-card border border-line bg-surface p-4 shadow-card">
        <div>
          <p>{flow.where}</p>
          {forms ? (
            forms.length ? <p class="mt-1 text-ink-2">On for: {forms.map((f, i) => <>{i ? ", " : ""}{formHref ? <a href={formHref(f.key)} class={linkClass}>{f.title}</a> : f.title}</>)}.</p>
            : <p class="mt-1 font-semibold">No form has "Follow up automatically" on yet, so this sends nothing.</p>
          ) : null}
          {!channel ? <p class="mt-1 font-semibold">{hasNumber ? "Starts once your number can text." : "Starts once you have a business number."}</p> : null}
          {channel === "email" ? <p class="mt-1 text-ink-2">Until your number can text, this goes by email where it can.</p> : null}
        </div>
        <Switch action={action} on={s.enabled} label={flow.name} back="flow" />
      </div>

      <p class="text-ink-2">
        {example.sample ? `Shown with a sample name, ${example.first_name}.` : `Shown as ${example.first_name}, your newest contact, would see it.`} Each person gets their own name.
        {nameHref ? <> Your texts say "it's us" until you <a href={nameHref} class={linkClass}>give them the business's name</a>.</> : null}
      </p>

      <ol class="relative ml-3 space-y-5 border-l border-line pl-6">
        {flow.steps(s.timing).map((st) => (
          <li class="relative">
            <span aria-hidden="true" class={"absolute -left-[31px] top-1 size-3 rounded-full ring-4 ring-canvas " + (st.kind === "text" ? "bg-accent" : st.kind === "end" ? "bg-ink" : "bg-line-strong")}></span>
            <p class="text-label text-ink-3">{STEP_LABEL[st.kind]}</p>
            {st.kind === "text" ? (
              <div class="mt-1 space-y-3">
                {st.variants.map((v) => {
                  const mail = channel === "email" ? emailOf(v.email ?? v.key) : undefined;
                  return (
                    <div class="max-w-lg rounded-card border border-line bg-surface p-3">
                      {v.label ? <p class="mb-2 font-medium">{v.label}</p> : null}
                      <p class="rounded-2xl rounded-bl-sm bg-panel px-3 py-2">{words(v.key)}</p>
                      <WordsEditor action={`${action}/words`} variant={v.key} words={s.words[v.key] ?? WORDS[flow.key][v.key] ?? ""}
                        ours={WORDS[flow.key][v.key] ?? ""} fills={flow.fills} refused={refused?.variant === v.key ? refused : undefined} />
                      {mail ? (
                        <details class="mt-2">
                          <summary class={smallText + " cursor-pointer text-ink-2"}>Until your number can text, this goes by email</summary>
                          <div class="mt-2 border-t border-line pt-2">
                            <p class="text-label text-ink-3">Subject: {fill(mail.subject, example)}</p>
                            <p class="mt-1 whitespace-pre-line">{fillEmail(mail.text, { ...example, times_list: [example.slot1, example.slot2, example.slot3].filter(Boolean).join("\n") })}</p>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
                {st.replies?.length ? (
                  <ul class="space-y-1">
                    {st.replies.map((r) => <li class="text-ink-2"><span class="font-medium text-ink">{r.when}</span>: {r.then}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p class="mt-0.5">{st.says}</p>
            )}
          </li>
        ))}
      </ol>

      <div class="space-y-2">
        <p class="text-ink-2">Stops early when: {flow.stops.join(" · ")}.</p>
        {count?.sent ? <p>{outcomeText(flow, count)}</p> : null}
        <AskAi ask={`Change the "${flow.name}" text to say `} />
      </div>
    </div>
  );
}

/** Change one text's words in place: the flow's fill-ins explained, checked on save (one text is 160 plain characters; no emoji). */
function WordsEditor({ action, variant, words, ours, fills, refused }: { action: string; variant: string; words: string; ours: string; fills: FillKey[]; refused?: { words: string; why: string } }) {
  const id = `words-${variant}`;
  return (
    <details class="mt-2" open={!!refused}>
      <summary class={linkClass + " cursor-pointer text-label"}>Edit</summary>
      <form method="post" action={action} class="mt-2 space-y-2">
        <input type="hidden" name="variant" value={variant} />
        {refused ? <p role="alert" class={alertClass}>{refused.why}</p> : null}
        <label for={id} class="sr-only">Words for this text</label>
        <textarea id={id} name="words" rows={4} maxlength={600} required class={inputClass}>{refused?.words ?? words}</textarea>
        <div class={smallText + " text-ink-2"}>
          <p>Words in braces are filled in for each person:</p>
          <ul class="mt-1 space-y-0.5">{fills.map((k) => <li><code class="text-ink">{`{${k}}`}</code> {FILL_SAYS[k]}</li>)}</ul>
          <p class="mt-1">A sentence whose fill-in is missing is left out. One text holds 160 plain letters; emoji can't be used, as they cut that to 70.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class={buttonClass}>Save</button>
          {words !== ours ? <button name="reset" value="1" formnovalidate class={quietClass}>Use ours</button> : null}
        </div>
      </form>
    </details>
  );
}

// ---- Messages ----------------------------------------------------------------------

const KEY = /^\d{7,10}$/;

export function messagesRoutes(getDb: GetDb, opts: PhoneAdminOptions) {
  const base = opts.messages.replace(/\/+$/, "");
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const framed = sectionPages({ Frame: opts.Frame, css: opts.css, label: "Messages", links: opts.nav ?? [], messages: MESSAGES });

  /** The sidebar's count, filled in after the page loads. */
  app.get("/count", async (c) => {
    return c.html(<UnreadBadge n={await unreadThreads(getDb(c), c.get("user")).catch(() => 0)} />);
  });

  app.get("/", async (c) => {
    const db = getDb(c);
    const view = c.req.query("view") === "all" ? "all" : c.req.query("view") === "mine" ? "mine" : "unread";
    const q = (c.req.query("q") ?? "").slice(0, 100);
    const list = await threads(db, { unread: view === "unread" && !q, q, mine: view === "mine" ? c.get("user") : null });
    await seeMessages(db, c.get("user"));
    const main = await mainNumber(db);
    const ctx = await opts.ctx(c);
    return framed(c, base, { title: "Messages", sub: main ? <>Texts and calls to <span class="tabular-nums">{prettyPhone(main.e164)}</span></> : undefined }, (
      <div class="space-y-4">
        {!main ? <SetupNeeded title="No business number yet" ask="Set up a business number for calls and texts.">Choose one in Settings, Phone and texts. Texts and calls to it show here.</SetupNeeded> : null}
        {main && main.texting !== "approved" ? <p class="rounded-card border border-line bg-panel px-4 py-2">Texting starts when Twilio approves your number (<a href={opts.settings + "#texting"} class={linkClass}>step 4 in Settings</a>). Calls show here now.</p> : null}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Messages views" class="flex gap-1">
            {(["unread", "mine", "all"] as const).map((v) => (
              <a href={`${base}?view=${v}`} aria-current={v === view ? "page" : undefined} class={(v === view ? "bg-panel text-ink " : "text-ink-2 ") + "rounded-control px-3 py-1.5 text-sm font-semibold no-underline hover:bg-panel"}>
                {v === "unread" ? "Unread" : v === "mine" ? "Mine" : "All"}
              </a>
            ))}
          </nav>
          <form method="get" action={base} role="search" class="flex gap-2">
            <input type="hidden" name="view" value="all" />
            <input name="q" value={q} placeholder="Name or number" aria-label="Search messages" class={inputClass + " w-56"} />
            <button class={buttonClass}>Search</button>
          </form>
        </div>
        {list.length ? (
          <ul class="divide-y divide-line rounded-card border border-line bg-surface shadow-card">
            {list.map((t) => <ThreadRow t={t} href={`${base}/${t.remote_key}`} timeZone={opts.timeZone} />)}
          </ul>
        ) : (
          <EmptyState title={view === "unread" && !q ? "Nothing unread." : "No messages yet."}>{view === "unread" && !q ? <a href={`${base}?view=all`} class={linkClass}>See all</a> : null}</EmptyState>
        )}
        {ctx.provider ? null : <p class="text-ink-2">Twilio isn't connected, so replies and calls wait until it is.</p>}
      </div>
    ));
  });

  app.get("/audio/:id/:which", async (c) => {
    const db = getDb(c);
    const [row] = await db.sql<{ voicemail_sid: string | null; recording_sid: string | null }>`
      select voicemail_sid, recording_sid from communications where id = ${c.req.param("id")}::bigint`.catch(() => []);
    const sid = c.req.param("which") === "recording" ? row?.recording_sid : row?.voicemail_sid;
    const ctx = await opts.ctx(c);
    if (!sid || !ctx.provider) return c.notFound();
    const res = await ctx.provider.recording(sid);
    if (!res.ok || !res.body) return c.notFound();
    return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" } });
  });

  async function threadPage(c: Team, key: string, status = 200, problem?: string) {
    const db = getDb(c);
    const rows = await thread(db, key);
    const { contact, choices } = await ownerOf(db, key);
    if (!rows.length && !choices.length) return c.notFound();
    await markRead(db, key);
    await seeMessages(db, c.get("user"));
    const remote = rows.at(-1)?.remote_e164 ?? null;
    const ctx = await opts.ctx(c);
    const main = await mainNumber(db);
    const title = contact?.name ?? (remote ? prettyPhone(remote) : "Unknown");
    return framed(c, `${base}/${key}`, {
      title, back: { href: base, label: "Messages" },
      sub: <>{remote ? <span class="tabular-nums">{prettyPhone(remote)}</span> : null}{contact && opts.contactHref ? <> · <a href={opts.contactHref(contact.id)} class={linkClass}>Open contact</a></> : null}</>,
      actions: <form method="post" action={`${base}/${key}/unread`}><button class={quietClass}>Mark unread</button></form>,
    }, (
      <div class="space-y-4">
        {problem ? <p role="alert" class={alertClass}>{problem}</p> : null}
        {!contact ? <WhoseNumber base={base} k={key} choices={choices} /> : null}
        <ThreadPoll url={`${base}/${key}/rows`} rows={rows} timeZone={opts.timeZone} audioBase={`${base}/audio`} />
        <ReplyBox action={`${base}/${key}/reply`} callAction={`${base}/${key}/call`} to={remote ?? ""} canText={!!ctx.provider && main?.texting === "approved"} canCall={!!ctx.provider && !!main?.ring_to} />
      </div>
    ), status);
  }

  app.get("/:key", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    return threadPage(c, key);
  });

  app.get("/:key/rows", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    const db = getDb(c);
    const rows = await thread(db, key);
    // Someone has Messages open: the owner's cell needn't hear of a new text (tellOwner).
    await seeMessages(db, c.get("user"));
    // Nothing new: htmx swaps nothing on a 204, so a voicemail playing keeps playing.
    if (c.req.query("v") === threadVersion(rows)) return c.body(null, 204);
    await markRead(db, key);
    return c.html(<ThreadPoll url={`${base}/${key}/rows`} rows={rows} timeZone={opts.timeZone} audioBase={`${base}/audio`} />);
  });

  app.post("/:key/reply", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    const f = await c.req.parseBody();
    const body = String(f.body ?? "").trim().slice(0, 1000);
    const to = toE164(String(f.to ?? ""));
    if (!body || !to || phoneKey(to) !== key) return threadPage(c, key, 422, body ? "That isn't this thread's number." : "Write the text first.");
    const ctx = await opts.ctx(c);
    const { contact } = await ownerOf(getDb(c), key);
    const r = await sendText(ctx, { to, body, sentBy: c.get("user"), contactId: contact?.id ?? null });
    if (!r.ok) return threadPage(c, key, 422, r.why);
    // A person stepped in: anything automatic still waiting for this number is dropped.
    await getDb(c).sql`update text_sends set status = 'skipped', why = 'someone on the team replied' where remote_key = ${key} and status = 'due'`;
    return c.redirect(withFlash(`${base}/${key}`, "sent"), 303);
  });

  app.post("/:key/call", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    const db = getDb(c);
    const ctx = await opts.ctx(c);
    const main = await mainNumber(db);
    const [last] = await db.sql<{ remote_e164: string }>`select remote_e164 from communications where remote_key = ${key} order by created_at desc limit 1`;
    const to = last?.remote_e164 ?? toE164(String((await c.req.parseBody()).to ?? ""));
    if (!ctx.provider || !main || !to) return threadPage(c, key, 422, "Calls need Twilio and a business number.");
    const r = await callOut(db, ctx.provider, main, to, c.get("user")).catch((e) => ({ ok: false as const, why: `Twilio: ${e.message}` }));
    return r.ok ? c.redirect(withFlash(`${base}/${key}`, "calling"), 303) : threadPage(c, key, 422, r.why);
  });

  app.post("/:key/unread", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    await markUnread(getDb(c), key);
    return c.redirect(withFlash(base, "unread"), 303);
  });

  app.post("/:key/contact", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    const id = String((await c.req.parseBody()).contact_id ?? "");
    const db = getDb(c);
    if (!/^\d{1,18}$/.test(id)) return c.notFound();
    const [ok] = await db.sql`select 1 from customers where id = ${id}::bigint`;
    if (!ok) return c.notFound();
    await setThreadContact(db, key, id);
    return c.redirect(withFlash(`${base}/${key}`, "contact"), 303);
  });

  app.post("/:key/lead", async (c) => {
    const key = c.req.param("key");
    if (!KEY.test(key)) return c.notFound();
    const db = getDb(c);
    const [last] = await db.sql<{ remote_e164: string; kind: string }>`select remote_e164, kind from communications where remote_key = ${key} order by created_at desc limit 1`;
    if (!last) return c.notFound();
    const name = String((await c.req.parseBody()).name ?? "").trim().slice(0, 200) || null;
    const person = await savePerson(db, { name, email: null, phone: last.remote_e164, source: last.kind === "text" ? "Text" : "Phone call", at: new Date() }, c.get("user"));
    if (!person) return threadPage(c, key, 422, "Couldn't make a contact for this number.");
    await setThreadContact(db, key, person.id);
    const title = `${last.kind === "text" ? "Text" : "Call"} from ${prettyPhone(last.remote_e164)}`;
    const leadId = await saveLead(db, { customerId: person.id, source: "phone", title, owner: c.get("user") }, c.get("user"));
    if (leadId) await opts.onLead?.(c, { customerId: person.id, leadId, title });
    return c.redirect(withFlash(`${base}/${key}`, "lead"), 303);
  });

  return app;
}

function ThreadRow({ t, href, timeZone }: { t: Thread; href: string; timeZone: string }) {
  const what = t.last_kind === "call"
    ? t.last_direction === "in" ? (t.last_voicemail ? "Voicemail" : t.last_status === "completed" || t.last_status === "in-progress" ? "Call" : "Missed call") : "Call"
    : (t.last_direction === "out" ? "You: " : "") + (t.last_body ?? "");
  return (
    <li class="relative flex items-center gap-3 px-4 py-3 hover:bg-panel">
      <span aria-hidden="true" class={"size-2 shrink-0 rounded-full " + (t.unread ? "bg-accent" : "bg-transparent")}></span>
      <div class="min-w-0 flex-1">
        <a href={href} class={"no-underline text-ink after:absolute after:inset-0 " + (t.unread ? "font-semibold" : "font-medium")}>
          {t.contact_name ?? <span class="tabular-nums">{prettyPhone(t.remote_e164)}</span>}
          {t.unread ? <span class="sr-only"> (unread)</span> : null}
        </a>
        <p class="truncate text-ink-2">{what}</p>
      </div>
      <span class="shrink-0 text-label text-ink-3"><When at={t.last_at} timeZone={timeZone} /></span>
    </li>
  );
}

/** Who sent ours: a person, or a flow. */
const byLine = (c: Communication) =>
  c.sent_by?.startsWith("flow:") ? (c.sent_by === "flow:owner" ? "Automatic: to your phone" : `Automatic: ${flowName(c.sent_by.slice(5))}`)
  : c.sent_by === "ai" ? "The AI" : c.sent_by ?? "";
const flowName = (k: string) => (isFlowKey(k) ? flowOf(k).name : k);

/** 95 seconds as "1:35". */
const minSec = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

const callLine = (c: Communication) => {
  const secs = c.duration_s ?? 0;
  const len = secs ? ` ${minSec(secs)}` : "";
  if (c.direction === "out") return `Call out${len}${c.answered_by ? `, ${c.answered_by}` : ""}`;
  if (c.answered_by) return `Call${len}, answered`;
  return c.status === "ringing" ? "Ringing now" : "Missed call";
};

/** Threads with something unread, for a sidebar link to Messages. */
export function UnreadBadge({ n }: { n: number }) {
  return n ? <span class="ml-auto rounded-full bg-accent px-2 text-label tabular-nums text-accent-ink">{n > 99 ? "99+" : n}</span> : <span></span>;
}

/** What the thread shows, in one short string: the poll sends it back, and an unchanged thread is not redrawn. */
function threadVersion(rows: Communication[]): string {
  let h = 2166136261;
  for (const m of rows) {
    for (const ch of `${m.id}|${m.status}|${m.voicemail_sid ?? ""}|${m.transcript?.length ?? 0}|${m.recording_sid ?? ""};`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  return `${rows.length}-${(h >>> 0).toString(36)}`;
}

/** The thread, asking every ten seconds for what changed (an unchanged answer is a 204). */
function ThreadPoll({ url, rows, timeZone, audioBase }: { url: string; rows: Communication[]; timeZone: string; audioBase: string }) {
  return (
    <div id="thread" hx-get={`${url}?v=${threadVersion(rows)}`} hx-trigger="every 10s" hx-swap="outerHTML">
      <ThreadRows rows={rows} timeZone={timeZone} audioBase={audioBase} />
    </div>
  );
}

export function ThreadRows({ rows, timeZone, audioBase }: { rows: Communication[]; timeZone: string; audioBase: string }) {
  if (!rows.length) return <p class="text-ink-2">Nothing yet.</p>;
  return (
    <ol class="space-y-3" aria-label="Texts and calls">
      {rows.map((m) =>
        m.kind === "call" ? (
          <li class="flex flex-col items-center gap-1 text-center">
            <p class="text-label text-ink-2">{callLine(m)} · <When at={m.created_at} timeZone={timeZone} /></p>
            {m.voicemail_sid ? (
              <div class="w-full max-w-md rounded-card border border-line bg-surface p-3 text-left">
                <p class="text-label font-semibold">Voicemail{m.voicemail_s ? `, ${minSec(m.voicemail_s)}` : ""}</p>
                <audio controls preload="none" src={`${audioBase}/${m.id}/voicemail`} class="mt-2 w-full" aria-label="Voicemail"></audio>
                {m.transcript ? <p class="mt-2">{m.transcript}</p> : <p class="mt-2 text-ink-3">The transcript comes a minute or two after the call.</p>}
              </div>
            ) : null}
            {m.recording_sid ? <audio controls preload="none" src={`${audioBase}/${m.id}/recording`} class="w-full max-w-md" aria-label="Call recording"></audio> : null}
          </li>
        ) : (
          <li class={"flex flex-col " + (m.direction === "out" ? "items-end" : "items-start")}>
            <p class={"max-w-md whitespace-pre-line rounded-2xl px-3 py-2 " + (m.direction === "out" ? "rounded-br-sm bg-accent text-accent-ink" : "rounded-bl-sm bg-panel text-ink")}>{m.body}</p>
            {m.media.length ? <p class="mt-1 text-label">{m.media.map((x, i) => <a href={x.url} class={linkClass + " mr-2"} rel="noreferrer">Picture {i + 1}</a>)}</p> : null}
            <p class="mt-1 text-label text-ink-3">
              {m.direction === "out" ? `${byLine(m)} · ` : ""}<When at={m.created_at} timeZone={timeZone} />
              {m.keyword ? <strong class="text-ink"> · {m.keyword === "stop" ? "Opted out of texts" : m.keyword === "start" ? "Opted back in to texts" : "Asked for help (Twilio answered)"}</strong> : null}
              {m.direction === "out" && (m.status === "failed" || m.status === "undelivered") ? <strong class="text-ink"> · Not delivered{m.error ? `: ${deliveryWhy(m.error)}` : ""}</strong> : null}
            </p>
          </li>
        ),
      )}
    </ol>
  );
}

/** Twilio's delivery errors people meet, in words. */
function deliveryWhy(err: string): string {
  const code = err.split(":")[0];
  return ({
    "30003": "the phone is off or out of reach", "30005": "this number doesn't exist", "30006": "this number can't get texts (a landline?)",
    "30007": "the carrier filtered it", "30034": "the number isn't registered for texting yet", "21610": "this number has opted out",
  } as Record<string, string>)[code] ?? err;
}

function WhoseNumber({ base, k, choices }: { base: string; k: string; choices: { id: string; name: string }[] }) {
  return (
    <div class="rounded-card border border-line bg-panel p-4">
      {choices.length > 1 ? (
        <form method="post" action={`${base}/${k}/contact`} class="flex flex-wrap items-end gap-2">
          <p class="basis-full font-semibold">More than one contact has this number. Whose is it?</p>
          {choices.map((ch) => <button name="contact_id" value={ch.id} class={buttonClass}>{ch.name}</button>)}
        </form>
      ) : (
        <form method="post" action={`${base}/${k}/lead`} class="flex flex-wrap items-end gap-2">
          <p class="basis-full font-semibold">Nobody in your contacts has this number.</p>
          <label class={fieldClass}>Their name<input name="name" class={inputClass + " w-56"} autocomplete="off" /></label>
          <button class={primaryClass}>Create lead</button>
        </form>
      )}
    </div>
  );
}

function ReplyBox({ action, callAction, to, canText, canCall }: { action: string; callAction: string; to: string; canText: boolean; canCall: boolean }) {
  return (
    <div class="sticky bottom-0 space-y-2 border-t border-line bg-canvas pt-3">
      {canText ? (
        <form method="post" action={action} class="flex items-end gap-2">
          <input type="hidden" name="to" value={to} />
          <label class="flex-1"><span class="sr-only">Text</span>
            <textarea name="body" rows={2} maxlength={1000} required class={inputClass} placeholder="Write a text"></textarea>
          </label>
          <button class={primaryClass}>Send</button>
        </form>
      ) : <p class="text-ink-2">Replies go once your number can text.</p>}
      {canCall ? (
        <form method="post" action={callAction}>
          <input type="hidden" name="to" value={to} />
          <button class={buttonClass}>Call from the business number</button>
          <span class={smallText + " ml-2 text-ink-2"}>Your phone rings first.</span>
        </form>
      ) : null}
    </div>
  );
}

/**
 * A contact's texts and calls, for their page in the app: the latest few,
 * the thread link, and Don't text (`off`, posted to `offAction` with
 * texts_off 1 or 0), as if they had said STOP.
 */
export function ContactTexts({ rows, phone, messagesBase, timeZone, canText, off, offAction }: {
  rows: Communication[]; phone: string | null; messagesBase: string; timeZone: string; canText: boolean; off?: boolean; offAction?: string;
}) {
  const key = phone ? phoneKey(phone) : rows[0]?.remote_key ?? null;
  const latest = rows.slice(0, 5).reverse();
  return (
    <Section title="Texts and calls" count={rows.length}>
      {latest.length ? <ThreadRows rows={latest} timeZone={timeZone} audioBase={`${messagesBase}/audio`} /> : <p class="text-ink-2">No texts or calls yet.</p>}
      {off ? <p class="mt-3 font-semibold">Marked Don't text: nothing automatic goes to them, and nobody can text them from here.</p> : null}
      {key || offAction ? (
        <div class="mt-3 flex flex-wrap gap-2">
          {key ? <a href={`${messagesBase}/${key}`} class={buttonClass}>{canText && !off ? "Text" : "Open the thread"}</a> : null}
          {offAction ? (
            <form method="post" action={offAction}>
              <input type="hidden" name="texts_off" value={off ? "0" : "1"} />
              <button class={quietClass}>{off ? "Let us text them again" : "Don't text"}</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

