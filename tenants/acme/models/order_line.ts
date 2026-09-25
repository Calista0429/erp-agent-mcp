import { defineModel, f } from "#erp";

export default defineModel({
  name: "order_line",
  description: "One product line of an order. Revenue = line_total.",
  fields: {
    order_id: f.ref("order"),
    product_id: f.ref("product"),
    quantity: f.integer(),
    unit_price: f.number().describe("Price at order time (copied from product)"),
    line_total: f.number().describe("quantity * unit_price (USD)"),
  },
  access: { read: ["admin", "sales", "viewer"] },
});
