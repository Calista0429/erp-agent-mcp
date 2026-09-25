import { z } from "zod";
import { defineCommand } from "#erp";

// Business logic as code. The agent supplies intent (who, what, how many); prices, totals and
// stock movements are computed here, so a model cannot invent a discount or skip a stock check.
export default defineCommand({
  name: "place_order",
  description: "Place a sales order: checks stock, prices lines from the product master, reserves stock.",
  roles: ["sales", "admin"],
  input: {
    customer_id: z.uuid(),
    employee_id: z.uuid().describe("Sales rep responsible"),
    lines: z.array(z.object({ product_id: z.uuid(), quantity: z.number().int().positive() })).min(1).max(20),
    required_date: z.iso.date().optional(),
  },
  async plan(input, ctx) {
    const customer = await ctx.get("customer", input.customer_id);
    if (!customer) ctx.error(`customer ${input.customer_id} not found`);
    if (!(await ctx.get("employee", input.employee_id))) ctx.error(`employee ${input.employee_id} not found`);

    // Merge duplicate product lines so the stock check sees the real total.
    const qty = new Map<string, number>();
    for (const l of input.lines) qty.set(l.product_id, (qty.get(l.product_id) ?? 0) + l.quantity);

    const lines: { product_id: string; quantity: number; unit_price: number; line_total: number }[] = [];
    for (const [productId, quantity] of qty) {
      const p = await ctx.get("product", productId);
      if (!p) { ctx.error(`product ${productId} not found`); continue; }
      const { name, unit_price, units_in_stock, reorder_level, discontinued } = p.data;
      if (discontinued) { ctx.error(`${name} is discontinued`); continue; }
      if (quantity > units_in_stock) {
        ctx.error(`insufficient stock for ${name}: requested ${quantity}, in stock ${units_in_stock}`);
        continue;
      }
      const remaining = units_in_stock - quantity;
      if (remaining < reorder_level) ctx.warn(`${name} will drop to ${remaining}, below reorder level ${reorder_level}`);
      ctx.update("product", p, { units_in_stock: remaining });
      lines.push({ product_id: productId, quantity, unit_price, line_total: round2(quantity * unit_price) });
    }

    const total = round2(lines.reduce((s, l) => s + l.line_total, 0));
    if (customer?.data.credit_limit != null && total > customer.data.credit_limit) {
      ctx.warn(`order total ${total} exceeds ${customer.data.company_name}'s credit limit ${customer.data.credit_limit}`);
    }

    const orderId = ctx.create("order", {
      customer_id: input.customer_id,
      employee_id: input.employee_id,
      order_date: new Date().toLocaleDateString("sv-SE"), // YYYY-MM-DD, local time
      ...(input.required_date && { required_date: input.required_date }),
      status: "placed",
      total,
    });
    for (const l of lines) ctx.create("order_line", { order_id: orderId, ...l });
  },
});

const round2 = (n: number) => Math.round(n * 100) / 100;
