// Creates the schema and seeds two tenants with demo data. Runs as a superuser/owner.
//   npm run setup -- --reset      (connection settings: see .env.example)
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { hashToken } from "../db.ts";
import { adminDbConfig } from "../env.ts";

const db = new pg.Client(adminDbConfig());
await db.connect();

if (process.argv.includes("--reset")) {
  await db.query("drop table if exists audit_log, pending_actions, records, principals, workspaces cascade");
}
await db.query(await readFile(join(import.meta.dirname, "../../db/001_init.sql"), "utf8"));
// The runtime role's password comes from the environment, not from the SQL file.
const appPassword = process.env.ERP_APP_PASSWORD ?? (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).password);
if (!appPassword) throw new Error("ERP_APP_PASSWORD is not set. Run `npm run init-env` first.");
await db.query(`alter role erp_app with login password ${db.escapeLiteral(appPassword)}`);

// ---- Tenants & principals (demo tokens; real systems would issue random secrets) ----------
await db.query("insert into workspaces (id, name) values ('acme', 'Acme Foods'), ('globex', 'Globex Machinery')");
const principals: [string, string, "human" | "agent", string, string][] = [
  // token,              workspace, kind,    role,     name
  ["acme-sales-agent",   "acme",   "agent", "sales",  "sales-assistant"],
  ["acme-viewer-agent",  "acme",   "agent", "viewer", "reporting-bot"],
  ["acme-admin",         "acme",   "human", "admin",  "Aiko (ops manager)"],
  ["acme-sales-human",   "acme",   "human", "sales",  "Ken (sales rep)"],
  ["globex-sales-agent", "globex", "agent", "sales",  "globex-assistant"],
  ["globex-admin",       "globex", "human", "admin",  "Globex admin"],
];
for (const [token, ws, kind, role, name] of principals) {
  await db.query("insert into principals (workspace_id, name, kind, role, token_hash) values ($1, $2, $3, $4, $5)", [ws, name, kind, role, hashToken(token)]);
}

async function insert(ws: string, model: string, data: object) {
  const id = randomUUID();
  await db.query("insert into records (workspace_id, model, id, data) values ($1, $2, $3, $4)", [ws, model, id, JSON.stringify(data)]);
  return id;
}

// ---- Acme: Northwind-style food distributor ------------------------------------------------
let seed = 42; // deterministic PRNG so every demo run has the same numbers
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const products: [string, string, number, number, number, number][] = [
  // name, category, price, cost, stock, reorder
  ["Chai", "Beverages", 18, 11.2, 39, 10],
  ["Chang", "Beverages", 19, 12.1, 17, 25],
  ["Aniseed Syrup", "Condiments", 10, 5.8, 13, 25],
  ["Chef Anton's Cajun Seasoning", "Condiments", 22, 13.5, 53, 0],
  ["Grandma's Boysenberry Spread", "Condiments", 25, 14, 120, 25],
  ["Uncle Bob's Organic Dried Pears", "Produce", 30, 19.9, 15, 10],
  ["Northwoods Cranberry Sauce", "Condiments", 40, 24, 6, 0],
  ["Mishi Kobe Niku", "Meat/Poultry", 97, 71, 29, 0],
  ["Ikura", "Seafood", 31, 20.5, 31, 0],
  ["Queso Cabrales", "Dairy Products", 21, 12.6, 22, 30],
  ["Konbu", "Seafood", 6, 3.1, 24, 5],
  ["Tofu", "Produce", 23.25, 14, 35, 0],
  ["Pavlova", "Confections", 17.45, 9.9, 29, 10],
  ["Tarte au sucre", "Confections", 49.3, 30, 17, 0],
];
const productIds: { id: string; price: number; name: string }[] = [];
for (const [name, category, unit_price, unit_cost, units_in_stock, reorder_level] of products) {
  const id = await insert("acme", "product", { name, category, unit_price, unit_cost, units_in_stock, reorder_level, discontinued: false });
  productIds.push({ id, price: unit_price, name });
}

const employees: [string, string, string, string, number][] = [
  ["Nancy", "Davolio", "Sales Representative", "2019-05-01", 62000],
  ["Andrew", "Fuller", "Vice President, Sales", "2018-08-14", 120000],
  ["Janet", "Leverling", "Sales Representative", "2020-04-01", 60000],
  ["Margaret", "Peacock", "Sales Representative", "2021-05-03", 58000],
  ["Steven", "Buchanan", "Sales Manager", "2019-10-17", 85000],
  ["Michael", "Suyama", "Sales Representative", "2022-10-17", 55000],
];
const employeeIds: string[] = [];
for (const [first_name, last_name, title, hire_date, salary] of employees) {
  employeeIds.push(await insert("acme", "employee", { first_name, last_name, title, hire_date, salary }));
}

const customers: [string, string, string, string, string, number][] = [
  ["ALFKI", "Alfreds Futterkiste", "Maria Anders", "Germany", "Berlin", 5000],
  ["ANATR", "Ana Trujillo Emparedados", "Ana Trujillo", "Mexico", "México D.F.", 2000],
  ["AROUT", "Around the Horn", "Thomas Hardy", "UK", "London", 8000],
  ["BERGS", "Berglunds snabbköp", "Christina Berglund", "Sweden", "Luleå", 10000],
  ["BONAP", "Bon app'", "Laurence Lebihan", "France", "Marseille", 6000],
  ["ERNSH", "Ernst Handel", "Roland Mendel", "Austria", "Graz", 20000],
  ["QUICK", "QUICK-Stop", "Horst Kloss", "Germany", "Cunewalde", 15000],
  ["SAVEA", "Save-a-lot Markets", "Jose Pavarotti", "USA", "Boise", 25000],
];
const customerIds: string[] = [];
for (const [code, company_name, contact_name, country, city, credit_limit] of customers) {
  customerIds.push(await insert("acme", "customer", { code, company_name, contact_name, country, city, credit_limit }));
}

// ~200 orders over the last 120 days, relative to today so "last month" always has data.
const day = (offset: number) => new Date(Date.now() - offset * 86400_000).toLocaleDateString("sv-SE");
let orders = 0, lines = 0;
for (let i = 0; i < 200; i++) {
  const age = Math.floor(rand() * 120) + 1;
  const employee = rand() < 0.2 ? employeeIds[3] : pick(employeeIds); // Margaret sells a bit more
  const orderLines = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
    const p = employee === employeeIds[3] && rand() < 0.5 ? productIds[0] : pick(productIds); // ...especially Chai
    const quantity = 1 + Math.floor(rand() * 30);
    return { product_id: p.id, quantity, unit_price: p.price, line_total: Math.round(quantity * p.price * 100) / 100 };
  });
  const total = Math.round(orderLines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  const orderId = await insert("acme", "order", {
    customer_id: pick(customerIds), employee_id: employee, order_date: day(age),
    status: age > 7 ? "shipped" : "placed", total,
  });
  for (const l of orderLines) await insert("acme", "order_line", { order_id: orderId, ...l });
  orders++; lines += orderLines.length;
}

// ---- Globex: different schema, different data -----------------------------------------------
for (const [company_name, prefecture] of [["Kanto Seiki", "Saitama"], ["Naniwa Robotics", "Osaka"]]) {
  await insert("globex", "customer", { company_name, prefecture });
}
for (const [sku, name, unit_price_jpy, units_in_stock] of [["HB-M8", "Hex bolt M8", 12, 50000], ["BR-6204", "Ball bearing 6204", 380, 1200]] as const) {
  await insert("globex", "part", { sku, name, unit_price_jpy, units_in_stock });
}

await db.end();
console.log(`seeded acme: ${products.length} products, ${employees.length} employees, ${customers.length} customers, ${orders} orders, ${lines} lines; globex: 2 customers, 2 parts`);
console.log("tokens:", principals.map(([t, , k, r]) => `${t} (${k}/${r})`).join(", "));
