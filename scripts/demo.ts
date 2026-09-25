// End-to-end rehearsal of the interview demo, driven through a real MCP client over stdio.
// Plays the part of the LLM with scripted tool calls and asserts on every result.
//   npm run setup -- --reset && npm run demo
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const root = join(import.meta.dirname, "..");
const env = { ...process.env } as Record<string, string>;
let failures = 0;

function check(cond: unknown, label: string) {
  console.log(`${cond ? "\x1b[32m✔" : "\x1b[31m✘"} ${label}\x1b[0m`);
  if (!cond) failures++;
}
const step = (s: string) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);

async function connect(token: string) {
  const client = new Client({ name: "demo", version: "0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged++; });
  await client.connect(new StdioClientTransport({
    command: "npx", args: ["tsx", "src/mcp/server.ts"], cwd: root, env: { ...env, ERP_TOKEN: token }, stderr: "ignore",
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { isError: !!r.isError, text, json };
  };
  const toolNames = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, call, toolNames, listChanged: () => listChanged };
}

const approve = (token: string, ...args: string[]) => {
  try {
    return execFileSync("npx", ["tsx", "src/cli/approve.ts", ...args], { cwd: root, env: { ...env, ERP_TOKEN: token }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    return String(e.stdout) + String(e.stderr);
  }
};

const today = new Date();
const ymd = (d: Date) => d.toLocaleDateString("sv-SE");
const lastMonthStart = ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1));
const thisMonthStart = ymd(new Date(today.getFullYear(), today.getMonth(), 1));

// ------------------------------------------------------------------------------------------
step("1. Sales agent discovers the schema (field-level masking)");
const sales = await connect("acme-sales-agent");
const salesTools = await sales.toolNames();
console.log(`   ${salesTools.length} tools: ${salesTools.join(", ")}`);
const schema = (await sales.call("describe_schema")).json;
const product = schema.models.find((m: any) => m.name === "product");
check(!("unit_cost" in product.fields), "product.unit_cost is invisible to role 'sales'");
check(salesTools.includes("place_order") && !salesTools.includes("order_line_create"), "order lines are writable only through place_order");

// ------------------------------------------------------------------------------------------
step("2. \"Who sold the most Chai last month?\" (one-hop ref paths, aggregate)");
const chai = (await sales.call("product_list", { filter: { name: { eq: "Chai" } } })).json.records[0];
const ranking = (await sales.call("order_line_aggregate", {
  groupBy: ["order_id.employee_id"],
  metrics: [{ fn: "sum", field: "line_total" }, { fn: "sum", field: "quantity" }],
  filter: { product_id: { eq: chai.id }, "order_id.order_date": { gte: lastMonthStart, lt: thisMonthStart } },
})).json;
const top = (await sales.call("employee_get", { id: ranking[0]["order_id.employee_id"] })).json;
console.log(`   ${lastMonthStart}..${thisMonthStart}: ${top.first_name} ${top.last_name} — $${ranking[0]["sum(line_total)"]} (${ranking[0]["sum(quantity)"]} units)`);
check(ranking.length > 0 && !("salary" in top), "ranking computed; employee.salary masked");

// ------------------------------------------------------------------------------------------
step("3. Hidden fields cannot be used as a side channel");
const sneaky = await sales.call("product_list", { filter: { unit_cost: { lt: 10 } } });
check(sneaky.isError, `filtering on unit_cost is rejected: ${sneaky.text.slice(0, 90).replace(/\s+/g, " ")}...`);

// ------------------------------------------------------------------------------------------
step("4. Agent places an order that would oversell -> blocked plan, nothing written");
const [customer] = (await sales.call("customer_list", { filter: { code: { eq: "ERNSH" } } })).json.records;
const blocked = (await sales.call("place_order", {
  customer_id: customer.id, employee_id: top.id, lines: [{ product_id: chai.id, quantity: 50 }], idempotency_key: "demo-order-001",
})).json;
console.log(`   ${blocked.status}: ${blocked.errors.join("; ")}`);
check(blocked.status === "blocked", "stock check blocks the plan");

// ------------------------------------------------------------------------------------------
step("5. Agent retries with 30 units -> dry-run diff + warning, waiting for a human");
const orderArgs = { customer_id: customer.id, employee_id: top.id, lines: [{ product_id: chai.id, quantity: 30 }], idempotency_key: "demo-order-002" };
const planned = (await sales.call("place_order", orderArgs)).json;
console.log(`   ${planned.status} ${planned.action_id}`);
for (const c of planned.changes) console.log(`     ${c.op} ${c.model} ${JSON.stringify(c.after ?? c.data)}`);
console.log(`     warnings: ${planned.warnings.join("; ")}`);
check(planned.status === "pending_approval", "plan is pending approval");
check(planned.changes.find((c: any) => c.model === "order_line")?.data.unit_price === 18, "price comes from the product master, not the agent");
const stockBefore = (await sales.call("product_get", { id: chai.id })).json.units_in_stock;
check(stockBefore === 39, "records untouched before approval (Chai stock still 39)");

// ------------------------------------------------------------------------------------------
step("6. Network blip: agent retries the same call -> same action, no duplicate order");
const replay = (await sales.call("place_order", orderArgs)).json;
check(replay.replayed && replay.action_id === planned.action_id, "idempotency key returns the original action");
const misuse = await sales.call("place_order", { ...orderArgs, lines: [{ product_id: chai.id, quantity: 1 }] });
check(misuse.isError && misuse.text.includes("already used"), "reusing a key for a different request is refused");

// ------------------------------------------------------------------------------------------
step("7. Approval: a human sales rep cannot approve, the ops manager can");
check(/cannot approve/.test(approve("acme-sales-human", "approve", planned.action_id)), "role 'sales' cannot approve");
const out = approve("acme-admin", "approve", planned.action_id);
process.stdout.write(out.replace(/^/gm, "   "));
check(/applied/.test(out), "admin approval applies the plan atomically");
const status = (await sales.call("get_action", { action_id: planned.action_id })).json;
const stockAfter = (await sales.call("product_get", { id: chai.id })).json.units_in_stock;
check(status.status === "applied" && stockAfter === 9, `get_action says applied; Chai stock 39 -> ${stockAfter}`);

// ------------------------------------------------------------------------------------------
step("8. Stale plan: two plans against the same stock, approve both");
const a1 = (await sales.call("place_order", { ...orderArgs, lines: [{ product_id: chai.id, quantity: 5 }], idempotency_key: "demo-order-003" })).json;
const a2 = (await sales.call("place_order", { ...orderArgs, lines: [{ product_id: chai.id, quantity: 4 }], idempotency_key: "demo-order-004" })).json;
approve("acme-admin", "approve", a1.action_id);
const second = approve("acme-admin", "approve", a2.action_id);
check(/changed after the plan was made/.test(second), "second approval fails on optimistic-lock conflict instead of overselling");

// ------------------------------------------------------------------------------------------
step("9. Other principals see other tool surfaces");
const viewer = await connect("acme-viewer-agent");
const viewerTools = await viewer.toolNames();
check(!viewerTools.some((t) => t.endsWith("_create") || t.endsWith("_update") || t === "place_order"), `viewer has read-only tools only (${viewerTools.length})`);
const globex = await connect("globex-sales-agent");
const globexTools = await globex.toolNames();
check(!globexTools.includes("product_list") && globexTools.includes("part_list"), "globex has its own schema (part, no product)");
const crossTenant = await globex.call("customer_get", { id: customer.id });
check(crossTenant.isError && /not found/.test(crossTenant.text), "acme customer id is invisible from globex (RLS)");

// ------------------------------------------------------------------------------------------
step("10. Coding agent adds a model -> running agent gets tools/list_changed");
const warehouseFile = join(root, "tenants/acme/models/warehouse.ts");
const brokenFile = join(root, "tenants/acme/models/zz_broken.ts");
try {
  const before = sales.listChanged();
  writeFileSync(warehouseFile, `import { defineModel, f } from "#erp";

export default defineModel({
  name: "warehouse",
  description: "Physical stock locations.",
  fields: { code: f.string(), city: f.string(), capacity_pallets: f.integer() },
  access: { read: ["admin", "sales", "viewer"], write: ["admin", "sales"] },
});
`);
  for (let i = 0; i < 40 && !(await sales.toolNames()).includes("warehouse_list"); i++) await new Promise((r) => setTimeout(r, 250));
  check((await sales.toolNames()).includes("warehouse_create") && sales.listChanged() > before, "warehouse_* tools appeared without restarting the server");

  writeFileSync(brokenFile, `import { defineModel, f } from "#erp";\nexport default defineModel({ name: "bad", description: "", fields: { x: f.ref("nope") }, access: { read: ["sales"] } });\n`);
  await new Promise((r) => setTimeout(r, 1500));
  check((await sales.toolNames()).includes("warehouse_list"), "an invalid schema edit is rejected; last good schema stays live");
} finally {
  rmSync(warehouseFile, { force: true });
  rmSync(brokenFile, { force: true });
}

// ------------------------------------------------------------------------------------------
step("11. Audit trail (what the ops manager sees)");
process.stdout.write(approve("acme-admin", "audit", "12").replace(/^/gm, "   "));

for (const c of [sales, viewer, globex]) await c.client.close();
console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : "\n\x1b[32mall checks passed\x1b[0m");
process.exitCode = failures ? 1 : 0;
