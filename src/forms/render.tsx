// A form drawn from its definition. Works with no JavaScript: a plain POST to
// /forms/<key>, errors shown next to the field they are about (wired with
// aria-describedby and aria-invalid), answers put back after an error, the
// two spam fields (data/spam.tsx) and where the visitor came from
// (origin.ts). Ids carry the form key, so two forms can sit on one page.
//
//   <FormView form={form} stamp={await makeStamp(form.key)} page={c.req.path} origin={originFields(c)} />
//
// Usually reached through embedForm (routes.tsx), which loads the row and
// makes the stamp.
import type { Child } from "hono/jsx";
import { BACK_FIELD, DRAFT_FIELD, isAnswer, phoneField, STEP_FIELD, TEXT_CONSENT_FIELD, type Field, type Form, type Errors, type Input } from "./fields";
import { SpamFields } from "../data/spam";
import { REFERRER_FIELD, UTM_FIELD } from "./origin";
import { formatMoney } from "../payments/money";

/** Words with their https links clickable: the texting box's terms and privacy links. */
export function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s]+[^\s.,;)])/);
  return <>{parts.map((p, i) => (i % 2 ? <a href={p} target="_blank" rel="noopener" class="underline">{p.replace(/^https:\/\//, "")}</a> : p))}</>;
}

const control =
  "w-full min-h-12 rounded-control border border-line-strong bg-surface px-3.5 py-2.5 text-copy text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25 aria-[invalid=true]:border-ink aria-[invalid=true]:border-2";
const labelCls = "text-label font-semibold text-ink";
const helpCls = "text-label text-ink-2";
const errorCls = "text-label font-semibold text-ink";

/** Where a form with steps is: its index, how many, the step's label, and (after the first) the visitor's key. */
export type StepPlace = { index: number; count: number; label: string | null; key?: string; back?: boolean };

export function FormView(props: {
  form: Form;
  /** The spam stamp; only the first step carries one. */
  stamp?: string;
  page?: string;
  /** The hidden fields that say where the visitor came from (originFields, or the posted ones put back). */
  origin?: { utm: string; ref: string };
  values?: Input;
  errors?: Errors;
  action?: string;
  /** The fields of one step; default all of the form's questions. */
  fields?: Field[];
  /** A form with steps: which one this is. */
  step?: StepPlace;
  /** Where the form routes are mounted ("" or "/q"). */
  prefix?: string;
  /** The texting box's words, under the phone field, when this form follows up and the app can text. */
  textConsent?: string | null;
}) {
  const { form, stamp, page, origin, values = {}, errors = {}, step, textConsent } = props;
  const phone = textConsent ? phoneField(props.fields ?? form.fields) : undefined;
  const fields = (props.fields ?? form.fields).filter(isAnswer);
  const failed = fields.filter((f) => errors[f.name]);
  const last = !step || step.index === step.count - 1;
  // One card question on a step needs no button: a click answers it, even the answer already chosen when they
  // came back with Back. Without JavaScript the button shows.
  const oneClick = !!step && fields.length === 1 && fields[0].type === "radio" && !!fields[0].cards;
  const button = (
    <button type="submit" class="inline-flex min-h-12 w-full items-center justify-center rounded-control bg-accent px-6 font-semibold text-accent-ink transition-colors hover:bg-accent-hover sm:w-auto">
      {last ? form.submit_label || "Send" : "Continue"}
    </button>
  );
  return (
    <form method="post" action={props.action ?? `${props.prefix ?? ""}/forms/${form.key}`} class="grid max-w-xl gap-6" onclick={oneClick ? "if(event.target.type==='radio')this.requestSubmit()" : undefined}>
      {step && step.count > 1 ? <StepHeading step={oneClick ? { ...step, label: null } : step} /> : null}
      {failed.length ? (
        <div role="alert" class="rounded-card border border-line-strong bg-panel p-4">
          <p class="font-semibold">Please fix the answers marked below, then send again.</p>
          <ul class="mt-2 list-disc pl-5">
            {failed.map((f) => (
              <li>
                <a href={`#${id(form, f)}`}>{f.label}</a>: {errors[f.name]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fields.map((f) => (
        <>
          <FieldView form={form} field={f} value={values[f.name]} error={errors[f.name]} values={values} />
          {phone && f.name === phone.name ? (
            <label class="-mt-2 flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" name={TEXT_CONSENT_FIELD} value="yes" class="mt-0.5 size-5 shrink-0" checked={values[TEXT_CONSENT_FIELD] === "yes"} />
              <span class="text-label font-normal text-ink-2"><LinkedText text={textConsent ?? ""} /></span>
            </label>
          ) : null}
        </>
      ))}
      {step?.key ? (
        <>
          <input type="hidden" name={DRAFT_FIELD} value={step.key} />
          <input type="hidden" name={STEP_FIELD} value={String(step.index)} />
        </>
      ) : stamp !== undefined ? <SpamFields stamp={stamp} /> : null}
      {page ? <input type="hidden" name="_page" value={page} /> : null}
      {origin?.utm ? <input type="hidden" name={UTM_FIELD} value={origin.utm} /> : null}
      {origin?.ref ? <input type="hidden" name={REFERRER_FIELD} value={origin.ref} /> : null}
      <div class="flex flex-wrap items-center gap-4">
        {oneClick ? <noscript>{button}</noscript> : button}
        {step?.key && step.back ? (
          <button type="submit" name={BACK_FIELD} value="1" formnovalidate class="min-h-11 text-label font-semibold text-ink-2 underline underline-offset-2 hover:text-ink">Back</button>
        ) : null}
      </div>
    </form>
  );
}

function StepHeading({ step }: { step: StepPlace }) {
  const done = Math.round(((step.index + 1) / step.count) * 100);
  return (
    <div class="grid gap-3">
      <div>
        <p class="text-label text-ink-2">Step {step.index + 1} of {step.count}</p>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-panel" role="progressbar" aria-label="Progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={100}>
          <div class="h-full rounded-full bg-accent transition-all" style={`width:${done}%`}></div>
        </div>
      </div>
      {step.label ? <h2 class="text-title font-semibold">{step.label}</h2> : null}
    </div>
  );
}

/** A booking or payment step's body under the same heading the questions have. */
export function StepFrame({ step, children }: { step: StepPlace; children?: Child }) {
  return (
    <div class="grid max-w-xl gap-6">
      <StepHeading step={step} />
      {children}
    </div>
  );
}

function FieldView({ form, field: f, value, error, values }: { form: Form; field: Field; value?: string | string[]; error?: string; values?: Input }) {
  const fid = id(form, f);
  const describedBy = [f.help ? `${fid}-help` : "", error ? `${fid}-error` : ""].filter(Boolean).join(" ") || undefined;
  const invalid = error ? "true" : undefined;
  const one = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  const many = Array.isArray(value) ? value : value ? [value] : [];
  const help = f.help ? (
    <p id={`${fid}-help`} class={helpCls}>
      {f.help}
    </p>
  ) : null;
  const err = error ? (
    <p id={`${fid}-error`} class={errorCls}>
      {error}
    </p>
  ) : null;
  const optional = f.required ? null : <span class="font-normal text-ink-3"> (optional)</span>;

  if (f.type === "items") {
    return (
      <fieldset id={fid} class="grid gap-3" aria-describedby={describedBy} tabindex={-1} data-items-form={form.key}>
        <legend class={labelCls}>
          {f.label}
          {optional}
        </legend>
        {help}
        {err}
        {(f.items ?? []).map((it) => {
          const name = `${f.name}[${it.key}]`;
          const qid = `${fid}-${it.key}`;
          const shown = values?.[name];
          return (
            <div class="flex items-center gap-3" data-item={it.key} data-max={String(it.max ?? 99)}>
              {it.image ? <img src={it.image} alt="" width="64" height="64" class="h-16 w-16 rounded-control object-cover" /> : null}
              <label for={qid} class="min-w-0 flex-1">
                <span class="block font-semibold">{it.label}</span>
                <span class="block text-label text-ink-2">{formatMoney(it.price_cents, f.currency ?? "usd")}{it.unit ? ` ${it.unit === "each" ? "each" : `a ${it.unit}`}` : ""}</span>
              </label>
              <input
                id={qid}
                name={name}
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                size={3}
                value={Array.isArray(shown) ? shown[0] ?? "" : shown ?? ""}
                placeholder="0"
                aria-label={`How many: ${it.label}`}
                aria-invalid={invalid}
                class={control.replace("w-full", "w-20 shrink-0") + " text-center"}
              />
            </div>
          );
        })}
      </fieldset>
    );
  }

  if (f.type === "photo") {
    return (
      <div class="grid gap-2">
        <label for={fid} class={labelCls}>
          {f.label}
          {optional}
        </label>
        {help}
        <input id={fid} type="file" accept="image/*" aria-invalid={invalid} aria-describedby={describedBy} class={control} />
        <input type="hidden" name={f.name} value={one} />
        <p class={helpCls} aria-live="polite" data-photo-note>{one ? "Photo attached." : ""}</p>
        {err}
        <script dangerouslySetInnerHTML={{ __html: PHOTO_JS.replace("$ID", JSON.stringify(fid)) }} />
      </div>
    );
  }

  if (f.type === "radio" && f.cards) {
    const pictures = (f.options ?? []).some((o) => f.option_images?.[o]);
    return (
      <fieldset id={fid} class="grid gap-3" aria-describedby={describedBy} tabindex={-1}>
        <legend class="mb-4 font-display text-title font-semibold text-ink">{f.label}</legend>
        {help}
        {err}
        <div data-answers class={"grid gap-3 " + (pictures ? "grid-cols-2" : "")}>
          {(f.options ?? []).map((o, i) => (
            <label class="group relative flex cursor-pointer flex-col overflow-hidden rounded-card border border-line-strong bg-surface transition-all hover:border-accent hover:shadow-card has-[:checked]:border-2 has-[:checked]:border-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40">
              <input type="radio" name={f.name} value={o} id={`${fid}-${i}`} checked={many.includes(o)} required={f.required ? true : undefined} aria-invalid={invalid} class="sr-only" />
              {f.option_images?.[o]?.endsWith(".svg") ? (
                <span class="flex flex-col items-center gap-3 px-3 py-6 text-center font-semibold text-ink">
                  <img src={f.option_images[o]} alt="" class="h-12 w-auto" />
                  {o}
                </span>
              ) : (
                <>
                  {f.option_images?.[o] ? <img src={f.option_images[o]} alt="" loading="lazy" class="aspect-[16/10] w-full object-cover" /> : null}
                  <span class="flex min-h-12 items-center justify-between gap-2 px-4 py-3 font-semibold text-ink">
                    {o}
                    <span aria-hidden="true" class="text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent">→</span>
                  </span>
                </>
              )}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (f.type === "radio" || (f.type === "checkbox" && f.options?.length)) {
    const type = f.type === "radio" ? "radio" : "checkbox";
    return (
      <fieldset id={fid} class="grid gap-2" aria-describedby={describedBy} tabindex={-1}>
        <legend class={labelCls}>
          {f.label}
          {optional}
        </legend>
        {help}
        {err}
        {(f.options ?? []).map((o, i) => (
          <label class="flex min-h-12 cursor-pointer items-center gap-3 rounded-control border border-line px-3.5 py-2 transition-colors hover:border-line-strong has-[:checked]:border-accent has-[:checked]:bg-accent/5">
            <input
              type={type}
              name={f.name}
              value={o}
              id={`${fid}-${i}`}
              checked={many.includes(o)}
              required={type === "radio" && f.required ? true : undefined}
              aria-invalid={invalid}
            />
            {o}
          </label>
        ))}
      </fieldset>
    );
  }

  if (f.type === "checkbox" || f.type === "consent") {
    return (
      <div class="grid gap-2">
        <label class="flex items-start gap-2">
          <input
            type="checkbox"
            id={fid}
            name={f.name}
            value="yes"
            class="mt-1"
            checked={one !== ""}
            required={f.required ? true : undefined}
            aria-invalid={invalid}
            aria-describedby={describedBy}
          />
          <span>{f.label}</span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  const common = {
    id: fid,
    name: f.name,
    required: f.required ? true : undefined,
    maxlength: f.type === "select" || f.type === "date" ? undefined : f.maxLength,
    "aria-invalid": invalid,
    "aria-describedby": describedBy,
    class: control,
  };

  return (
    <div class="grid gap-2">
      <label for={fid} class={labelCls}>
        {f.label}
        {optional}
      </label>
      {help}
      {f.type === "textarea" ? (
        <textarea {...common} rows={5} autocomplete={autocomplete(f)}>
          {one}
        </textarea>
      ) : f.type === "select" ? (
        <div class="relative">
          <select {...common} class={control + " cursor-pointer appearance-none pr-11 invalid:text-ink-3"} autocomplete={autocomplete(f)}>
            <option value="">Choose one</option>
            {(f.options ?? []).map((o) => (
              <option value={o} selected={o === one}>
                {o}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="pointer-events-none absolute right-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-2"><path d="m5 8 5 5 5-5" /></svg>
        </div>
      ) : (
        <input
          {...common}
          type={f.type === "number" ? "text" : f.type}
          inputmode={INPUTMODE[f.type]}
          autocomplete={autocomplete(f)}
          spellcheck={f.type === "email" ? false : undefined}
          value={one}
        />
      )}
      {err}
    </div>
  );
}

// type="number" drops what it cannot parse ("1,200") before the server sees
// it, so a number is a text input with a numeric keyboard.
const INPUTMODE: Partial<Record<Field["type"], "email" | "tel" | "decimal">> = { email: "email", tel: "tel", number: "decimal" };

const BY_NAME: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "tel",
  company: "organization",
  organization: "organization",
  address: "street-address",
  city: "address-level2",
  postcode: "postal-code",
  postal_code: "postal-code",
  zip: "postal-code",
  country: "country-name",
  first_name: "given-name",
  last_name: "family-name",
  website: "url",
};

function autocomplete(f: Field): string | undefined {
  if (f.autocomplete) return f.autocomplete;
  if (BY_NAME[f.name]) return BY_NAME[f.name];
  if (f.type === "email") return "email";
  return f.type === "tel" ? "tel" : undefined;
}

// A photo is drawn at most 2048 pixels on its long side (which leaves its
// location data behind), sent to /_files, and its path goes in the hidden
// input. One this browser cannot draw is sent as it is. Send waits for it, so
// a quick tap never sends the form without the photo.
const PHOTO_JS = `(() => {
  const input = document.getElementById($ID), box = input.parentElement;
  const answer = box.querySelector("input[type=hidden]"), note = box.querySelector("[data-photo-note]");
  const send = input.form.querySelector("[type=submit]");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    answer.value = "";
    send.disabled = true;
    note.textContent = "Adding the photo.";
    let body = file, type = file.type;
    try {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      body = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.85));
      type = "image/jpeg";
    } catch (e) {}
    try {
      const res = await fetch("/_files", { method: "POST", body, headers: { "content-type": type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
      if (!res.ok) throw new Error(String(res.status));
      answer.value = (await res.json()).path;
      note.textContent = "Photo attached.";
    } catch (e) {
      note.textContent = "That photo could not be added. Try another.";
    }
    send.disabled = false;
  });
})();`;

const id = (form: Form, f: Field) => `f-${form.key}-${f.name}`;
