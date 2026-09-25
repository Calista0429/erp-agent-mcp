// Generates the agent's MCP tool surface from the tenant schema *and* the caller's role.
// Two agents on the same tenant can see different tools; hidden fields do not exist in any
// input schema, so the model cannot even ask for them.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withTenant, type Principal, type Tx } from "../db.ts";
import type { ModelDef } from "../schema/dsl.ts";
import {
  canReadField, canReadModel, canWriteField, canWriteModel, readablePaths, writeSchema, type Registry,
} from "../schema/registry.ts";
import { audit, type Outcome } from "../runtime/audit.ts";
import { describePlanFor, planCommand, planGenericWrite, submitPlan, type Plan } from "../runtime/plan.ts";
import { aggregateRecords, conditionSchema, getRecord, listRecords, PermissionError } from "../runtime/query.ts";

type Result = { value: unknown; outcome?: Outcome; detail?: Record<string, unknown> };

const idempotencyKey = z
  .string().min(8).max(128)
  .describe("Unique per intended change. Reuse it when retrying the SAME request; use a new one for a different request.");

export function registerTools(server: McpServer, reg: Registry, principal: Principal): RegisteredTool[] {
  const role = principal.role;
  const tools: RegisteredTool[] = [];

  /** Every call: tenant-scoped transaction + audit row, including denied and failed calls. */
  const run = (tool: string, fn: (tx: Tx, args: any) => Promise<Result>) => async (args: any) => {
    const t0 = Date.now();
    try {
      const r = await withTenant(principal.workspace_id, async (tx) => {
        const r = await fn(tx, args);
        await audit(tx, principal, tool, args, r.outcome ?? "ok", r.detail ?? {}, reg.hash, Date.now() - t0);
        return r;
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.value, null, 2) }] };
    } catch (e) {
      const outcome: Outcome = e instanceof PermissionError ? "denied" : "error";
      const message = (e as Error).message;
      await withTenant(principal.workspace_id, (tx) =>
        audit(tx, principal, tool, args, outcome, { error: message }, reg.hash, Date.now() - t0),
      ).catch((err) => console.error("audit failed", err));
      return { isError: true, content: [{ type: "text" as const, text: `${outcome}: ${message}` }] };
    }
  };

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const planOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  // ---- describe_schema ---------------------------------------------------------------------
  tools.push(server.registerTool("describe_schema", {
    description: "Describe the ERP models, fields and commands visible to you in this workspace. Call this first.",
    inputSchema: {},
    annotations: readOnly,
  }, run("describe_schema", async () => ({
    value: {
      workspace: reg.workspace,
      you: { name: principal.name, role },
      schema_hash: reg.hash,
      models: [...reg.models.values()].filter((m) => canReadModel(m, role)).map((m) => ({
        name: m.name,
        description: m.description,
        fields: Object.fromEntries(
          Object.entries(m.fields).filter(([, f]) => canReadField(f.def, role)).map(([n, f]) => [n, {
            type: f.def.type,
            required: f.def.required,
            ...(f.def.model && { ref: f.def.model }),
            ...(f.def.values && { values: f.def.values }),
            ...(f.def.description && { description: f.def.description }),
            ...(!canWriteField(f.def, role) && canWriteModel(m, role) && { read_only: true }),
          }]),
        ),
      })),
      commands: [...reg.commands.values()].filter((c) => c.roles.includes(role)).map((c) => ({ name: c.name, description: c.description })),
      writes: "Write tools never change data directly: they return a plan (diff) that a human must approve.",
    },
  }))));

  // ---- per-model tools ---------------------------------------------------------------------
  for (const m of reg.models.values()) {
    if (!canReadModel(m, role)) continue;
    const paths = readablePaths(reg, m, role).map((p) => p.path) as [string, ...string[]];
    const pathEnum = z.enum(paths);
    const filter = z.partialRecord(pathEnum, conditionSchema).optional()
      .describe(`Conditions ANDed together. Keys are fields or one-hop ref paths, e.g. {"${paths.find((p) => p.includes(".")) ?? paths[1] ?? "id"}": {"eq": "..."}}`);

    tools.push(server.registerTool(`${m.name}_list`, {
      description: `List ${m.name} records. ${m.description}`,
      inputSchema: {
        filter,
        sort: z.object({ field: pathEnum, dir: z.enum(["asc", "desc"]).optional() }).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: readOnly,
    }, run(`${m.name}_list`, async (tx, args) => {
      const value = await listRecords(tx, reg, m, role, args);
      return { value, detail: { rows: value.records.length } };
    })));

    tools.push(server.registerTool(`${m.name}_get`, {
      description: `Get one ${m.name} by id.`,
      inputSchema: { id: z.uuid() },
      annotations: readOnly,
    }, run(`${m.name}_get`, async (tx, args) => {
      const value = await getRecord(tx, m, role, args.id);
      if (!value) throw new Error(`${m.name} ${args.id} not found`);
      return { value, detail: { rows: 1 } };
    })));

    tools.push(server.registerTool(`${m.name}_aggregate`, {
      description: `Group and aggregate ${m.name} records (count/sum/avg/min/max), sorted by the first metric descending.`,
      inputSchema: {
        groupBy: z.array(pathEnum).max(3).optional(),
        metrics: z.array(z.object({ fn: z.enum(["count", "sum", "avg", "min", "max"]), field: pathEnum.optional() })).min(1).max(5),
        filter,
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    }, run(`${m.name}_aggregate`, async (tx, args) => {
      const value = await aggregateRecords(tx, reg, m, role, args);
      return { value, detail: { rows: value.length } };
    })));

    if (!canWriteModel(m, role)) continue;
    const canCreate = Object.values(m.fields).every((f) => !f.def.required || canWriteField(f.def, role));

    if (canCreate) {
      tools.push(server.registerTool(`${m.name}_create`, {
        description: `Plan the creation of a ${m.name}. Returns a diff for human approval; nothing is written yet.`,
        inputSchema: { data: writeSchema(m, role, "create"), idempotency_key: idempotencyKey },
        annotations: planOnly,
      }, run(`${m.name}_create`, (tx, args) =>
        submit(tx, `${m.name}_create`, args, () => planGenericWrite(tx, reg, principal, m, { data: args.data })))));
    }

    tools.push(server.registerTool(`${m.name}_update`, {
      description: `Plan an update to a ${m.name}. Returns a diff for human approval; nothing is written yet.`,
      inputSchema: { id: z.uuid(), data: writeSchema(m, role, "update"), idempotency_key: idempotencyKey },
      annotations: planOnly,
    }, run(`${m.name}_update`, (tx, args) =>
      submit(tx, `${m.name}_update`, args, () => planGenericWrite(tx, reg, principal, m, { id: args.id, data: args.data })))));
  }

  // ---- commands (domain logic from tenants/<ws>/commands) -----------------------------------
  for (const cmd of reg.commands.values()) {
    if (!cmd.roles.includes(role)) continue;
    tools.push(server.registerTool(cmd.name, {
      description: `${cmd.description} Returns a plan for human approval; nothing is written yet.`,
      inputSchema: { ...cmd.input, idempotency_key: idempotencyKey },
      annotations: planOnly,
    }, run(cmd.name, (tx, { idempotency_key, ...input }) =>
      submit(tx, cmd.name, { ...input, idempotency_key }, () => planCommand(tx, reg, principal, cmd, input)))));
  }

  // ---- get_action ----------------------------------------------------------------------------
  tools.push(server.registerTool("get_action", {
    description: "Check the status of a planned action you submitted (pending / blocked / applied / rejected / failed / expired).",
    inputSchema: { action_id: z.uuid() },
    annotations: readOnly,
  }, run("get_action", async (tx, args) => {
    const { rows } = await tx.query(
      "select id, tool, status, plan, result, created_at, decided_at from pending_actions where id = $1 and requested_by = $2",
      [args.action_id, principal.id],
    );
    if (!rows[0]) throw new Error(`action ${args.action_id} not found`);
    const a = rows[0];
    return { value: { id: a.id, tool: a.tool, status: a.status, ...describePlanFor(reg, role, a.plan), result: a.result } };
  })));

  async function submit(tx: Tx, tool: string, args: any, makePlan: () => Promise<Plan>): Promise<Result> {
    const plan = await makePlan();
    const { idempotency_key, ...rest } = args;
    const action = await submitPlan(tx, reg, principal, tool, rest, idempotency_key, plan);
    const described = describePlanFor(reg, role, action.plan);
    const pending = action.status === "pending";
    return {
      outcome: "planned",
      detail: { action_id: action.id, status: action.status, replayed: action.replayed },
      value: {
        action_id: action.id,
        status: pending ? "pending_approval" : action.status,
        replayed: action.replayed,
        ...described,
        next: pending
          ? `NOT applied yet. A human (${action.plan.approvers.join("/")}) must approve it. Tell the user the action id; check with get_action.`
          : action.status === "blocked"
            ? "Blocked by the errors above. Fix the request and submit again with a NEW idempotency_key."
            : `Already ${action.status}.`,
      },
    };
  }

  return tools;
}
