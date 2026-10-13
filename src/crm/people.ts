// Who a customer, request or task is for. The owner is free text (a name,
// or an email so the morning email reaches them), so one team member can be
// written either way. The Team (the booking skill's `resources`) is the one
// list of names: an owner written as a team member's email shows as their
// name, the filters offer each person once, and filtering by a person finds
// them written either way, as HubSpot shows an owner by name; anyone else
// shows as written. Loaded once per request (the middleware in app.tsx);
// scripts that never load it see owners as written.
import type { Db } from "../data/db";

export type Person = { name: string; email: string | null };

let team: Person[] = [];

/** Read the team for this request (the booking skill's resources, which setup always makes). */
export async function loadTeam(db: Db): Promise<Person[]> {
  team = await db.sql<Person>`select name, email::text as email from resources order by active desc, name, id`;
  return team;
}

/** For tests: the team as given. */
export function setTeam(people: Person[]): void {
  team = people;
}

const lower = (s: string) => s.trim().toLowerCase();

function memberOf(owner: string): Person | undefined {
  const o = lower(owner);
  return team.find((p) => lower(p.name) === o || (p.email && lower(p.email) === o));
}

/** An owner as people read it: a team member by name, anyone else as written. */
export function personName(owner: string | null | undefined): string {
  if (!owner) return "";
  return memberOf(owner)?.name ?? owner;
}

/** Every way one person's owner can be written: their name and email when they are on the team. */
export function sameAs(owner: string): string[] {
  const p = memberOf(owner);
  return p ? [p.name, ...(p.email ? [p.email] : [])] : [owner];
}

/**
 * A person filter's or an owner field's choices: the team first, then you
 * (marked "(me)"), then anyone else already written down, each person once.
 */
export function ownerOptions(user: string, used: string[]): { value: string; label: string }[] {
  const me = memberOf(user);
  const out: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string) => {
    const k = lower(value);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ value, label });
  };
  for (const p of team) add(p.name, p === me ? `${p.name} (me)` : p.name);
  if (!me) add(user, `${user} (me)`);
  for (const o of used) if (o.trim()) add(personName(o), personName(o));
  return out;
}

/** What an owner field suggests: the team by name, then anyone else written down, each once. */
export function ownerSuggestions(owners: string[]): string[] {
  return [...new Set([...team.map((p) => p.name), ...owners.filter((o) => o.trim()).map(personName)])];
}
