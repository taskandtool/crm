// The database in dev: pg on DATABASE_URL, one small pool, and the
// late-database rule. On Task & Tool the `web` service sources
// /home/sprite/.env once at start, and a fresh install can start the service
// moments before the platform writes DATABASE_URL into that file; a replaced
// machine sees the same gap for a few seconds. So the server comes up
// without a database, says so on one page, watches for the URL, and sets the
// database up the moment it appears. Off-platform the file does not exist
// and the env var is the whole story. Node only.
import { existsSync, readFileSync } from "node:fs";
import { cfg } from "../config";
import type { Db } from "../data/db";
import { fromPool } from "../data/pg";
import type { DbState, Runtime } from "../runtime";
import { openPool } from "./pool";
import { setup } from "./setup";

const ENV_FILE = "/home/sprite/.env";

let db: Db | null = null;
let state: DbState = "no-url";
let lastError = "";

export function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(ENV_FILE)) return undefined;
  try {
    const line = readFileSync(ENV_FILE, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
    const raw = line?.slice("DATABASE_URL=".length).trim();
    return raw ? raw.replace(/^(['"])(.*)\1$/, "$2") : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bring the database up in the background and keep trying until it is.
export async function start(log: (msg: string) => void = console.log): Promise<void> {
  for (;;) {
    const url = databaseUrl();
    if (!url) {
      if (state !== "no-url") log("DATABASE_URL is not set; waiting for it");
      state = "no-url";
      await sleep(3000);
      continue;
    }
    state = "connecting";
    const p = openPool(url);
    try {
      await p.query("select 1");
      state = "migrating";
      const handle = fromPool(p);
      const { seeded } = await setup(handle, cfg.stages);
      if (seeded) log(`seeded ${seeded} pipeline stages from crm.config.json`);
      db = handle;
      state = "ready";
      lastError = "";
      log("database ready");
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      state = "error";
      log(`database not ready yet: ${lastError}`);
      await p.end().catch(() => {});
      await sleep(5000);
    }
  }
}

// Dev's runtime: the one handle this server keeps, once it is ready.
export function machineRuntime(): Runtime {
  return { open: () => (state === "ready" && db ? { db } : { db: null, state, error: lastError }) };
}
