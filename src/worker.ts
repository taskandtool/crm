// Production's entry, on Cloudflare. Everything under dist/ (the built CSS,
// the vendored scripts) is served as static assets first; every other path
// reaches the app. Each request opens its own small pool on the
// DATABASE_URL binding and closes it once the response has been sent.
// Bundled by `npm run build` to build/worker.mjs; `pg` runs here through
// nodejs_compat. The schema is applied from the machine by `npm run deploy`,
// never from here.
import type { ExecutionContext } from "hono";
import app from "./app";
import { fromPool } from "./data/pg";
import { openPool } from "./db/pool";
import type { Runtime } from "./runtime";

type Bindings = { DATABASE_URL?: string } & Record<string, unknown>;

function runtime(env: Bindings): Runtime {
  return {
    open() {
      if (!env.DATABASE_URL) return { db: null, state: "no-url", error: "" };
      const pool = openPool(env.DATABASE_URL, 2);
      return { db: fromPool(pool), close: () => pool.end() };
    },
  };
}

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return app.fetch(request, { ...env, runtime: runtime(env) }, ctx);
  },
};
