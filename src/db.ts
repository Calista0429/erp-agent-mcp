import { createHash } from "node:crypto";
import pg from "pg";

export type Tx = pg.PoolClient;

// Keep DATE as "YYYY-MM-DD" instead of a timezone-shifted JS Date.
pg.types.setTypeParser(1082, (v) => v);

export interface Principal {
  id: string;
  workspace_id: string;
  name: string;
  kind: "human" | "agent";
  role: string;
}

// Connects as erp_app: not the table owner, not a superuser, so RLS always applies.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://erp_app:erp_app@localhost:55432/erp",
  max: 5,
});

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function resolvePrincipal(token: string): Promise<Principal> {
  const { rows } = await pool.query("select * from resolve_principal($1)", [hashToken(token)]);
  if (rows.length !== 1) throw new Error("invalid ERP_TOKEN");
  return rows[0];
}

/**
 * Runs fn in a transaction scoped to one tenant. `set_config(..., true)` is transaction-local,
 * so a pooled connection can never carry a previous tenant's id into the next request.
 */
export async function withTenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
