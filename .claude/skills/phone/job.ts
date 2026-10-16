// The phone's share of the app's job every 15 minutes: the automatic texts
// time brings (follow.ts scan) and every text that is due, then the texting
// registration (made by the owner in Twilio's Console), read once an hour
// until it is approved. The app's job
// command builds the context and calls it (the CRM's src/phone-job.ts).
import { scan } from "./follow";
import { check } from "./registration";
import type { PhoneCtx } from "./send";
import { mainNumber } from "./store";

export type JobReport = { scheduled: number; sent: number; skipped: number; failed: number; later: number; registration: string | null };

export async function phoneJob(ctx: PhoneCtx): Promise<JobReport> {
  const counts = await scan(ctx);
  let registration: string | null = null;
  const n = await mainNumber(ctx.db);
  // Until approved, a refusal too: the owner fixes it in the Console, and this page follows.
  if (n && ctx.provider && n.texting !== "approved") {
    const last = n.registration.checked_at ? Date.parse(n.registration.checked_at) : 0;
    if (Date.now() - last > 55 * 60_000) {
      const r = await check(ctx.db, ctx.provider, n);
      registration = r.reg.last_error ? `registration: ${r.reg.last_error}` : `registration: ${r.texting}`;
    }
  }
  return { ...counts, registration };
}
