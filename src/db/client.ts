import pg from "pg";
import type { Env } from "../config/env.js";

const { Pool } = pg;

export function createPool(env: Env): pg.Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}

