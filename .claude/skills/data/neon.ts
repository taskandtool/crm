// The handle on the Neon HTTP driver, for code that runs at the edge (the
// Website's Worker) and on the machine alike. One HTTP request per statement
// or per transaction; nothing is kept between requests.
//
//   import { fromNeon } from "../data/neon";
//   const getDb = (c: Context) => fromNeon(envVar(c, "DATABASE_URL"));   // a binding at the edge, the env on the machine (env.ts)
import { neon } from "@neondatabase/serverless";
import { q, type Db, type Query, type Row } from "./db";

export function fromNeon(url: string | undefined): Db {
  if (!url) throw new Error("DATABASE_URL is not set: this app has no database yet.");
  const n = neon(url);
  return {
    sql: async <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
      const { text, values: params } = q(strings, ...values);
      return (await n.query(text, params)) as T[];
    },
    transaction: async (queries: Query[]) =>
      (await n.transaction(queries.map(({ text, values }) => n.query(text, values)))) as Row[][],
  };
}
