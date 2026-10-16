// The handle on node-postgres, for the apps that use pg (the Board, the
// CRM): on the machine, and in production deployed with nodejs_compat.
//
//   import { fromPool, openPool } from "../data/pg";
//   export const db = fromPool(openPool(env.DATABASE_URL));   // the app's one pool
import pg from "pg";
import { q, type Db, type Query, type Row } from "./db";

/**
 * A pool on a URL, the same in dev and in production. The direct Neon
 * host's connection limit is shared by every app in the project, so the
 * machine keeps four at most (a job or a Worker request two); the connect
 * budget is twenty seconds because a cold Neon endpoint takes a few to wake.
 */
export function openPool(url: string, max = 4): pg.Pool {
  // pg already treats sslmode=require as verify-full and warns about the
  // alias on every run; say verify-full outright so jobs and scripts stay quiet.
  const explicit = url.replace(/([?&])sslmode=(require|prefer|verify-ca)\b/, "$1sslmode=verify-full");
  const pool = new pg.Pool({ connectionString: explicit, max, connectionTimeoutMillis: 20_000, idleTimeoutMillis: 30_000 });
  // An idle connection the server drops (Neon suspending, a restart, the
  // network) is an 'error' event on the pool; with no listener Node throws
  // it and the whole server stops. The pool has already let that connection
  // go, and the next query opens a fresh one.
  pool.on("error", (e) => console.error(`database connection dropped: ${e.message}`));
  return pool;
}

export function fromPool(pool: pg.Pool): Db {
  return {
    sql: async <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
      const { text, values: params } = q(strings, ...values);
      return (await pool.query(text, params)).rows as T[];
    },
    transaction: async (queries: Query[]) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out: Row[][] = [];
        for (const { text, values } of queries) out.push((await client.query(text, values)).rows);
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
