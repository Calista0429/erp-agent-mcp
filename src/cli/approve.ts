// Human-in-the-loop console. The approver authenticates with their own (human) token.
//   ERP_TOKEN=acme-admin npm run approve -- list
//   ERP_TOKEN=acme-admin npm run approve -- show <action_id>
//   ERP_TOKEN=acme-admin npm run approve -- approve <action_id>
//   ERP_TOKEN=acme-admin npm run approve -- reject <action_id>
//   ERP_TOKEN=acme-admin npm run approve -- audit [n]
import { pool, resolvePrincipal, withTenant } from "../db.ts";
import { audit } from "../runtime/audit.ts";
import { decide } from "../runtime/execute.ts";
import type { Plan } from "../runtime/plan.ts";

const [cmd = "list", arg] = process.argv.slice(2);
if (["show", "approve", "reject"].includes(cmd) && !/^[0-9a-f-]{36}$/.test(arg ?? "")) {
  console.error(`usage: approve -- ${cmd} <action_id>`);
  process.exit(2);
}
const principal = await resolvePrincipal(process.env.ERP_TOKEN ?? "");
const ws = principal.workspace_id;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const color = (c: number) => (s: string) => `\x1b[${c}m${s}\x1b[0m`;
const [green, yellow, red] = [color(32), color(33), color(31)];

function printPlan(plan: Plan) {
  for (const op of plan.ops) {
    if (op.kind === "create") {
      console.log(green(`  + create ${op.model} ${dim(op.id)}`));
      for (const [k, v] of Object.entries(op.data)) console.log(green(`      ${k}: ${JSON.stringify(v)}`));
    } else {
      console.log(yellow(`  ~ update ${op.model} ${dim(`${op.id} @v${op.baseVersion}`)}`));
      for (const [k, v] of Object.entries(op.patch)) console.log(yellow(`      ${k}: ${JSON.stringify(op.before[k])} -> ${JSON.stringify(v)}`));
    }
  }
  for (const w of plan.warnings) console.log(yellow(`  ! ${w}`));
  for (const e of plan.errors) console.log(red(`  x ${e}`));
}

await withTenant(ws, async (tx) => {
  switch (cmd) {
    case "list": {
      const res = await tx.query(
        `select a.id, a.tool, a.status, a.created_at, p.name as requester
         from pending_actions a join workspace_principals() p on p.id = a.requested_by
         order by a.created_at desc limit 20`,
      );
      if (!res.rows.length) console.log("no actions");
      for (const a of res.rows) {
        const s = a.status === "pending" ? yellow(a.status) : a.status === "applied" ? green(a.status) : a.status === "blocked" || a.status === "failed" ? red(a.status) : a.status;
        console.log(`${a.id}  ${s.padEnd(18)} ${a.tool.padEnd(16)} ${a.requester.padEnd(16)} ${dim(new Date(a.created_at).toLocaleString())}`);
      }
      break;
    }
    case "show": {
      const { rows } = await tx.query("select * from pending_actions where id = $1", [arg]);
      if (!rows[0]) throw new Error("not found");
      const a = rows[0];
      console.log(`${a.tool}  status=${a.status}  schema=${a.schema_hash}  expires=${new Date(a.expires_at).toLocaleTimeString()}`);
      console.log(dim(`  args: ${JSON.stringify(a.args)}`));
      printPlan(a.plan);
      if (a.result) console.log(dim(`  result: ${JSON.stringify(a.result)}`));
      break;
    }
    case "approve":
    case "reject": {
      const r = await decide(tx, principal, arg, cmd);
      console.log(r.status === "applied" ? green(`applied: ${JSON.stringify(r)}`) : "error" in r ? red(`${r.status}: ${r.error}`) : r.status);
      break;
    }
    case "audit": {
      const { rows } = await tx.query(
        `select l.created_at, p.name, l.tool, l.outcome, l.detail, l.duration_ms
         from audit_log l join workspace_principals() p on p.id = l.principal_id order by l.id desc limit $1`,
        [Number(arg ?? 20)],
      );
      for (const r of rows.reverse()) {
        const o = r.outcome === "denied" || r.outcome === "error" ? red(r.outcome) : r.outcome === "planned" ? yellow(r.outcome) : green(r.outcome);
        console.log(`${dim(new Date(r.created_at).toLocaleTimeString())} ${r.name.padEnd(18)} ${r.tool.padEnd(22)} ${o.padEnd(16)} ${dim(JSON.stringify(r.detail))} ${dim(`${r.duration_ms ?? "-"}ms`)}`);
      }
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}).catch(async (e) => {
  // The failed transaction rolled back, so record refused decisions in a fresh one.
  if (cmd === "approve" || cmd === "reject") {
    await withTenant(ws, (tx) => audit(tx, principal, `${cmd}_action`, { action_id: arg }, "denied", { error: e.message }));
  }
  console.error(red(`error: ${e.message}`));
  process.exitCode = 1;
});
await pool.end();
