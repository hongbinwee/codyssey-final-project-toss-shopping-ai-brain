// 내부 배송 시뮬레이터 — UI/Agent Tool에 노출하지 않는 운영용 전환.
// 사용: node scripts/simulate.ts --order=ord-a-pre --event=ship|deliver
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { deliverOrder, shipOrder } from "../src/orders.ts";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(k + "="))?.split("=")[1];

const order = arg("--order");
const event = arg("--event");
if (!order || (event !== "ship" && event !== "deliver")) {
  console.log("usage: node scripts/simulate.ts --order=<order_id> --event=ship|deliver");
  await sql.end();
  process.exit(1);
}

const r = event === "ship" ? await shipOrder(order) : await deliverOrder(order);
console.log(r.ok ? JSON.stringify(r.data) : "failed: " + JSON.stringify(r.error));
await sql.end();
process.exit(r.ok ? 0 : 1);
