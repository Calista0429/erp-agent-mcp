import type { Principal, Tx } from "../db.ts";

export type Outcome = "ok" | "denied" | "error" | "planned" | "approved" | "rejected" | "applied";

export async function audit(
  tx: Tx, principal: Principal, tool: string, args: unknown, outcome: Outcome,
  detail: Record<string, unknown>, schemaHash?: string, durationMs?: number,
) {
  await tx.query(
    `insert into audit_log (workspace_id, principal_id, tool, args, outcome, detail, schema_hash, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [principal.workspace_id, principal.id, tool, JSON.stringify(args ?? {}), outcome, JSON.stringify(detail), schemaHash ?? null, durationMs ?? null],
  );
}
