// What differs between dev (Node, on the machine) and production (a
// Cloudflare Worker): where this request's database comes from. Each entry
// hands the app one as `runtime` in the Hono env (src/server.ts,
// src/worker.ts); everything else is the same code. Who is signed in is not
// here: it is the X-TaskTool-User header, read by admin/guard.ts the same
// way in both.
import type { Db } from "./data/db";

export type DbState = "no-url" | "connecting" | "migrating" | "ready" | "error";

export type Opened =
  | { db: Db; close?: () => Promise<void> }
  | { db: null; state: DbState; error: string };

export type Runtime = {
  // The database for one request, or why there is none yet. A `close` runs
  // once the response body has been sent, without holding it up.
  open(): Opened;
};

export type AppEnv = {
  Bindings: { runtime: Runtime };
  Variables: { user: string; db: Db };
};
