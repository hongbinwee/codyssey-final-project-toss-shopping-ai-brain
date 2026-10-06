// 내부 상태 시뮬레이터 — UI/Agent Tool에 노출하지 않는 운영용 전환.
// 사용: node scripts/simulate.ts --order=ord-a-pre --event=ship|deliver|cancel|refund
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { deliverOrder, shipOrder } from "../src/orders.ts";
import { completeCancellation, completeRefund } from "../src/cancellation.ts";
import type { ToolResult } from "../src/contracts.ts";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(k + "="))?.split("=")[1];

const order = arg("--order");
const event = arg("--event");
const EVENTS: Record<string, (id: string) => Promise<ToolResult<unknown>>> = {
  ship: shipOrder,
  deliver: deliverOrder,
  cancel: completeCancellation,
  refund: completeRefund,
};
const run = event ? EVENTS[event] : undefined;
if (!order || !run) {
  console.log("usage: node scripts/simulate.ts --order=<order_id> --event=ship|deliver|cancel|refund");
  await sql.end();
  process.exit(1);
}

const r = await run(order);
console.log(r.ok ? JSON.stringify(r.data) : "failed: " + JSON.stringify(r.error));
await sql.end();
process.exit(r.ok ? 0 : 1);
