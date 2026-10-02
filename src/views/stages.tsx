// Editing the pipeline's stages: rename, set the kind, reorder, archive
// (moving the customers in it somewhere first), restore, add. Plain forms;
// each answers with a 303 back here and a flash.
import { Flash } from "../admin/flash";
import { vocab } from "../config";
import { KIND_LABELS, type StageWithCount } from "../crm/stages";
import { STAGE_KINDS } from "../config-schema";
import { Layout } from "./layout";
import { buttonClass, controlClass, Field, MESSAGES, primaryClass } from "./ui";

export function StagesPage(p: { user: string; stages: StageWithCount[]; flash: { code?: string | null; n?: string | null } }) {
  const active = p.stages.filter((s) => !s.archived);
  const archived = p.stages.filter((s) => s.archived);
  const many = vocab.many.toLowerCase();
  return (
    <Layout title="Stages" user={p.user} section="stages">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <p class="mb-4 max-w-2xl text-ink-2">
        The pipeline, in order. New {many} land in the first stage that counts as open. Won and lost stages are where it ended, and the follow-up list skips them.
      </p>
      <ol class="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
        {active.map((s, i) => (
          <li class="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0 lg:flex-row lg:items-end">
            <form method="post" action={`/stages/${s.key}`} class="flex flex-1 flex-wrap items-end gap-3">
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
              <span class="min-w-20 pb-1 text-label text-ink-3">
                {s.customers === 1 ? `1 ${vocab.one.toLowerCase()}` : `${s.customers} ${many}`}
              </span>
            </form>
            <div class="flex flex-wrap items-end gap-2">
              <form method="post" action={`/stages/${s.key}/move`}>
                <input type="hidden" name="dir" value="up" />
                <button class={buttonClass} disabled={i === 0} aria-label={`Move ${s.label} earlier`}>
                  Earlier
                </button>
              </form>
              <form method="post" action={`/stages/${s.key}/move`}>
                <input type="hidden" name="dir" value="down" />
                <button class={buttonClass} disabled={i === active.length - 1} aria-label={`Move ${s.label} later`}>
                  Later
                </button>
              </form>
              <details class="relative">
                <summary class={buttonClass + " cursor-pointer list-none"}>Archive</summary>
                <form method="post" action={`/stages/${s.key}/archive`} class="mt-2 flex flex-col gap-2 rounded-card border border-line bg-surface p-3 shadow-lift">
                  {s.customers > 0 ? (
                    <Field label={`Move its ${s.customers === 1 ? `1 ${vocab.one.toLowerCase()}` : `${s.customers} ${many}`} to`}>
                      <select name="move_to" required class={controlClass}>
                        <option value="">Choose a stage</option>
                        {active
                          .filter((o) => o.key !== s.key)
                          .map((o) => (
                            <option value={o.key}>{o.label}</option>
                          ))}
                      </select>
                    </Field>
                  ) : (
                    <p class="text-label text-ink-3">Nobody is in this stage.</p>
                  )}
                  <button class={buttonClass + " self-start"}>Archive {s.label}</button>
                </form>
              </details>
            </div>
          </li>
        ))}
      </ol>

      <section class="mt-6 rounded-card border border-line bg-surface p-4" aria-labelledby="add-stage">
        <h2 id="add-stage" class="mb-3 text-label font-semibold text-ink-2">
          Add a stage
        </h2>
        <form method="post" action="/stages" class="flex flex-wrap items-end gap-3">
          <Field label="Name" class="min-w-48 flex-1">
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
      </section>

      {archived.length ? (
        <section class="mt-6" aria-labelledby="archived-stages">
          <h2 id="archived-stages" class="mb-2 text-label font-semibold text-ink-2">
            Archived stages
          </h2>
          <ul class="flex flex-col gap-2">
            {archived.map((s) => (
              <li class="flex flex-wrap items-center gap-3">
                <span>{s.label}</span>
                <span class="text-label text-ink-3">{KIND_LABELS[s.kind]}</span>
                <form method="post" action={`/stages/${s.key}/restore`}>
                  <button class={buttonClass}>Restore</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Layout>
  );
}
