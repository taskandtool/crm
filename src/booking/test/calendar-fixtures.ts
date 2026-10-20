// What the calendar tests share: the gateway as they see it (a fake fetch
// behind the real gatewayFetch, answering by "METHOD path-prefix" and
// recording every call), list-connections' answer, and a team to give
// calendars to.
import assert from "node:assert/strict";
import { applySchema } from "../../data/migrate";
import { gatewayFetch, type GrantedConnection } from "../../data/gateway";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import type { Gateway } from "../calendars";
import { createPerson } from "../hours";

const PHX = "https://phoenix.test";

export type Call = { method: string; url: string; path: string; auth: string | null; prefer: string | null; body: any };

/** A fake fetch: `routes` answers by "METHOD path-prefix"; every call is recorded. */
export function fake(routes: Record<string, (c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    const path = url.slice(`${PHX}/api/machine/gateway`.length);
    const c: Call = { method: init.method ?? "GET", url, path, auth: h.get("authorization"), prefer: h.get("prefer"), body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === c.method && path.startsWith(p);
    });
    if (!key) return new Response("no route", { status: 599 });
    return routes[key](c);
  }) as unknown as typeof fetch;
  const env = { PHOENIX_URL: PHX + "/", MACHINE_TOKEN: "mt-1" };
  const gw: Gateway = (slug, path, init) => gatewayFetch(env, slug, path, init, f);
  return { calls, gw };
}
export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

/** What list-connections gives for one connection's endpoint (data/gateway.ts). */
export const held = (slug: string, provider: string, account: string | null, service = "calendar"): GrantedConnection => ({ slug, provider, service, account });

/** The schema, then Pat and Sam on Team with no calendars. */
export async function team(s: Scratch, schema: string) {
  await applySchema(s.db, schema);
  const people = [];
  for (const [name, email] of [["Pat", "pat@example.com"], ["Sam", "sam@example.com"]]) {
    const p = await createPerson(s.db, { name, email, time_zone: "UTC" }, "o@example.com", "test");
    assert.ok(p.ok);
    people.push(p.value);
  }
  return people;
}

/** A scratch database for `fn`, dropped after; the test skips without one. */
export async function withDb(t: { skip: (m: string) => void }, fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await fn(s);
  } finally {
    await s.drop();
  }
}
