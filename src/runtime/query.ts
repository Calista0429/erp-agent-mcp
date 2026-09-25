// Read path: typed, permission-aware queries over JSONB records.
// Agents never send SQL. They send paths that were whitelisted from the schema for their
// role; values always travel as bind parameters.
import { z } from "zod";
import type { ModelDef, Role } from "../schema/dsl.ts";
import { maskData, readablePaths, type PathInfo, type Registry } from "../schema/registry.ts";
import type { Tx } from "../db.ts";

export const conditionSchema = z
  .object({
    eq: z.union([z.string(), z.number(), z.boolean()]),
    ne: z.union([z.string(), z.number(), z.boolean()]),
    gt: z.union([z.string(), z.number()]),
    gte: z.union([z.string(), z.number()]),
    lt: z.union([z.string(), z.number()]),
    lte: z.union([z.string(), z.number()]),
    in: z.array(z.union([z.string(), z.number()])).max(200),
    contains: z.string().describe("case-insensitive substring match (string fields)"),
  })
  .partial();
export type Condition = z.infer<typeof conditionSchema>;
export type Filter = Record<string, Condition>;

const OPS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const METRIC_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type Metric = { fn: (typeof METRIC_FNS)[number]; field?: string };

class SqlBuilder {
  params: unknown[] = [];
  joins = new Map<string, string>();
  constructor(private paths: Map<string, PathInfo>) {}

  param(v: unknown, cast = "") {
    this.params.push(v);
    return `$${this.params.length}${cast}`;
  }

  path(p: string): PathInfo {
    const info = this.paths.get(p);
    // Unknown or hidden paths are indistinguishable to the caller: no schema oracle.
    if (!info) throw new PermissionError(`unknown or inaccessible field '${p}'`);
    if (info.via && !this.joins.has(info.via.refField)) {
      const a = `j_${info.via.refField}`;
      this.joins.set(
        info.via.refField,
        `left join records ${a} on ${a}.workspace_id = r.workspace_id and ${a}.model = ${this.param(info.via.model)}` +
          ` and ${a}.id = (r.data->>'${info.via.refField}')::uuid`,
      );
    }
    return info;
  }

  expr(p: string): string {
    const info = this.path(p);
    const alias = info.via ? `j_${info.via.refField}` : "r";
    if (info.field === "id") return `${alias}.id::text`;
    const raw = `(${alias}.data->>'${info.field}')`; // field names are validated identifiers
    return `${raw}${castFor(info)}`;
  }

  where(filter: Filter | undefined): string[] {
    const clauses: string[] = [];
    for (const [p, cond] of Object.entries(filter ?? {})) {
      const e = this.expr(p);
      const cast = castFor(this.path(p));
      for (const [op, value] of Object.entries(cond)) {
        if (value === undefined) continue;
        if (op in OPS) clauses.push(`${e} ${OPS[op]} ${this.param(value, cast)}`);
        else if (op === "in") clauses.push(`${e} = any(${this.param(value, `${cast || "::text"}[]`)})`);
        else if (op === "contains") clauses.push(`${e}::text ilike ${this.param(`%${value}%`)}`);
      }
    }
    return clauses;
  }
}

function castFor(info: PathInfo) {
  switch (info.type) {
    case "number":
    case "integer": return "::numeric";
    case "date": return "::date";
    case "boolean": return "::boolean";
    default: return "";
  }
}

export class PermissionError extends Error {}

function builderFor(reg: Registry, m: ModelDef, role: Role) {
  return new SqlBuilder(new Map(readablePaths(reg, m, role).map((p) => [p.path, p])));
}

const num = (v: unknown) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

export async function listRecords(
  tx: Tx, reg: Registry, m: ModelDef, role: Role,
  opts: { filter?: Filter; sort?: { field: string; dir?: "asc" | "desc" }; limit?: number; offset?: number },
) {
  const b = builderFor(reg, m, role);
  const where = [`r.model = ${b.param(m.name)}`, ...b.where(opts.filter)];
  const order = opts.sort ? `${b.expr(opts.sort.field)} ${opts.sort.dir === "desc" ? "desc" : "asc"} nulls last, r.id` : "r.created_at, r.id";
  const limit = b.param(Math.min(opts.limit ?? 20, 100));
  const offset = b.param(opts.offset ?? 0);
  const sql = `select r.id, r.version, r.data, count(*) over() as total from records r ${[...b.joins.values()].join(" ")}
               where ${where.join(" and ")} order by ${order} limit ${limit} offset ${offset}`;
  const { rows } = await tx.query(sql, b.params);
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    records: rows.map((r) => ({ id: r.id, version: r.version, ...maskData(m, r.data, role) })),
  };
}

export async function getRecord(tx: Tx, m: ModelDef, role: Role, id: string) {
  const { rows } = await tx.query("select id, version, data from records where model = $1 and id = $2", [m.name, id]);
  if (!rows[0]) return null;
  return { id: rows[0].id, version: rows[0].version, ...maskData(m, rows[0].data, role) };
}

export async function aggregateRecords(
  tx: Tx, reg: Registry, m: ModelDef, role: Role,
  opts: { groupBy?: string[]; metrics: Metric[]; filter?: Filter; limit?: number },
) {
  const b = builderFor(reg, m, role);
  const groups = (opts.groupBy ?? []).map((p) => b.expr(p));
  const metrics = opts.metrics.map((mt) => {
    if (mt.fn === "count") return mt.field ? `count(${b.expr(mt.field)})` : "count(*)";
    if (!mt.field) throw new Error(`${mt.fn} needs a field`);
    const info = b.path(mt.field);
    if (!["number", "integer"].includes(info.type) && mt.fn !== "min" && mt.fn !== "max") {
      throw new Error(`${mt.fn} requires a numeric field, '${mt.field}' is ${info.type}`);
    }
    return `${mt.fn}(${b.expr(mt.field)})`;
  });
  const where = [`r.model = ${b.param(m.name)}`, ...b.where(opts.filter)];
  const select = [...groups.map((g, i) => `${g} as g${i}`), ...metrics.map((e, i) => `${e} as m${i}`)];
  const sql = `select ${select.join(", ")} from records r ${[...b.joins.values()].join(" ")}
               where ${where.join(" and ")} ${groups.length ? `group by ${groups.map((_, i) => i + 1).join(", ")}` : ""}
               order by m0 desc nulls last limit ${b.param(Math.min(opts.limit ?? 50, 200))}`;
  const { rows } = await tx.query(sql, b.params);
  const labels = opts.metrics.map((mt) => (mt.field ? `${mt.fn}(${mt.field})` : "count"));
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    (opts.groupBy ?? []).forEach((p, i) => (out[p] = row[`g${i}`]));
    labels.forEach((l, i) => (out[l] = num(row[`m${i}`])));
    return out;
  });
}
