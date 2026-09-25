import { defineModel, f } from "#erp";

export default defineModel({
  name: "employee",
  description: "Sales staff and managers.",
  fields: {
    first_name: f.string(),
    last_name: f.string(),
    title: f.string(),
    hire_date: f.date(),
    salary: f.number().describe("Annual salary (USD)").readableBy("admin"),
  },
  access: { read: ["admin", "sales", "viewer"], write: ["admin"] },
});
