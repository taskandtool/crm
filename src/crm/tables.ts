// Which of the other apps' tables this project has. The CRM reads
// `submissions` (and `forms` for their titles) from the forms skill,
// `bookings` (and `resources`) from booking, and `payments` from payments.
// Any of them may be missing: a project with no Website has no submissions.
// `to_regclass` resolves a name exactly as an unqualified query would, so a
// table found here is the one the next query reads.
import type { Db } from "../data/db";

export type Present = { submissions: boolean; forms: boolean; bookings: boolean; resources: boolean; payments: boolean };

export async function present(db: Db): Promise<Present> {
  const [r] = await db.sql<Present>`
    select to_regclass('submissions') is not null as submissions,
           to_regclass('forms') is not null as forms,
           to_regclass('bookings') is not null as bookings,
           to_regclass('resources') is not null as resources,
           to_regclass('payments') is not null as payments`;
  return r;
}

/** One sentence about what is left out, or null when nothing is. */
export function missingSentence(p: Present, wanted: { submissions: boolean; bookings: boolean; payments: boolean }): string | null {
  const names: string[] = [];
  if (wanted.submissions && !p.submissions) names.push("form submissions");
  if (wanted.bookings && !p.bookings) names.push("bookings");
  if (wanted.payments && !p.payments) names.push("payments");
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
  return `This project has no ${list} yet. They show here once an app in the project collects them.`;
}
