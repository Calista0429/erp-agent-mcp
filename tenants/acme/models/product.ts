import { defineModel, f } from "#erp";

export default defineModel({
  name: "product",
  description: "Items we sell. Stock is changed only by commands such as place_order.",
  fields: {
    name: f.string(),
    category: f.enum("Beverages", "Condiments", "Confections", "Dairy Products", "Grains/Cereals", "Meat/Poultry", "Produce", "Seafood"),
    unit_price: f.number().describe("List price per unit (USD)"),
    // Field-level permission: margin data is invisible to sales and viewer agents.
    unit_cost: f.number().describe("Purchase cost per unit (USD)").readableBy("admin"),
    units_in_stock: f.integer(),
    reorder_level: f.integer().describe("Warn when stock falls below this"),
    discontinued: f.boolean(),
  },
  access: { read: ["admin", "sales", "viewer"], write: ["admin"] },
});
