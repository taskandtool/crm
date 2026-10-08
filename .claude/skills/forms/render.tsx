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
import { DRAFT_FIELD, isAnswer, STEP_FIELD, type Field, type Form, type Errors, type Input } from "./fields";
import { SpamFields } from "../data/spam";
import { REFERRER_FIELD, UTM_FIELD } from "./origin";
import { formatMoney } from "../payments/money";

const control =
  "w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-copy text-ink aria-[invalid=true]:border-ink aria-[invalid=true]:border-2";
const labelCls = "text-label font-semibold text-ink";
const helpCls = "text-label text-ink-2";
const errorCls = "text-label font-semibold text-ink";

/** Where a form with steps is: its index, how many, the step's label, and (after the first) the visitor's key. */
export type StepPlace = { index: number; count: number; label: string | null; key?: string };

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
}) {
  const { form, stamp, page, origin, values = {}, errors = {}, step } = props;
  const fields = (props.fields ?? form.fields).filter(isAnswer);
  const failed = fields.filter((f) => errors[f.name]);
  const last = !step || step.index === step.count - 1;
  return (
    <form method="post" action={props.action ?? `/forms/${form.key}`} class="grid max-w-xl gap-6">
      {step && step.count > 1 ? <StepHeading step={step} /> : null}
      {failed.length ? (
        <div role="alert" class="rounded-card border border-line-strong bg-panel p-4">
          <p class="font-semibold">Some answers need a fix before this can be sent.</p>
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
        <FieldView form={form} field={f} value={values[f.name]} error={errors[f.name]} values={values} />
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
      <div>
        <button
          type="submit"
          class="inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-5 font-semibold text-accent-ink"
        >
          {last ? form.submit_label || "Send" : "Next"}
        </button>
      </div>
    </form>
  );
}

function StepHeading({ step }: { step: StepPlace }) {
  return (
    <div class="grid gap-1">
      <p class="text-label text-ink-2">Step {step.index + 1} of {step.count}</p>
      {step.label ? <h2 class="text-title font-semibold">{step.label}</h2> : null}
    </div>
  );
}

/** A booking or payment step's body under the same heading the questions have. */
export function StepFrame({ step, children }: { form: Form; step: StepPlace; children?: Child }) {
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
                class={control + " w-20 text-center"}
              />
            </div>
          );
        })}
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
          <label class="flex items-center gap-2">
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
        <select {...common} autocomplete={autocomplete(f)}>
          <option value="">Choose one</option>
          {(f.options ?? []).map((o) => (
            <option value={o} selected={o === one}>
              {o}
            </option>
          ))}
        </select>
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

const id = (form: Form, f: Field) => `f-${form.key}-${f.name}`;
