// The end of the page: Accept while it is open, the signature once signed,
// or why it is closed. Drawn when the page is asked for (public.tsx), into
// the one marker the stored page carries; everything above it is the stored
// file. The form posts to the page's own link: no script anywhere.
import { formatMoney } from "../../payments/money";
import { INVOICE_STATUS_LABELS, type Invoice } from "../../invoices/invoices";

export type AcceptState =
  | { kind: "preview" }
  | { kind: "open"; action: string; sha: string; reasons: string[]; problem?: string; name?: string }
  | { kind: "signed"; name: string; when: string; invoices: Invoice[]; pay: Invoice | null; note?: string }
  | { kind: "declined" }
  | { kind: "expired"; business: string }
  | { kind: "decided"; business: string };

const button = "inline-flex min-h-12 items-center justify-center rounded-control bg-accent px-6 font-semibold text-accent-ink no-underline hover:opacity-90";
const field = "mt-1 block w-full rounded-control border border-line-strong bg-canvas px-3 py-2.5 text-body";

export function Accept({ s, word }: { s: AcceptState; word: string }) {
  const w = word.toLowerCase();
  if (s.kind === "signed") {
    return (
      <div class="rounded-box border border-line p-6 sm:p-8">
        <p class="text-label uppercase text-muted">Signed</p>
        <p class="mt-2 font-display text-section">{s.name}</p>
        <p class="mt-1 text-small text-muted">{s.when}</p>
        {s.note ? <p class="mt-4 text-body">{s.note}</p> : null}
        {s.pay?.hosted_url ? (
          <div class="mt-6 rounded-box bg-panel p-5">
            <p class="text-body">Next: pay {formatMoney(s.pay.total_cents, s.pay.currency)} to get started.</p>
            <a href={s.pay.hosted_url} class={button + " mt-4"} rel="noopener">Pay now</a>
          </div>
        ) : null}
        {s.invoices.length ? (
          <ul class="mt-6 flex flex-col gap-1 text-small">
            {s.invoices.map((i) => (
              <li class="flex justify-between gap-4 border-t border-line pt-2 tabular-nums">
                <span>{i.number ? `Invoice ${i.number}` : "Invoice"}</span>
                <span>{formatMoney(i.total_cents, i.currency)} · {i.status === "draft" ? "Coming by email" : INVOICE_STATUS_LABELS[i.status]}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p class="mt-6 text-small text-muted print:hidden">This page is your copy: print it or save it as a PDF from your browser.</p>
      </div>
    );
  }
  if (s.kind === "declined") return <p class="rounded-box bg-panel p-6 text-body">You declined this {w}. Thank you for letting us know.</p>;
  if (s.kind === "expired") return <p class="rounded-box bg-panel p-6 text-body">This {w} has expired. Ask {s.business || "us"} for a new one.</p>;
  if (s.kind === "decided") return <p class="rounded-box bg-panel p-6 text-body">This {w} is closed. Ask {s.business || "us"} if you have questions.</p>;

  const open = s.kind === "open";
  return (
    <div>
      {open && s.problem ? <p role="alert" class="mb-6 rounded-box border border-line-strong bg-panel p-4 text-body">{s.problem}</p> : null}
      {!open ? <p class="mb-6 rounded-box bg-panel p-4 text-small text-muted">A preview: on the customer's page this form signs it.</p> : null}
      <form method="post" action={open ? s.action : undefined} class="flex flex-col gap-5">
        {open ? <input type="hidden" name="page" value={s.sha} /> : null}
        <label class="block text-small font-semibold">
          Type your full name
          <input name="name" required maxlength={120} autocomplete="name" value={open ? s.name ?? "" : ""} disabled={!open} class={field} />
        </label>
        <label class="flex items-start gap-3 text-body">
          <input type="checkbox" name="agree" value="1" required disabled={!open} class="mt-1.5 size-4 shrink-0" />
          <span>I agree to the terms above and to sign electronically.</span>
        </label>
        <div>
          <button class={button} disabled={!open}>Accept</button>
          <p class="mt-3 text-small text-muted">By typing your name and pressing Accept you sign this {w}.</p>
        </div>
      </form>
      {open ? (
        <details class="mt-10 border-t border-line pt-6 print:hidden">
          <summary class="cursor-pointer text-small text-muted">Not going ahead?</summary>
          <form method="post" action={`${s.action}/decline`} class="mt-4 flex flex-col gap-4">
            <input type="hidden" name="page" value={s.sha} />
            <label class="block text-small font-semibold">
              The main reason
              <select name="reason" class={field}>
                {[...s.reasons, "Other"].map((r) => <option value={r}>{r}</option>)}
              </select>
            </label>
            <label class="block text-small font-semibold">
              Anything you would like us to know (optional)
              <textarea name="note" rows={3} maxlength={1000} class={field}></textarea>
            </label>
            <div><button class="inline-flex min-h-11 items-center rounded-control border border-line-strong px-5 font-semibold">Decline</button></div>
          </form>
        </details>
      ) : null}
    </div>
  );
}

/** On screen while it is open, a bar that takes them to Accept; never on paper. */
export function AcceptBar({ word }: { word: string }) {
  return (
    <div class="sticky bottom-0 z-10 border-t border-line bg-canvas/95 print:hidden">
      <div class="mx-auto flex max-w-read items-center justify-between gap-4 px-5 py-3">
        <span class="text-small text-muted">Ready to go ahead?</span>
        <a href="#accept" class="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-small font-semibold text-accent-ink no-underline">Review and accept the {word.toLowerCase()}</a>
      </div>
    </div>
  );
}
