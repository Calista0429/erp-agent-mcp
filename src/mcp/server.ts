// MCP server entry (stdio). One process = one principal: ERP_TOKEN decides tenant and role.
//   ERP_TOKEN=acme-sales-agent DATABASE_URL=... tsx src/mcp/server.ts
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePrincipal } from "../db.ts";
import { loadRegistry } from "../schema/registry.ts";
import { registerTools } from "./tools.ts";

const log = (...a: unknown[]) => console.error("[erp-mcp]", ...a); // stdout is the MCP channel

const token = process.env.ERP_TOKEN;
if (!token) throw new Error("ERP_TOKEN is required");
const tenantsDir = resolve(process.env.TENANTS_DIR ?? join(import.meta.dirname, "../../tenants"));

const principal = await resolvePrincipal(token);
if (principal.kind !== "agent") throw new Error("the MCP server only serves agent principals; humans approve via the CLI");

const server = new McpServer(
  { name: `erp-${principal.workspace_id}`, version: "0.1.0" },
  {
    capabilities: { tools: { listChanged: true } },
    instructions:
      `You are operating the ERP of workspace '${principal.workspace_id}' as '${principal.name}' (role: ${principal.role}). ` +
      "Call describe_schema first. Read tools are safe. Write tools only create a plan that a human must approve: " +
      "always report the action_id and never claim a change is done until get_action says 'applied'.",
  },
);

let registry = await loadRegistry(tenantsDir, principal.workspace_id);
let tools: RegisteredTool[] = registerTools(server, registry, principal);
log(`workspace=${principal.workspace_id} role=${principal.role} schema=${registry.hash} tools=${tools.length}`);

// ---- Hot reload: schema files changed -> rebuild tools -> clients get tools/list_changed ----
let timer: NodeJS.Timeout | undefined;
watch(join(tenantsDir, principal.workspace_id), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const next = await loadRegistry(tenantsDir, principal.workspace_id);
      if (next.hash === registry.hash) return;
      for (const t of tools) t.remove();
      tools = registerTools(server, next, principal);
      log(`schema ${registry.hash} -> ${next.hash}, tools=${tools.length}`);
      registry = next;
    } catch (e) {
      // A broken edit keeps the last good schema live instead of taking agents down.
      log(`schema reload rejected, keeping ${registry.hash}:`, (e as Error).message);
    }
  }, 300);
});

await server.connect(new StdioServerTransport());
