// Editing the two ordered lists: the deal pipeline's stages and a customer's
// statuses. Rename, set the kind, reorder, archive (moving what is in it
// somewhere first), restore, add. Plain forms; each answers with a 303 back
// here and a flash.
import { Flash } from "../admin/flash";
import { dealsCfg, vocab } from "../config";
import { KIND_LABELS, type Pipeline, type StageWithCount } from "../crm/stages";
import { STAGE_KINDS } from "../config-schema";
import { Layout } from "./layout";
import { buttonClass, controlClass, Field, MESSAGES, primaryClass } from "./ui";

export function StagesPage(p: { user: string; deals: StageWithCount[]; statuses: StageWithCount[]; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title="Stages" user={p.user} section="stages">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <StageList
        pipeline="deals"
        heading={`${dealsCfg.one} stages`}
        intro={`The pipeline on the ${dealsCfg.many} page, in order. A new ${dealsCfg.one.toLowerCase()} lands in the first open stage. Won and lost stages close it; winning one makes its ${vocab.one.toLowerCase()} a customer.`}
        stages={p.deals}
        words={[dealsCfg.one.toLowerCase(), dealsCfg.many.toLowerCase()]}
      />
      <StageList
        pipeline="customers"
        heading={`${vocab.one} statuses`}
        intro={`Where each ${vocab.one.toLowerCase()} stands. New ones land in the first open status; open ones with nothing planned show on Follow-ups. A won ${dealsCfg.one.toLowerCase()} moves an open status to the first won one.`}
        stages={p.statuses}
        words={[vocab.one.toLowerCase(), vocab.many.toLowerCase()]}
      />
    </Layout>
  );
}

function StageList(p: { pipeline: Pipeline; heading: string; intro: string; stages: StageWithCount[]; words: [string, string] }) {
  const active = p.stages.filter((s) => !s.archived);
  const archived = p.stages.filter((s) => s.archived);
  const [one, many] = p.words;
  const base = `/stages/${p.pipeline}`;
  const thing = p.pipeline === "deals" ? "stage" : "status";
  const count = (n: number) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const id = `${p.pipeline}-list`;
  return (
    <section class="mb-8" aria-labelledby={id}>
      <h2 id={id} class="mb-1 text-copy font-semibold">{p.heading}</h2>
      <p class="mb-4 max-w-2xl text-ink-2">{p.intro}</p>
      <ol class="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
        {active.map((s, i) => (
          <li class="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0 lg:flex-row lg:items-end">
            <form method="post" action={`${base}/${s.key}`} class="flex flex-1 flex-wrap items-end gap-3">
              <Field label="Name" class="min-w-48 flex-1">
                <input name="label" value={s.label} required maxlength={60} class={controlClass} />
              </Field>
              <Field label="Counts as">
                <select name="kind" class={controlClass}>
                  {STAGE_KINDS.map((k) => (
                    <option value={k} selected={k === s.kind}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <button class={buttonClass}>Save</button>
              <span class="min-w-20 pb-1 text-label text-ink-3">{count(s.count)}</span>
            </form>
            <div class="flex flex-wrap items-end gap-2">
              <form method="post" action={`${base}/${s.key}/move`}>
                <input type="hidden" name="dir" value="up" />
                <button class={buttonClass} disabled={i === 0} aria-label={`Move ${s.label} earlier`}>
                  Earlier
                </button>
              </form>
              <form method="post" action={`${base}/${s.key}/move`}>
                <input type="hidden" name="dir" value="down" />
                <button class={buttonClass} disabled={i === active.length - 1} aria-label={`Move ${s.label} later`}>
                  Later
                </button>
              </form>
              <details class="relative">
                <summary class={buttonClass + " cursor-pointer list-none"}>Archive</summary>
                <form method="post" action={`${base}/${s.key}/archive`} class="mt-2 flex flex-col gap-2 rounded-card border border-line bg-surface p-3 shadow-lift">
                  {s.count > 0 ? (
                    <Field label={`Move its ${count(s.count)} to`}>
                      <select name="move_to" required class={controlClass}>
                        <option value="">Choose a {thing}</option>
                        {active
                          .filter((o) => o.key !== s.key)
                          .map((o) => (
                            <option value={o.key}>{o.label}</option>
                          ))}
                      </select>
                    </Field>
                  ) : (
                    <p class="text-label text-ink-3">Nothing is in this {thing}.</p>
                  )}
                  <button class={buttonClass + " self-start"}>Archive {s.label}</button>
                </form>
              </details>
            </div>
          </li>
        ))}
      </ol>

      <form method="post" action={base} aria-label={`Add a ${thing}`} class="mt-3 flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface p-4">
        <Field label={`New ${thing}`} class="min-w-48 flex-1">
          <input name="label" required maxlength={60} class={controlClass} />
        </Field>
        <Field label="Counts as">
          <select name="kind" class={controlClass}>
            {STAGE_KINDS.map((k) => (
              <option value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
        </Field>
        <button class={primaryClass}>Add</button>
      </form>

      {archived.length ? (
        <div class="mt-3">
          <h3 class="mb-2 text-label font-semibold text-ink-2">Archived</h3>
          <ul class="flex flex-col gap-2">
            {archived.map((s) => (
              <li class="flex flex-wrap items-center gap-3">
                <span>{s.label}</span>
                <span class="text-label text-ink-3">{KIND_LABELS[s.kind]}</span>
                <form method="post" action={`${base}/${s.key}/restore`}>
                  <button class={buttonClass}>Restore</button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
