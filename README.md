# Agent execution runtime for a headless ERP

A small MCP server that lets AI agents **read and operate** an ERP safely.
Business models are defined as code; the agent's tools are generated from that schema and
from the caller's role, and every write goes through *plan → human approval → atomic apply*.

```
 tenants/acme/models/*.ts  ──(hot reload)──┐        Claude Code / Claude Desktop
 tenants/acme/commands/*.ts                │                 │  MCP (stdio)
   (schema-as-code, edited by humans       ▼                 ▼
    or a coding agent)              ┌──────────────── MCP server ─────────────────┐
                                    │ token → principal (tenant, role, agent)      │
                                    │ tools generated per role:                    │
                                    │   read : <model>_list/_get/_aggregate        │
                                    │   write: <model>_create/_update, commands    │
                                    │          → returns a PLAN, never writes      │
                                    │ every call → audit_log                       │
                                    └───────────────┬──────────────────────────────┘
                                                    │ erp_app role, set app.workspace_id per tx
   human approver ── npm run approve ──► executor ──┤
   (dry-run diff, version check, atomic apply)      ▼
                                    Postgres: records (JSONB) · pending_actions · audit_log
                                              RLS on every tenant table
```

## Quick start

```bash
docker compose up -d
npm install
npm run setup -- --reset      # schema + two tenants + Northwind-style demo data
npm run demo                  # scripted end-to-end run of every scenario below, with assertions
```

To use it with a real agent, open this folder in Claude Code (it picks up `.mcp.json`), then ask e.g.
*"Who sold the most Chai last month? Then order 30 more Chai for Ernst Handel under that rep."*
Approve from another terminal:

```bash
ERP_TOKEN=acme-admin npm run approve -- list
ERP_TOKEN=acme-admin npm run approve -- approve <action_id>
ERP_TOKEN=acme-admin npm run approve -- audit
```

Demo tokens: `acme-sales-agent`, `acme-viewer-agent`, `globex-sales-agent` (agents),
`acme-admin` (human approver), `acme-sales-human` (human, cannot approve).

## What the demo shows

| # | Scenario | Mechanism |
|---|----------|-----------|
| 1 | Sales agent never sees `unit_cost` / `salary` | field-level `readableBy()`; hidden fields are absent from tool input schemas |
| 2 | "Who sold the most Chai last month?" | `order_line_aggregate` with one-hop ref paths (`order_id.order_date`) |
| 3 | Filtering on a hidden field is rejected | paths are an enum generated per role, so there's no side channel |
| 4 | Ordering 50 Chai (stock 39) | `place_order` command blocks the plan and nothing is written |
| 5 | Ordering 30 Chai | dry-run diff + reorder-level warning; prices come from the product master |
| 6 | Agent retries after a timeout | idempotency key returns the same action, so there's no double order |
| 7 | Approval | only a *human* with an approver role; plan applied in one transaction |
| 8 | Two plans race for the same stock | optimistic lock (`version`) fails the stale one instead of overselling |
| 9 | Viewer agent / other tenant | different tool surface; other tenant's ids are simply "not found" (RLS) |
| 10 | Coding agent adds `warehouse.ts` | hot reload → `tools/list_changed`; a broken edit keeps the last good schema |
| 11 | Audit | every call, including blocked and denied ones, with schema hash and latency |

## Design decisions (and their trade-offs)

- **Schema-as-code, not metadata tables.** Models are TS files: reviewable in git, testable,
  and a coding agent can edit them. The DB stores only `records.data` as JSONB.
  *Trade-off:* range filters on JSONB casts don't use the GIN index; production would generate
  expression indexes from schema hints or promote hot models to real tables.
- **Isolation lives in Postgres, not app code.** The runtime connects as `erp_app` (not the owner) with
  `FORCE ROW LEVEL SECURITY`; the tenant is a transaction-local setting. `erp_app` cannot
  DELETE records, UPDATE the audit log, or read the token table (lookup goes through a `SECURITY DEFINER` function).
- **Agents propose, humans dispose.** Write tools return a plan. Approval is a separate channel the
  agent has no tool for. Plans expire after 15 minutes and carry the schema hash they were computed against.
- **Business rules are commands, not prompts.** `place_order` computes prices, totals and stock
  movements in code, so the model supplies only intent.
- **Tools per model vs. generic tools.** Per-model tools give the LLM precise JSON Schemas (enums of
  valid fields), but the tool count grows with the schema. Beyond roughly 30 models I'd switch to
  `list(model, …)` plus on-demand `describe_schema`.
- **Known gaps:** inputs rejected by MCP schema validation never reach the handler, so they aren't audited.
  There's one process per principal (stdio), where a hosted version would use Streamable HTTP + OAuth.
  Commands read with full tenant visibility (trusted code), and only their output is masked.

## Layout

```
db/001_init.sql            tables, RLS policies, grants
src/schema/dsl.ts          defineModel / defineCommand / field builders   (imported as "#erp")
src/schema/registry.ts     load + validate tenant schema, permissions, per-role zod schemas
src/runtime/query.ts       read path: whitelisted paths → parameterized SQL over JSONB
src/runtime/plan.ts        write path 1: plan (dry-run diff), idempotent submission
src/runtime/execute.ts     write path 2: human approval, optimistic-lock apply
src/mcp/tools.ts           tool generation per (schema, role) + audit wrapper
src/mcp/server.ts          stdio entry, hot reload → tools/list_changed
src/cli/approve.ts         approver console (list / show / approve / reject / audit)
src/cli/setup.ts           migrate + seed
tenants/acme, tenants/globex   two tenants with different schemas
scripts/demo.ts            end-to-end rehearsal via a real MCP client
```
