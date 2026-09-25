// Connection settings come from the environment, with the repo-root .env as a fallback.
// No credentials live in the source tree; `npm run init-env` creates a .env with random passwords.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "pg";

const envFile = join(import.meta.dirname, "../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run \`npm run init-env\` (or copy .env.example to .env) first.`);
  return v;
}

function config(user: string, passwordVar: string, urlVar: string): PoolConfig {
  // A full URL still works for hosted databases; otherwise build from PG* parts.
  if (process.env[urlVar]) return { connectionString: process.env[urlVar] };
  return {
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 55432),
    database: process.env.PGDATABASE ?? "erp",
    user,
    password: required(passwordVar),
  };
}

/** Runtime role: not the table owner, not a superuser, so RLS always applies. */
export const appDbConfig = () => config("erp_app", "ERP_APP_PASSWORD", "DATABASE_URL");
/** Owner/superuser: only for migrations and seeding. */
export const adminDbConfig = () => config("postgres", "POSTGRES_PASSWORD", "ADMIN_DATABASE_URL");
