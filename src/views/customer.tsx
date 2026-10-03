// One customer: their details (custom fields included), stage, notes
// timeline, their jobs or visits when the config has them, and everything
// they did across the project's tables. Plain forms throughout: every change
// is a POST answered with a 303 back here.
import { FieldList, JsonData, Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { StatusForm } from "../admin/status";
import { cfg, ownerLabel, visitsCfg, vocab } from "../config";
import type { Customer } from "../crm/customers";
import type { HistoryItem } from "../crm/history";
import { NOTE_KINDS, NOTE_LABELS, type Note } from "../crm/notes";
import type { Stage } from "../crm/stages";
import type { Visit } from "../crm/visits";
import { missingSentence, type Present } from "../crm/tables";
import { money, nowIn } from "../crm/text";
import { firstText } from "./inbox";
import { Layout } from "./layout";
import { buttonClass, controlClass, CustomInput, Field, MESSAGES, primaryClass, stageOptions, timeZone, Who } from "./ui";
import { CustomerVisits } from "./visits";

export function CustomerPage(p: {
  user: string;
  customer: Customer;
  stages: Stage[];
  notes: Note[];
  visits: Visit[];
  history: HistoryItem[];
  present: Present;
  owners: string[];
  flash: { code?: string | null; n?: string | null };
}) {
  const c = p.customer;
  const self = `/customers/${c.id}`;
  // A stage another app wrote, or one archived since, still shows and stays selectable.
  const stages = p.stages.some((s) => s.key === c.stage) ? p.stages : [...p.stages, { key: c.stage, label: c.stage, position: 999, kind: "open" as const, archived: true }];
  const options = stageOptions(stages);
  const missing = missingSentence(p.present, { submissions: true, bookings: true, payments: true });
  return (
    <Layout title={c.name} user={p.user} section="customers">
      <p class="mb-3 text-label">
        <a href="/customers">All {vocab.many.toLowerCase()}</a>
      </p>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="flex items-center gap-2">
          <span class="text-label text-ink-2" aria-hidden="true">Stage</span>
          <StatusForm action={`${self}/stage`} current={c.stage} options={options} returnTo={self} label="Stage" />
        </span>
        {c.phone ? <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`}>Call {c.phone}</a> : null}
        {c.email ? <a href={`mailto:${c.email}`} class="break-all">Email {c.email}</a> : null}
      </div>
      {c.archived_at ? (
        <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
          Archived <When at={c.archived_at} timeZone={timeZone} />. Still here, left out of lists and the pipeline.
        </p>
      ) : null}
      <div class="grid gap-4 md:grid-cols-3">
        {/* Jobs or visits lead: they are what the team works from. On a phone
            the notes come first: adding one is what a call needs, and the
            details form is long. Only the visual order moves. */}
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          {visitsCfg ? (
            <Section title={visitsCfg.many}>
              <CustomerVisits c={c} visits={p.visits} owners={p.owners} />
            </Section>
          ) : null}
          <Section title="Details">
            <Details c={c} owners={p.owners} />
          </Section>
          <Section title="Notes" class="order-first sm:order-none">
            <Notes c={c} notes={p.notes} />
          </Section>
          <Section title="Everything from this person">
            {missing ? <p class="mb-3 text-label text-ink-3">{missing}</p> : null}
            <History items={p.history} hasKey={!!(c.email || c.phone)} />
          </Section>
        </div>
        <div class="flex flex-col gap-4">
          <Section title="Record">
            <FieldList
              fields={[
                { label: "Last contact", value: <When at={c.last_contact_at} timeZone={timeZone} /> },
                { label: "Added", value: <Who at={c.created_at} by={c.created_by} /> },
                { label: "Changed", value: <Who at={c.updated_at} by={c.updated_by} /> },
              ]}
            />
          </Section>
          <Section title="Archive">
            <form method="post" action={`${self}/archive`} class="flex flex-col gap-2">
              <input type="hidden" name="archived" value={c.archived_at ? "0" : "1"} />
              <p class="text-label text-ink-3">
                {c.archived_at ? "Bring them back into the lists and the pipeline." : "Takes them out of the lists and the pipeline. Nothing is deleted."}
              </p>
              <button class={buttonClass + " self-start"}>{c.archived_at ? "Unarchive" : "Archive"}</button>
            </form>
          </Section>
        </div>
      </div>
    </Layout>
  );
}

function Details({ c, owners }: { c: Customer; owners: string[] }) {
  return (
    <form method="post" action={`/customers/${c.id}`} class="grid gap-3 sm:grid-cols-2">
      <Field label="Name">
        <input name="name" value={c.name} required maxlength={200} class={controlClass} />
      </Field>
      <Field label="Company">
        <input name="company" value={c.company ?? ""} maxlength={200} class={controlClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" value={c.email ?? ""} maxlength={254} class={controlClass} />
      </Field>
      <Field label="Phone">
        <input name="phone" type="tel" value={c.phone ?? ""} maxlength={40} class={controlClass} />
      </Field>
      <Field label="Address" class="sm:col-span-2">
        <input name="address" value={c.address ?? ""} maxlength={500} autocomplete="off" class={controlClass} />
      </Field>
      <Field label="Source">
        <input name="source" list="sources" value={c.source ?? ""} maxlength={100} class={controlClass} />
        <datalist id="sources">
          {cfg.sources.map((s) => (
            <option value={s} />
          ))}
        </datalist>
      </Field>
      <Field label={ownerLabel} hint="Who looks after them: a team member's email, or a name.">
        <input name="owner" list="owners" value={c.owner ?? ""} maxlength={200} class={controlClass} />
        <datalist id="owners">
          {owners.map((o) => (
            <option value={o} />
          ))}
        </datalist>
      </Field>
      <Field label="Tags" class="sm:col-span-2" hint="Separate tags with commas.">
        <input name="tags" value={c.tags.join(", ")} maxlength={1000} class={controlClass} />
      </Field>
      {cfg.fields.map((f) => (
        <CustomInput f={f} value={c.fields?.[f.key]} />
      ))}
      <Field label="About them" class="sm:col-span-2">
        <textarea name="notes" rows={3} maxlength={10000} class={controlClass}>
          {c.notes ?? ""}
        </textarea>
      </Field>
      <div class="sm:col-span-2">
        <button class={primaryClass}>Save</button>
      </div>
    </form>
  );
}

function Notes({ c, notes }: { c: Customer; notes: Note[] }) {
  return (
    <div class="flex flex-col gap-4">
      <form method="post" action={`/customers/${c.id}/notes`} aria-label="Add a note" class="grid gap-3 sm:grid-cols-3">
        <Field label="Type">
          <select name="kind" class={controlClass}>
            {NOTE_KINDS.map((k) => (
              <option value={k}>{NOTE_LABELS[k]}</option>
            ))}
          </select>
        </Field>
        <Field label="When" class="sm:col-span-2" hint={`In ${timeZone}.`}>
          <input name="at" type="datetime-local" value={nowIn(timeZone)} class={controlClass} />
        </Field>
        <Field label="What happened" class="sm:col-span-3">
          <textarea name="body" rows={3} required maxlength={10000} class={controlClass}></textarea>
        </Field>
        <div class="sm:col-span-3">
          <button class={primaryClass}>Add note</button>
        </div>
      </form>
      {notes.length ? (
        <ol class="flex flex-col gap-3">
          {notes.map((n) => (
            <li class="border-l-2 border-line pl-3">
              <p class="text-label text-ink-3">
                <span class="font-semibold text-ink-2">{NOTE_LABELS[n.kind] ?? n.kind}</span> · <When at={n.happened_at} timeZone={timeZone} />
                {n.author ? ` · ${n.author}` : ""}
              </p>
              <p class="whitespace-pre-wrap break-words">{n.body}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p class="text-ink-3">No notes yet.</p>
      )}
    </div>
  );
}

function History({ items, hasKey }: { items: HistoryItem[]; hasKey: boolean }) {
  if (!hasKey) return <p class="text-ink-3">Add an email or a phone number to see what this person sent, booked and paid.</p>;
  if (!items.length) return <p class="text-ink-3">Nothing from this person in the project's forms, bookings or payments.</p>;
  return (
    <ol class="flex flex-col gap-3">
      {items.map((i) => (
        <li class="border-l-2 border-line pl-3">
          <p class="text-label text-ink-3">
            <span class="font-semibold text-ink-2">{i.kind === "submission" ? i.form_title || i.form_key : i.kind === "booking" ? "Booking" : "Payment"}</span> ·{" "}
            <When at={i.at} timeZone={timeZone} /> · {i.status.replace(/_/g, " ")}
          </p>
          {i.kind === "submission" ? (
            <>
            {firstText(i.data) ? <p class="line-clamp-3 break-words">{firstText(i.data)}</p> : null}
            <details class="mt-1">
              <summary class="cursor-pointer text-label text-ink-2">Everything they sent</summary>
              <div class="mt-2">
                <JsonData data={i.data} />
              </div>
            </details>
            </>
          ) : i.kind === "booking" ? (
            <p>
              <When at={i.starts_at} timeZone={timeZone} />
              {i.resource_name ? ` with ${i.resource_name}` : ""}
            </p>
          ) : (
            <p>
              {money(i.amount_cents, i.currency)}
              {i.description ? `, ${i.description}` : ""}
              {i.livemode === false ? " (test mode)" : ""}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
