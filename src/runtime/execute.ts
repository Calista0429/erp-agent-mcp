// Write path, step 2: a human approves (or rejects) a pending plan, and the executor applies
// it atomically. Agents have no tool that reaches this code.
import type { Principal, Tx } from "../db.ts";
import { audit } from "./audit.ts";
import type { Plan } from "./plan.ts";

export class ConflictError extends Error {}

export async function decide(tx: Tx, approver: Principal, actionId: string, decision: "approve" | "reject") {
  if (approver.kind !== "human") throw new Error("only human principals can approve or reject actions");

  const { rows } = await tx.query("select * from pending_actions where id = $1 for update", [actionId]);
  const action = rows[0];
  if (!action) throw new Error(`action ${actionId} not found`); // other tenants' actions are invisible (RLS)
  if (action.status !== "pending") throw new Error(`action is ${action.status}, not pending`);

  if (new Date(action.expires_at) < new Date()) {
    await tx.query("update pending_actions set status = 'expired' where id = $1", [actionId]);
    return { status: "expired", error: "the plan is older than 15 minutes; the agent must plan it again" };
  }

  const plan: Plan = action.plan;
  if (!plan.approvers.includes(approver.role)) {
    throw new Error(`role '${approver.role}' cannot approve this action (needs one of: ${plan.approvers.join(", ")})`);
  }

  if (decision === "reject") {
    await tx.query(
      "update pending_actions set status = 'rejected', decided_by = $2, decided_at = now() where id = $1",
      [actionId, approver.id],
    );
    await audit(tx, approver, "reject_action", { action_id: actionId }, "rejected", {});
    return { status: "rejected" };
  }

  await tx.query("savepoint apply");
  try {
    await applyPlan(tx, action.workspace_id, plan);
  } catch (e) {
    // Roll back partial ops but keep the failure on record.
    await tx.query("rollback to savepoint apply");
    const error = (e as Error).message;
    await tx.query(
      "update pending_actions set status = 'failed', decided_by = $2, decided_at = now(), result = $3 where id = $1",
      [actionId, approver.id, JSON.stringify({ error })],
    );
    await audit(tx, approver, "approve_action", { action_id: actionId }, "error", { error });
    return { status: "failed", error };
  }
  const result = { applied_ops: plan.ops.length, created: plan.ops.filter((o) => o.kind === "create").map((o) => `${o.model}:${o.id}`) };
  await tx.query(
    `update pending_actions set status = 'applied', decided_by = $2, decided_at = now(), applied_at = now(), result = $3
     where id = $1`,
    [actionId, approver.id, JSON.stringify(result)],
  );
  await audit(tx, approver, "approve_action", { action_id: actionId }, "applied", result);
  return { status: "applied", ...result };
}

async function applyPlan(tx: Tx, workspaceId: string, plan: Plan) {
  for (const op of plan.ops) {
    if (op.kind === "create") {
      await tx.query("insert into records (workspace_id, model, id, data) values ($1, $2, $3, $4)", [
        workspaceId, op.model, op.id, JSON.stringify(op.data),
      ]);
    } else {
      // Optimistic concurrency: the plan was computed against baseVersion. If someone changed
      // the record since (e.g. another order consumed the stock), the plan is stale.
      const res = await tx.query(
        `update records set data = data || $4::jsonb, version = version + 1, updated_at = now()
         where workspace_id = $1 and model = $2 and id = $3 and version = $5`,
        [workspaceId, op.model, op.id, JSON.stringify(op.patch), op.baseVersion],
      );
      if (res.rowCount !== 1) {
        throw new ConflictError(`${op.model} ${op.id} changed after the plan was made (expected version ${op.baseVersion}); re-plan`);
      }
    }
  }
}
