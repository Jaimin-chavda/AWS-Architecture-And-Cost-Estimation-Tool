/**
 * auth.ts — better-auth server instance (email/password + Postgres).
 *
 * Database goes through Postgres via the Kysely adapter. Tables (`user`,
 * `session`, `account`, `verification`) are created by `npm run db:migrate`
 * — see src/lib/db/migrations/.
 *
 * Everything is lazy: importing this module never connects and never throws,
 * so unit tests and guest analysis run with no DATABASE_URL set. Env is
 * validated at request time via requireAuthEnv().
 *
 * Inference pipeline untouched: guests generate architectures with no login,
 * and nothing is saved for them.
 */

import { betterAuth } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";

let pool: Pool | null = null;

function getPool(): Promise<Pool> {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Add it to .env.local."
      );
    }
    pool = new Pool({
      connectionString,
      // Supabase pooler (port 6543) requires TLS.
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return Promise.resolve(pool);
}

// Pool factory is async, so Kysely only connects on first query — never at
// import time.
const kysely = new Kysely<unknown>({
  dialect: new PostgresDialect({ pool: () => getPool() }),
});

function getSecret(): string {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  // Import-safe placeholder. better-auth crashes the process (unhandled
  // rejection) when constructed with no secret, even if it is never used.
  // This random per-boot value only lets the module load — requireAuthEnv()
  // gates every entry point, so it never signs anything. Real secret required
  // for any auth traffic.
  return `unconfigured-${randomUUID()}`;
}

export const auth = betterAuth({
  secret: getSecret(),
  baseURL: process.env.BETTER_AUTH_URL,
  database: kyselyAdapter(kysely, { type: "postgres" }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
  },
});

export type Session = typeof auth.$Infer.Session;

/** Throw with a clear message when auth env is missing (request time). */
export function requireAuthEnv(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local."
    );
  }
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Add it to .env.local."
    );
  }
}

/**
 * Current signed-in user, or null for guests / missing DB config.
 * user_id for history rows always comes from here, never client input.
 */
export async function getSessionUser(): Promise<{ id: string; email: string } | null> {
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) return null;
  try {
    // Next 15+: headers() is async, must be awaited.
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return null;
    return { id: session.user.id, email: session.user.email };
  } catch {
    return null;
  }
}
