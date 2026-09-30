import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const globalForDb = globalThis;

const pool =
  globalForDb.__orbitPgPool ??
  new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
  });

globalForDb.__orbitPgPool = pool;

export const db = drizzle(pool, { schema });
export { pool, schema };
