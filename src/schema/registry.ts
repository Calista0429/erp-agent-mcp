import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { CommandDef, FieldDef, FieldType, ModelDef, Role } from "./dsl.ts";

const IDENT = /^[a-z][a-z0-9_]*$/;
const RESERVED_FIELDS = new Set(["id", "version"]);
const GENERATED_SUFFIXES = ["_list", "_get", "_aggregate", "_create", "_update"];
const BUILTIN_TOOLS = new Set(["describe_schema", "get_action"]);

export interface Registry {
  workspace: string;
  hash: string;
  models: Map<string, ModelDef>;
  commands: Map<string, CommandDef>;
}

async function listTs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Loads and validates a tenant's schema. Throws on any inconsistency so that a broken edit
 * (e.g. a coding agent writing an invalid model) never replaces a working registry.
 */
export async function loadRegistry(tenantsDir: string, workspace: string): Promise<Registry> {
  const root = join(tenantsDir, workspace);
  const modelFiles = await listTs(join(root, "models"));
  const commandFiles = await listTs(join(root, "commands"));

  const h = createHash("sha256");
  for (const file of [...modelFiles, ...commandFiles]) {
    h.update(file.slice(root.length)).update("\0").update(await readFile(file)).update("\0");
  }
  const hash = h.digest("hex").slice(0, 12);

  // Cache-busting query string forces a fresh module evaluation after edits.
  const load = async (file: string) => {
    const mod = await import(pathToFileURL(file).href + `?v=${hash}`);
    if (!mod.default) throw new Error(`${file}: missing default export`);
    return mod.default;
  };

  const models = new Map<string, ModelDef>();
  for (const file of modelFiles) {
    const m: ModelDef = await load(file);
    if (!IDENT.test(m.name)) throw new Error(`${file}: invalid model name '${m.name}'`);
    if (models.has(m.name)) throw new Error(`${file}: duplicate model '${m.name}'`);
    for (const name of Object.keys(m.fields)) {
      if (!IDENT.test(name) || RESERVED_FIELDS.has(name)) throw new Error(`${m.name}: invalid field name '${name}'`);
    }
    models.set(m.name, m);
  }
  for (const m of models.values()) {
    for (const [name, field] of Object.entries(m.fields)) {
      if (field.def.type === "ref" && !models.has(field.def.model!)) {
        throw new Error(`${m.name}.${name}: ref to unknown model '${field.def.model}'`);
      }
    }
  }

  const commands = new Map<string, CommandDef>();
  for (const file of commandFiles) {
    const c: CommandDef = await load(file);
    if (!IDENT.test(c.name)) throw new Error(`${file}: invalid command name '${c.name}'`);
    const clashes = BUILTIN_TOOLS.has(c.name) ||
      [...models.keys()].some((m) => GENERATED_SUFFIXES.some((s) => c.name === m + s));
    if (clashes || commands.has(c.name)) throw new Error(`${file}: command name '${c.name}' collides with another tool`);
    commands.set(c.name, c);
  }

  return { workspace, hash, models, commands };
}

// ---- Permissions ---------------------------------------------------------------------------

export const canReadModel = (m: ModelDef, role: Role) => m.access.read.includes(role);
export const canWriteModel = (m: ModelDef, role: Role) => !!m.access.write?.includes(role);
export const canReadField = (f: FieldDef, role: Role) => !f.readRoles || f.readRoles.includes(role);
export const canWriteField = (f: FieldDef, role: Role) =>
  canReadField(f, role) && (!f.writeRoles || f.writeRoles.includes(role));
export const approversOf = (m: ModelDef) => m.approvers ?? ["admin"];

/** Strips every field the role may not read. */
export function maskData(m: ModelDef, data: Record<string, unknown>, role: Role) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const f = m.fields[k];
    if (f && canReadField(f.def, role)) out[k] = v;
  }
  return out;
}

// ---- Queryable paths -----------------------------------------------------------------------

/** A readable path: own field ('quantity') or one hop through a ref ('order_id.order_date'). */
export interface PathInfo {
  path: string;
  type: FieldType | "id";
  via?: { refField: string; model: string }; // set for one-hop paths
  field: string; // field name on the final model ('id' for the id pseudo-field)
}

export function readablePaths(reg: Registry, m: ModelDef, role: Role): PathInfo[] {
  const paths: PathInfo[] = [{ path: "id", type: "id", field: "id" }];
  for (const [name, field] of Object.entries(m.fields)) {
    if (!canReadField(field.def, role)) continue;
    paths.push({ path: name, type: field.def.type, field: name });
    if (field.def.type !== "ref") continue;
    const target = reg.models.get(field.def.model!)!;
    if (!canReadModel(target, role)) continue;
    for (const [tName, tField] of Object.entries(target.fields)) {
      if (!canReadField(tField.def, role)) continue;
      paths.push({ path: `${name}.${tName}`, type: tField.def.type, via: { refField: name, model: target.name }, field: tName });
    }
  }
  return paths;
}

// ---- Zod schemas for agent-facing tool inputs ------------------------------------------------

export function fieldZod(def: FieldDef): z.ZodType {
  let s: z.ZodType;
  switch (def.type) {
    case "string": s = z.string(); break;
    case "number": s = z.number(); break;
    case "integer": s = z.number().int(); break;
    case "boolean": s = z.boolean(); break;
    case "date": s = z.iso.date(); break;
    case "enum": s = z.enum(def.values as [string, ...string[]]); break;
    case "ref": s = z.uuid().describe(`id of a ${def.model} record`); break;
  }
  return def.description ? s.describe(def.description) : s;
}

/** Only fields the role can write appear; unknown keys are rejected (strict). */
export function writeSchema(m: ModelDef, role: Role, mode: "create" | "update") {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(m.fields)) {
    if (!canWriteField(field.def, role)) continue;
    const s = fieldZod(field.def);
    shape[name] = mode === "create" && field.def.required ? s : s.optional();
  }
  return z.strictObject(shape);
}
