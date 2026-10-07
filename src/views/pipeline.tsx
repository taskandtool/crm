// The pipeline: a column per active stage in order, a card per active
// customer. Drag a card to another column (static/crm.js posts the same
// stage change the card's own select makes), or use the select: it posts
// through htmx on change, and without JavaScript it is a form with a Save
// button. Either way the server answers with the whole pipeline again.
import { Flash } from "../admin/flash";
import { StatusForm } from "../admin/status";
import { ownerLabel, vocab } from "../config";
import type { Customer } from "../crm/customers";
import type { Stage } from "../crm/stages";
import { KIND_LABELS } from "../crm/stages";
import { Layout } from "./layout";
import { MESSAGES, stageOptions, ViewSwitch } from "./ui";

export const PER_COLUMN = 100;

export type PipelineData = { stages: Stage[]; cards: Customer[]; counts: Record<string, number> };

export function PipelinePage(p: { user: string; data: PipelineData; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title="Pipeline" user={p.user} section="customers" drag wide>
      <ViewSwitch current="pipeline" />
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <p class="mb-3 text-label text-ink-3">Drag a card to another stage (on a phone, press and hold first), or choose its stage from the card.</p>
      <Pipeline data={p.data} />
    </Layout>
  );
}

export function Pipeline({ data }: { data: PipelineData }) {
  const { stages, cards, counts } = data;
  const known = new Set(stages.map((s) => s.key));
  // Customers in a stage that is archived or unknown (another app wrote it)
  // get a column of their own at the start, so nobody disappears.
  const strays = cards.filter((c) => !known.has(c.stage));
  const options = stageOptions(stages);
  const column = (key: string, label: string, kind: string | null, list: Customer[], total: number) => (
    <section data-stage={key} aria-label={`${label}, ${total}`} class="flex min-w-60 max-w-80 flex-1 basis-0 flex-col rounded-card bg-panel p-2">
      <h2 class="mb-2 flex items-baseline justify-between gap-2 px-1 text-label">
        <span class="font-semibold text-ink">{label}</span>
        <span class="text-ink-3">
          {kind ? `${kind} · ` : ""}
          {total}
        </span>
      </h2>
      <ul data-cards data-stage={key} class="flex flex-1 flex-col gap-2">
        {list.map((c) => (
          <Card c={c} options={options} stray={!known.has(c.stage)} />
        ))}
      </ul>
      {total > list.length ? (
        <a href={`/customers?stage=${encodeURIComponent(key)}`} class="mt-2 px-1 text-label text-ink-2">
          and {total - list.length} more
        </a>
      ) : null}
    </section>
  );
  return (
    <div id="pipeline">
      {!cards.length ? (
        <p class="mb-3 text-ink-2">
          No {vocab.many.toLowerCase()} yet. They appear here as they are added: from What came in, by hand on the <a href="/customers">list</a>, or from an import.
        </p>
      ) : null}
      <div class="flex gap-3 overflow-x-auto pb-3">
      {strays.length
        ? column("", "Not in a stage", null, strays, strays.length)
        : null}
      {stages.map((s) =>
        column(
          s.key,
          s.label,
          s.kind === "open" || s.label.toLowerCase() === s.kind ? null : KIND_LABELS[s.kind],
          cards.filter((c) => c.stage === s.key),
          counts[s.key] ?? 0,
        ),
      )}
      </div>
    </div>
  );
}

function Card({ c, options, stray }: { c: Customer; options: ReturnType<typeof stageOptions>; stray: boolean }) {
  const sub = [c.company, c.phone || c.email].filter(Boolean).join(" · ");
  return (
    <li data-customer-id={c.id} class="cursor-pointer rounded-card border border-line bg-surface px-3 py-2 shadow-card hover:border-line-strong">
      <a href={`/customers/${c.id}`} class="font-semibold no-underline">
        {c.name}
      </a>
      {sub ? <p class="truncate text-label text-ink-2">{sub}</p> : null}
      {c.owner || c.tags.length ? (
        <p class="truncate text-label text-ink-3">
          {c.owner ? `${ownerLabel}: ${c.owner}` : ""}
          {c.owner && c.tags.length ? " · " : ""}
          {c.tags.join(", ")}
        </p>
      ) : null}
      <div class="mt-2">
        <StatusForm
          action={`/customers/${c.id}/stage`}
          current={stray ? "" : c.stage}
          options={stray ? [{ value: "", label: "Choose a stage" }, ...options] : options}
          returnTo="/pipeline"
          label={`Stage of ${c.name}`}
          swap="#pipeline"
        />
      </div>
    </li>
  );
}
