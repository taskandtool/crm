// Settings, Business: the business's name, its privacy and terms pages and
// its postal address, set once for every app in the project (the data skill's `business` row),
// with where each shows, so the owner sees what customers and carriers read.
import { alertClass, Flash } from "../admin/flash";
import type { Business } from "../data/business";
import { ADDRESS_MAX, NAME_MAX } from "../data/business";
import { consentWords } from "../forms/consent";
import { fill, WORDS } from "../phone/flows";
import { Layout, SETTINGS_BACK } from "./layout";
import { controlClass, Field, primaryClass } from "./ui";

const SAVED = { saved: "Saved. Texts, quotes and the texting box use it from now on." };

export function BusinessPage(p: { user: string; business: Business; values?: Record<string, string>; error?: { field: string; why: string } | null; flash?: string | null }) {
  const v = p.values ?? { name: p.business.name ?? "", privacy_url: p.business.privacyUrl ?? "", terms_url: p.business.termsUrl ?? "", address: p.business.address ?? "" };
  const name = p.business.name;
  return (
    <Layout title="Business" user={p.user} section="settings" back={SETTINGS_BACK} sub="Your business's name, pages and address, set once. Every text, quote and form uses them.">
      <Flash code={p.flash} messages={SAVED} />
      {p.error ? <p role="alert" class={"mb-4 " + alertClass}>{p.error.why}</p> : null}
      <form method="post" action="/business" class="grid max-w-lg gap-4">
        <Field label="Business name" hint={`What customers know you as, up to ${NAME_MAX} letters. Every text names it.`}>
          <input name="name" value={v.name} required maxlength={NAME_MAX} autocomplete="organization" class={controlClass} aria-invalid={p.error?.field === "name" ? "true" : undefined} />
        </Field>
        <Field label="Privacy policy page" hint="Carriers want it named before your number can text. The texting box links it.">
          <input name="privacy_url" type="url" value={v.privacy_url} placeholder="https://" class={controlClass} aria-invalid={p.error?.field === "privacyUrl" ? "true" : undefined} />
        </Field>
        <Field label="Terms page" hint="If you have one. The texting box links it too.">
          <input name="terms_url" type="url" value={v.terms_url} placeholder="https://" class={controlClass} aria-invalid={p.error?.field === "termsUrl" ? "true" : undefined} />
        </Field>
        <Field label="Postal address" hint="If you have one to give. The follow-up emails that ask for a booking or a review end with it, as US law asks.">
          <input name="address" value={v.address} maxlength={ADDRESS_MAX} autocomplete="street-address" placeholder="12 Main St, Austin, TX 78701" class={controlClass} aria-invalid={p.error?.field === "address" ? "true" : undefined} />
        </Field>
        <div><button class={primaryClass}>Save</button></div>
      </form>

      <section class="mt-8 max-w-prose">
        <h2 class="mb-2 text-heading font-semibold text-ink">Where it shows</h2>
        {name ? (
          <dl class="space-y-3">
            <div>
              <dt class="font-medium">Texts</dt>
              <dd class="mt-1 rounded-2xl rounded-bl-sm bg-panel px-3 py-2">{fill(WORDS.missed_call.one, { business: name })}</dd>
            </div>
            <div>
              <dt class="font-medium">The texting box on your forms and booking page</dt>
              <dd class="mt-1 text-ink-2">{consentWords(name, "request", p.business)}</dd>
            </div>
            <div>
              <dt class="font-medium">Quotes, invoices and their emails</dt>
              <dd class="mt-1 text-ink-2">From {name}</dd>
            </div>
            {p.business.address ? (
              <div>
                <dt class="font-medium">The end of a follow-up email</dt>
                <dd class="mt-1 text-ink-2">{name}, {p.business.address}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p class="text-ink-2">Until it's set, texts say "it's us", quotes and invoices carry no name, and the texting box stays off your forms.</p>
        )}
      </section>
    </Layout>
  );
}
