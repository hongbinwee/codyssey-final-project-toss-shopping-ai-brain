// Phase 4 경합: 취소 접수와 출고는 같은 주문 잠금으로 직렬화 — 동시 성공은 없다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { addToCart, getCart } from "../../src/cart.ts";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import { shipOrder } from "../../src/orders.ts";
import {
  approveCancel, getCancelQuote, requestCancelOrder,
} from "../../src/cancellation.ts";
import { sql } from "../../src/db.ts";

const C_UI = { actorUserId: "u-c", origin: "UI" as const };

const vver = async (id: string) =>
  (await sql.unsafe<{ version: number }[]>(
    "SELECT version FROM product_variants WHERE id=$1", [id]))[0].version;

async function createOrder(variantId = "v-a-24") {
  const c = await getCart(C_UI);
  const add = await addToCart(
    { variant_id: variantId, quantity: 1, expected_cart_version: c.ok ? c.data.version : 0, expected_variant_version: await vver(variantId) },
    C_UI, "race-add-" + crypto.randomUUID().slice(0, 8),
  );
  assert.ok(add.ok, JSON.stringify(add));
  const q = await checkoutQuote(C_UI);
  assert.ok(q.ok);
  const co = await confirmCheckout(q.data.quote_token, C_UI, "race-co-" + crypto.randomUUID().slice(0, 8));
  assert.ok(co.ok);
  return co.data.order_id;
}

async function approveFor(orderId: string, key: string) {
  const q = await getCancelQuote(C_UI, orderId, "OTHER");
  assert.ok(q.ok && q.data.quote);
  const ap = await approveCancel(C_UI, orderId, {
    quote_token: q.data.quote.quote_token, reason_code: "OTHER", action_key: key,
  });
  assert.ok(ap.ok, JSON.stringify(ap));
  return ap.data.confirmation_id;
}

describe("phase4 cancel race", () => {
  before(async () => {
    await ensureTestDb(4);
    await cleanUserData();
  });

  test("cancel_ship_race: 취소 접수와 출고는 한쪽만 성공한다", async () => {
    const orderId = await createOrder();
    const cid = await approveFor(orderId, "race-ap-1");
    const [cx, sh] = await Promise.all([
      requestCancelOrder(C_UI, { confirmation_id: cid }),
      shipOrder(orderId),
    ]);
    const [ship] = await sql.unsafe<{ status: string }[]>(
      "SELECT status FROM shipments WHERE order_id=$1", [orderId]);
    const [cxl] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM cancel_requests WHERE order_id=$1", [orderId]);
    if (cx.ok) {
      // 취소가 먼저 접수 → 출고 차단
      assert.ok(!sh.ok, "취소 접수 후 출고가 성공하면 안 됨");
      assert.equal(cxl.c, 1);
      assert.equal(ship.status, "PREPARING");
    } else {
      // 출고가 먼저 커밋 → 취소 거절 (승인 무효화)
      assert.ok(sh.ok, "출고 성공했는데 실패로 돌아옴: " + JSON.stringify(sh));
      assert.equal(cx.error.code, "CANCEL_NOT_ELIGIBLE");
      assert.equal(cxl.c, 0);
      assert.equal(ship.status, "IN_TRANSIT");
      // 승인은 REJECTED로 확정 — 재사용 불가
      const [ar] = await sql.unsafe<{ status: string; error_code: string }[]>(
        "SELECT status, error_code FROM action_requests WHERE id=$1", [cid]);
      assert.equal(ar.status, "REJECTED");
    }
  });

  test("concurrent_double_execute: 같은 주문의 동시 취소 실행은 1건만 접수", async () => {
    const orderId = await createOrder("v-c-27");
    const c1 = await approveFor(orderId, "race-ap-2a");
    const c2 = await approveFor(orderId, "race-ap-2b");
    const [r1, r2] = await Promise.all([
      requestCancelOrder(C_UI, { confirmation_id: c1 }),
      requestCancelOrder(C_UI, { confirmation_id: c2 }),
    ]);
    const wins = [r1, r2].filter((r) => r.ok).length;
    assert.equal(wins, 1, "정확히 하나만 접수돼야 한다");
    const loser = [r1, r2].find((r) => !r.ok)!;
    // 승자가 주문 version을 올려 커밋하므로 패자는 승인 시점 버전과 달라 CONFIRMATION_STALE로 확정 거절된다.
    assert.equal(loser.error.code, "CONFIRMATION_STALE", "패자 코드: " + loser.error.code);
    const [cxl] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM cancel_requests WHERE order_id=$1", [orderId]);
    assert.equal(cxl.c, 1); // 주문당 취소 요청 1건 — unique 제약이 지킨다
  });

  test("cancel_retry_once: 접수 후 같은 승인 재실행은 최초 결과를 복원", async () => {
    const orderId = await createOrder("v-b-27");
    const cid = await approveFor(orderId, "race-ap-3");
    const e1 = await requestCancelOrder(C_UI, { confirmation_id: cid });
    assert.ok(e1.ok);
    const e2 = await requestCancelOrder(C_UI, { confirmation_id: cid });
    assert.ok(e2.ok && e2.replayed === true);
    assert.equal(e2.data.cancel_request_id, e1.data.cancel_request_id);
    const [cxl] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM cancel_requests WHERE order_id=$1", [orderId]);
    assert.equal(cxl.c, 1);
  });
});

// sql 풀 연결을 닫아야 서브프로세스가 종료한다.
// setup이 실패해 connectDb가 안 됐을 때는 닫을 pool이 없다 — ?.로 방어한다.
after(() => sql?.end());
