// A scratch schema for the database tests, made from TEST_DATABASE_URL and
// dropped after. The schema rides on the connection itself (options=-c
// search_path), so no query can slip through to the real tables before a
// per-connection SET lands; `public` stays on the path for the extensions'
// types and operators (citext, gin_trgm_ops). On a Task & Tool machine the
// app's login cannot create a schema, and these tests must never run against
// the real tables: they skip there and run wherever a scratch schema can be
// made.
import pg from "pg";
import type { Db } from "../src/data/db";
import { fromPool } from "../src/data/pg";

export type Scratch = { db: Db; pool: pg.Pool; schema: string; drop: () => Promise<void> };

export const NO_URL = "TEST_DATABASE_URL is not set (e.g. postgres://postgres:postgres@localhost/postgres)"; // secret-scan: allow (the local default)

export async function scratch(name: string): Promise<Scratch | string> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return NO_URL;
  const schema = `crm_test_${name}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  try {
    for (const ext of ["citext", "pg_trgm"]) {
      // Two test files may race to create it; the loser's error is harmless.
      await admin.query(`create extension if not exists ${ext}`).catch(() => {});
    }
    await admin.query(`create schema ${schema}`);
  } catch (e) {
    await admin.end();
    return "TEST_DATABASE_URL's role cannot create a scratch schema: " + (e instanceof Error ? e.message : String(e));
  }
  const withPath = url + (url.includes("?") ? "&" : "?") + "options=" + encodeURIComponent(`-c search_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: withPath, max: 4 });
  return {
    db: fromPool(pool),
    pool,
    schema,
    drop: async () => {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
