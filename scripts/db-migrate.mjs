/**
 * db-migrate.mjs — run SQL migrations in src/lib/db/migrations/ (*.sql).
 *
 * Applies each file in name order inside one transaction per file.
 * Tracks applied files in schema_migrations(filename) so re-runs are no-ops.
 *
 * Needs DATABASE_URL (Supabase Transaction pooler string, port 6543).
 * Run: npm run db:migrate
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import pg from "pg";

const { Pool } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

// Next.js loads .env.local for the app, not for this script.
for (const f of [".env.local", ".env"]) {
  try {
    loadEnvFile(join(root, f));
    break;
  } catch {
    // try next candidate
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const dir = join(root, "src", "lib", "db", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

try {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    );
    const applied = await client.query(`SELECT filename FROM schema_migrations`);
    const done = new Set(applied.rows.map((r) => r.filename));
    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        console.log(`apply ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("migrations done");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
