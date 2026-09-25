import { defineModel, f } from "#erp";

export default defineModel({
  name: "part",
  description: "Machine parts catalogue.",
  fields: {
    sku: f.string(),
    name: f.string(),
    unit_price_jpy: f.integer(),
    units_in_stock: f.integer(),
  },
  access: { read: ["admin", "sales", "viewer"], write: ["admin"] },
});
