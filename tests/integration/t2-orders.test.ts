// T2 주문/배송 조회 — 소유권 스코프·정보 없음 구분·내부 배송 전환 검증.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { deliverOrder, getOrder, getShippingStatus, listOrders, shipOrder } from "../../src/orders.ts";
import { addToCart, getCart } from "../../src/cart.ts";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import { sql } from "../../src/db.ts";

const A = { actorUserId: "u-a", origin: "AGENT" as const };
const B = { actorUserId: "u-b", origin: "AGENT" as const };

describe("t2 orders/shipping", () => {
  before(async () => {
    await ensureTestDb(3);
    await cleanUserData();
  });

  test("orders_are_owner_scoped: u-a는 u-b 주문을 보지 못한다", async () => {
    const la = await listOrders(A);
    assert.ok(la.ok);
    const idsA = la.data.orders.map((o) => o.id);
    assert.ok(idsA.includes("ord-a-pre") && idsA.includes("ord-a-ship") && idsA.includes("ord-a-done"));
    assert.ok(!idsA.includes("ord-b-none"), "타인 주문이 목록에 없어야 한다");

    const lb = await listOrders(B);
    assert.ok(lb.ok);
    assert.deepEqual(lb.data.orders.map((o) => o.id), ["ord-b-none"]);

    for (const fn of [getOrder, getShippingStatus]) {
      const r = await fn(A, "ord-b-none");
      assert.ok(!r.ok && r.error.code === "NOT_FOUND", "타인 주문은 NOT_FOUND");
    }
  });

  test("missing_shipping_is_not_delay: 배송 레코드 없음은 NO_INFORMATION", async () => {
    const r = await getShippingStatus(B, "ord-b-none");
    assert.ok(r.ok);
    assert.equal(r.data.information, "NO_INFORMATION");
    assert.equal(r.data.status, null);
    assert.equal(r.data.events.length, 0);
    assert.equal(r.data.estimated_arrival_at, null);
  });

  test("order detail: 스냅샷·결제·배송 이력이 함께 온다", async () => {
    const r = await getOrder(A, "ord-a-ship");
    assert.ok(r.ok);
    const o = r.data;
    assert.equal(o.status, "CONFIRMED");
    assert.equal(o.items[0].product_name, "코드뷰 모니터 B");
    assert.equal(o.items[0].unit_price_won, 149000);
    assert.equal(o.total_won, 152000);
    assert.equal(o.payment?.status, "PAID");
    assert.equal(o.payment?.refund_status, "NONE");
    assert.equal(o.shipping?.status, "IN_TRANSIT");
    assert.equal(o.shipping?.events.length, 2);
    assert.equal(o.cancel_request, null);
    // 목록 요약도 같은 상태를 보여야 한다
    const l = await listOrders(A);
    const row = l.ok ? l.data.orders.find((x) => x.id === "ord-a-ship") : undefined;
    assert.equal(row?.shipping_status, "IN_TRANSIT");
    assert.equal(row?.item_summary.includes("코드뷰 모니터 B"), true);
  });

  test("checkout으로 만든 주문도 같은 조회 경로로 보인다", async () => {
    const c = await getCart(A);
    assert.ok(c.ok);
    const [v] = await sql.unsafe<{ version: number }[]>(
      "SELECT version FROM product_variants WHERE id='v-b-24'");
    const add = await addToCart(
      { variant_id: "v-b-24", quantity: 1, expected_cart_version: c.data.version, expected_variant_version: v.version },
      A, "t2-add-1",
    );
    assert.ok(add.ok);
    const q = await checkoutQuote(A);
    assert.ok(q.ok);
    const co = await confirmCheckout(q.data.quote_token, A, "ui-t2-co");
    assert.ok(co.ok);

    const l = await listOrders(A);
    assert.ok(l.ok);
    const row = l.data.orders.find((o) => o.id === co.data.order_id);
    assert.ok(row, "생성 주문이 목록에 있어야 한다");
    assert.equal(row?.shipping_status, "PREPARING");
    const s = await getShippingStatus(A, co.data.order_id);
    assert.ok(s.ok && s.data.information === "AVAILABLE");
  });

  test("ship/deliver 전환 규칙 (내부 시뮬레이터)", async () => {
    const s = await shipOrder("ord-a-pre");
    assert.ok(s.ok && s.data.status === "IN_TRANSIT");
    const s2 = await shipOrder("ord-a-pre");
    assert.ok(!s2.ok && s2.error.code === "INVALID_STATE"); // 재출고 불가
    const d = await deliverOrder("ord-a-pre");
    assert.ok(d.ok && d.data.status === "DELIVERED");
    const d2 = await deliverOrder("ord-a-pre");
    assert.ok(!d2.ok && d2.error.code === "INVALID_STATE");
    // 배송 레코드 없는 주문은 출고 불가
    const ns = await shipOrder("ord-b-none");
    assert.ok(!ns.ok && ns.error.code === "INVALID_STATE");
    // 존재하지 않는 주문
    const nx = await shipOrder("ord-nope");
    assert.ok(!nx.ok && nx.error.code === "NOT_FOUND");
  });
});

// sql 풀 연결을 닫아야 서브프로세스가 종료하고 다음 파일로 진행된다.
after(() => sql.end());
