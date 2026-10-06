// The handle on node-postgres, for the apps that use pg (the Board, the
// CRM): on the machine, and in production deployed with nodejs_compat.
//
//   import { fromPool } from "../data/pg";
//   export const db = fromPool(pool);   // pool is the app's one pg.Pool
import type pg from "pg";
import { q, type Db, type Query, type Row } from "./db";

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
