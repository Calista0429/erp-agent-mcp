import { defineModel, f } from "#erp";

// A different tenant with a different schema: industrial parts, no food products at all.
export default defineModel({
  name: "customer",
  description: "B2B buyers of machine parts.",
  fields: {
    company_name: f.string(),
    prefecture: f.string(),
  },
  access: { read: ["admin", "sales", "viewer"], write: ["admin", "sales"] },
});
