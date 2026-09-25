import { defineModel, f } from "#erp";

export default defineModel({
  name: "order",
  description: "Sales order header. Created only via the place_order command.",
  fields: {
    customer_id: f.ref("customer"),
    employee_id: f.ref("employee").describe("Sales rep responsible for the order"),
    order_date: f.date(),
    required_date: f.date().optional(),
    status: f.enum("placed", "shipped", "cancelled"),
    total: f.number().describe("Sum of line totals (USD)"),
  },
  access: { read: ["admin", "sales", "viewer"], write: ["admin"] },
});
