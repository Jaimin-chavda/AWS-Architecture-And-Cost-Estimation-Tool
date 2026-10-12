/**
 * db.ts — Postgres connection pool (Supabase Transaction pooler via `pg`).
 *
 * Single shared `Pool` for the whole server process. The pool is created
 * lazily so importing this module never opens a connection — unit tests and
 * guest analysis requests run fine with no DATABASE_URL set.
 *
 * All queries go through `query(text, params)` with positional parameters
 * ($1, $2, ...). No string interpolation of values anywhere.
 */

import { Pool } from "pg";

let pool: Pool | null = null;

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local (see .env.example)."
    );
  }
  return new Pool({
    connectionString,
    // Supabase pooler (port 6543) requires TLS.
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Shared pool, created on first use. */
export function getPool(): Pool {
  if (!pool) pool = createPool();
  return pool;
}

/** True when a DATABASE_URL is configured (auth + history enabled). */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/**
 * Run a parameterized query. Values are passed separately from the SQL text
 * — callers must use $1, $2, ... placeholders, never template interpolation.
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const res = await getPool().query(text, params as unknown[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}
