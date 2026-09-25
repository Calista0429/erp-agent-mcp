// Schema-as-code DSL. Tenant models live in tenants/<workspace>/models/*.ts and
// commands in tenants/<workspace>/commands/*.ts. Both humans and coding agents edit
// these files; the MCP runtime hot-reloads them and regenerates the agent's tools.
import type { z } from "zod";

export type Role = string;

export type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "enum" | "ref";

export interface FieldDef {
  type: FieldType;
  required: boolean;
  description?: string;
  values?: readonly string[]; // enum
  model?: string; // ref target
  readRoles?: Role[]; // undefined = anyone who can read the model
  writeRoles?: Role[]; // undefined = anyone who can write the model
}

export class Field {
  constructor(readonly def: FieldDef) {}
  private with(patch: Partial<FieldDef>) {
    return new Field({ ...this.def, ...patch });
  }
  optional() { return this.with({ required: false }); }
  describe(description: string) { return this.with({ description }); }
  /** Field-level read permission. Hidden fields cannot be returned, filtered or grouped on. */
  readableBy(...roles: Role[]) { return this.with({ readRoles: roles }); }
  writableBy(...roles: Role[]) { return this.with({ writeRoles: roles }); }
}

export const f = {
  string: () => new Field({ type: "string", required: true }),
  number: () => new Field({ type: "number", required: true }),
  integer: () => new Field({ type: "integer", required: true }),
  boolean: () => new Field({ type: "boolean", required: true }),
  /** ISO date, YYYY-MM-DD */
  date: () => new Field({ type: "date", required: true }),
  enum: (...values: string[]) => new Field({ type: "enum", required: true, values }),
  ref: (model: string) => new Field({ type: "ref", required: true, model }),
};

export interface ModelDef {
  name: string; // snake_case, becomes the tool prefix: order_line_list, order_line_get...
  description: string;
  fields: Record<string, Field>;
  access: {
    read: Role[];
    /** Roles allowed to plan generic create/update. Omit to allow writes only via commands. */
    write?: Role[];
  };
  /** Human roles allowed to approve plans that touch this model. Default: ['admin']. */
  approvers?: Role[];
}

export function defineModel(def: ModelDef): ModelDef {
  return def;
}

// ---- Commands: domain operations (the "business logic as code" part) -------------------

export interface RecordRow {
  id: string;
  version: number;
  data: Record<string, any>;
}

export interface PlanContext {
  readonly principal: { name: string; role: Role; kind: "human" | "agent" };
  /** Reads run with full visibility inside the tenant: commands are trusted code. */
  get(model: string, id: string): Promise<RecordRow | null>;
  findOne(model: string, where: Record<string, unknown>): Promise<RecordRow | null>;
  /** Stages a create. Returns the id the record will have, so later ops can reference it. */
  create(model: string, data: Record<string, unknown>): string;
  /** Stages a patch against the record as read now; applying fails if it changed meanwhile. */
  update(model: string, row: RecordRow, patch: Record<string, unknown>): void;
  warn(message: string): void;
  /** Any error blocks the plan: it is recorded but can never be approved. */
  error(message: string): void;
}

export interface CommandDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  roles: Role[]; // who may request this command
  input: S;
  plan(input: z.infer<z.ZodObject<S>>, ctx: PlanContext): Promise<void>;
}

export function defineCommand<S extends z.ZodRawShape>(def: CommandDef<S>): CommandDef<S> {
  return def;
}
