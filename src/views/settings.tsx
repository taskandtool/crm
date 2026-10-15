// Settings, as Jobber's and HubSpot's settings pages: each part of how the
// business is set up, with a line on what it holds, apart from the daily work.
import { Layout, SETTINGS } from "./layout";

export function SettingsPage({ user }: { user: string }) {
  return (
    <Layout title="Settings" user={user} section="settings">
      <ul class="grid gap-3 sm:grid-cols-2">
        {SETTINGS.map((s) => (
          <li>
            <a href={s.href} class="block h-full rounded-card bg-surface px-5 py-4 no-underline shadow-card ring-1 ring-line hover:bg-canvas focus-visible:outline-2 focus-visible:outline-accent">
              <span class="block font-semibold text-ink">{s.label}</span>
              <span class="mt-1 block text-ink-2">{s.about}</span>
            </a>
          </li>
        ))}
      </ul>
    </Layout>
  );
}
