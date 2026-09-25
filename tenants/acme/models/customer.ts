import { defineModel, f } from "#erp";

export default defineModel({
  name: "customer",
  description: "Companies that buy from us.",
  fields: {
    code: f.string().describe("Short customer code, e.g. ALFKI"),
    company_name: f.string(),
    contact_name: f.string().optional(),
    country: f.string(),
    city: f.string().optional(),
    credit_limit: f.number().optional().describe("Max open order amount (USD)").readableBy("admin", "sales").writableBy("admin"),
  },
  access: { read: ["admin", "sales", "viewer"], write: ["admin", "sales"] },
});
