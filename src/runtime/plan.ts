// Write path, step 1: turn an agent's intent into a plan (a dry-run diff) and park it in
// pending_actions. Nothing touches `records` here.
import { randomUUID } from "node:crypto";
import type { CommandDef, ModelDef, PlanContext, RecordRow } from "../schema/dsl.ts";
import { approversOf, canWriteField, fieldZod, maskData, type Registry } from "../schema/registry.ts";
import { PermissionError } from "./query.ts";
import type { Principal, Tx } from "../db.ts";

export type Op =
  | { kind: "create"; model: string; id: string; data: Record<string, unknown> }
  | { kind: "update"; model: string; id: string; baseVersion: number; before: Record<string, unknown>; patch: Record<string, unknown> };

export interface Plan {
  ops: Op[];
  warnings: string[];
  errors: string[];
  approvers: string[]; // human roles allowed to approve (union over touched models)
}

async function readRow(tx: Tx, model: string, id: string): Promise<RecordRow | null> {
  const { rows } = await tx.query("select id, version, data from records where model = $1 and id = $2", [model, id]);
  return rows[0] ?? null;
}

class Planner implements PlanContext {
  plan: Plan = { ops: [], warnings: [], errors: [], approvers: [] };
  constructor(private tx: Tx, private reg: Registry, readonly principal: Principal) {}

  private model(name: string): ModelDef {
    const m = this.reg.models.get(name);
    if (!m) throw new Error(`unknown model '${name}'`);
    for (const r of approversOf(m)) if (!this.plan.approvers.includes(r)) this.plan.approvers.push(r);
    return m;
  }

  get(model: string, id: string) {
    this.model(model);
    return readRow(this.tx, model, id);
  }

  async findOne(model: string, where: Record<string, unknown>) {
    this.model(model);
    const { rows } = await this.tx.query(
      "select id, version, data from records where model = $1 and data @> $2::jsonb limit 1",
      [model, JSON.stringify(where)],
    );
    return rows[0] ?? null;
  }

  create(model: string, data: Record<string, unknown>) {
    this.model(model);
    const id = randomUUID(); // pre-assigned so later ops in the same plan can reference it
    this.plan.ops.push({ kind: "create", model, id, data });
    return id;
  }

  update(model: string, row: RecordRow, patch: Record<string, unknown>) {
    this.model(model);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, row.data[k] ?? null]));
    this.plan.ops.push({ kind: "update", model, id: row.id, baseVersion: row.version, before, patch });
  }

  warn(message: string) { this.plan.warnings.push(message); }
  error(message: string) { this.plan.errors.push(message); }

  /** Schema-level checks on every staged op: types, required fields, refs exist in this tenant. */
  async validate() {
    const staged = new Set(this.plan.ops.filter((o) => o.kind === "create").map((o) => o.id));
    for (const op of this.plan.ops) {
      const m = this.reg.models.get(op.model)!;
      const values = op.kind === "create" ? op.data : op.patch;
      for (const [name, field] of Object.entries(m.fields)) {
        const v = values[name];
        if (v === undefined || v === null) {
          if (op.kind === "create" && field.def.required) this.error(`${op.model}.${name} is required`);
          continue;
        }
        const r = fieldZod(field.def).safeParse(v);
        if (!r.success) { this.error(`${op.model}.${name}: ${r.error.issues[0]?.message}`); continue; }
        if (field.def.type === "ref" && !staged.has(String(v)) && !(await readRow(this.tx, field.def.model!, String(v)))) {
          this.error(`${op.model}.${name}: ${field.def.model} ${v} does not exist`);
        }
      }
      for (const k of Object.keys(values)) if (!m.fields[k]) this.error(`${op.model}: unknown field '${k}'`);
    }
  }
}

export async function planGenericWrite(
  tx: Tx, reg: Registry, principal: Principal, m: ModelDef,
  args: { id?: string; data: Record<string, unknown> },
) {
  // Defense in depth: the tool's input schema already omits these fields for this role.
  for (const k of Object.keys(args.data)) {
    const field = m.fields[k];
    if (field && !canWriteField(field.def, principal.role)) throw new PermissionError(`cannot write ${m.name}.${k}`);
  }
  const p = new Planner(tx, reg, principal);
  if (args.id) {
    const row = await p.get(m.name, args.id);
    if (!row) p.error(`${m.name} ${args.id} not found`);
    else p.update(m.name, row, args.data);
  } else {
    p.create(m.name, args.data);
  }
  await p.validate();
  return p.plan;
}

export async function planCommand(tx: Tx, reg: Registry, principal: Principal, cmd: CommandDef, input: any) {
  const p = new Planner(tx, reg, principal);
  await cmd.plan(input, p);
  await p.validate();
  return p.plan;
}

/**
 * Persists the plan. Same (principal, idempotency_key) returns the original action instead
 * of creating a second one, so an agent that retries after a timeout cannot double-order.
 */
export async function submitPlan(
  tx: Tx, reg: Registry, principal: Principal, tool: string, args: unknown, idempotencyKey: string, plan: Plan,
) {
  const status = plan.errors.length ? "blocked" : "pending";
  const inserted = await tx.query(
    `insert into pending_actions (workspace_id, requested_by, tool, args, plan, schema_hash, idempotency_key, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (workspace_id, requested_by, idempotency_key) do nothing
     returning id, status, plan, false as replayed`,
    [principal.workspace_id, principal.id, tool, JSON.stringify(args), JSON.stringify(plan), reg.hash, idempotencyKey, status],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const { rows } = await tx.query(
    `select id, status, plan, tool, args, true as replayed from pending_actions where requested_by = $1 and idempotency_key = $2`,
    [principal.id, idempotencyKey],
  );
  const prev = rows[0];
  if (prev.tool !== tool || canonical(prev.args) !== canonical(args)) {
    throw new Error(`idempotency_key '${idempotencyKey}' was already used for a different request (action ${prev.id})`);
  }
  return prev;
}

/** What the agent sees: the diff, with fields it may not read removed. */
export function describePlanFor(reg: Registry, role: string, plan: Plan) {
  const mask = (model: string, data: Record<string, unknown>) => maskData(reg.models.get(model)!, data, role);
  return {
    changes: plan.ops.map((op) =>
      op.kind === "create"
        ? { op: "create", model: op.model, id: op.id, data: mask(op.model, op.data) }
        : { op: "update", model: op.model, id: op.id, before: mask(op.model, op.before), after: mask(op.model, op.patch) },
    ),
    warnings: plan.warnings,
    errors: plan.errors,
  };
}

// jsonb does not preserve key order, so compare with sorted keys.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
