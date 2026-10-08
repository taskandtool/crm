// Merging another record into this one: find it (the likely ones first),
// see what will move, then merge. The record on this page is the one kept.
import { Flash } from "../admin/flash";
import { listUrl } from "../admin/query";
import { dealsCfg, visitsCfg, vocab } from "../config";
import type { Customer } from "../crm/customers";
import type { MergePreview } from "../crm/merge";
import { Layout } from "./layout";
import { buttonClass, controlClass, MESSAGES, primaryClass } from "./ui";

const who = (c: Customer) => [c.email, c.phone, c.company].filter(Boolean).join(" · ");

export function MergePage(p: {
  user: string;
  keep: Customer;
  q: string | null;
  found: Customer[];
  duplicates: Customer[];
  preview: MergePreview | null;
  flash: { code?: string | null; n?: string | null };
}) {
  const self = `/customers/${p.keep.id}/merge`;
  const one = vocab.one.toLowerCase();
  const pick = (c: Customer) => (
    <li class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 last:border-b-0">
      <span class="min-w-0">
        <span class="font-semibold">{c.name}</span>
        <span class="block break-words text-label text-ink-2">{who(c) || "No email or phone"}</span>
      </span>
      <a href={listUrl(self, { other: c.id })} class={buttonClass + " no-underline"}>Choose</a>
    </li>
  );
  return (
    <Layout title={`Merge into ${p.keep.name}`} user={p.user} section="customers">
      <p class="mb-3 text-label">
        <a href={`/customers/${p.keep.id}`}>Back to {p.keep.name}</a>
      </p>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      {p.preview ? (
        <section class="mb-6 rounded-card border border-line bg-surface p-4" aria-labelledby="merge-what">
          <h2 id="merge-what" class="mb-2 text-copy font-semibold">
            {p.preview.other.name} into {p.keep.name}
          </h2>
          <p class="mb-3 text-ink-2">{who(p.preview.other) || "No email or phone"}</p>
          <ul class="mb-3 flex list-disc flex-col gap-1 pl-5">
            <li>{p.preview.moves.notes} notes, {p.preview.moves.deals} {dealsCfg.many.toLowerCase()}, {p.preview.moves.followUps} follow-ups{visitsCfg ? `, ${p.preview.moves.visits} ${visitsCfg.many.toLowerCase()}` : ""} move here.</li>
            {p.preview.fills.length ? <li>{p.keep.name} gains: {p.preview.fills.join(", ")}.</li> : null}
            <li>What they sent, booked, paid and were quoted under either address shows here.</li>
            <li>{p.preview.other.name}'s record is archived and opens this one. A merge is not undone.</li>
          </ul>
          <form method="post" action={self} class="flex flex-wrap gap-2">
            <input type="hidden" name="other" value={p.preview.other.id} />
            <button class={primaryClass}>Merge into {p.keep.name}</button>
            <a href={self} class={buttonClass + " no-underline"}>Choose another</a>
          </form>
        </section>
      ) : null}
      {p.duplicates.length ? (
        <section class="mb-6" aria-labelledby="maybe">
          <h2 id="maybe" class="mb-2 text-label font-semibold text-ink-2">Possible duplicates</h2>
          <ul class="overflow-hidden rounded-card border border-line bg-surface">{p.duplicates.map(pick)}</ul>
        </section>
      ) : null}
      <form method="get" action={self} class="mb-3 flex flex-wrap items-center gap-2">
        <input name="q" value={p.q ?? ""} placeholder="Name, email, phone or company" aria-label={`Find the other ${one}`} class={controlClass + " min-w-64 flex-1"} />
        <button class={buttonClass}>Find</button>
      </form>
      {p.q ? (
        p.found.length ? <ul class="overflow-hidden rounded-card border border-line bg-surface">{p.found.map(pick)}</ul> : <p class="text-ink-3">Nobody else matches "{p.q}".</p>
      ) : null}
    </Layout>
  );
}
