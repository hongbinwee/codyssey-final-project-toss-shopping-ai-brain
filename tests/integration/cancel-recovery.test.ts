// Phase 4 복구·내부 처리: 승인 응답 유실 복구, 최종 취소/환불 시뮬레이터, 재고·환불 1회 보장.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { addToCart, getCart } from "../../src/cart.ts";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import { getOrder, shipOrder } from "../../src/orders.ts";
import { getActionResult } from "../../src/actions.ts";
import {
  approveCancel, checkCancelEligibility, completeCancellation,
  completeRefund, getCancelQuote, requestCancelOrder,
} from "../../src/cancellation.ts";
import { sql } from "../../src/db.ts";

const C_UI = { actorUserId: "u-c", origin: "UI" as const };

const vver = async (id: string) =>
  (await sql.unsafe<{ version: number }[]>(
    "SELECT version FROM product_variants WHERE id=$1", [id]))[0].version;
const stockOf = async (id: string) =>
  (await sql.unsafe<{ stock_qty: number }[]>(
    "SELECT stock_qty FROM product_variants WHERE id=$1", [id]))[0].stock_qty;

// checkout은 주문 시점에 재고를 차감한다 — 취소 처리가 정확히 1회 복원하는지 본다.
async function createOrder(variantId = "v-c-27") {
  const c = await getCart(C_UI);
  const add = await addToCart(
    { variant_id: variantId, quantity: 1, expected_cart_version: c.ok ? c.data.version : 0, expected_variant_version: await vver(variantId) },
    C_UI, "rec-add-" + crypto.randomUUID().slice(0, 8),
  );
  assert.ok(add.ok, JSON.stringify(add));
  const q = await checkoutQuote(C_UI);
  assert.ok(q.ok);
  const co = await confirmCheckout(q.data.quote_token, C_UI, "rec-co-" + crypto.randomUUID().slice(0, 8));
  assert.ok(co.ok);
  return co.data.order_id;
}

async function requestViaApproval(orderId: string, key: string) {
  const q = await getCancelQuote(C_UI, orderId, "OTHER");
  assert.ok(q.ok && q.data.quote);
  const ap = await approveCancel(C_UI, orderId, {
    quote_token: q.data.quote.quote_token, reason_code: "OTHER", action_key: key,
  });
  assert.ok(ap.ok, JSON.stringify(ap));
  return ap.data.confirmation_id;
}

describe("phase4 cancel recovery + internal transitions", () => {
  before(async () => {
    await ensureTestDb(4);
    await cleanUserData();
  });

  test("lost_approve_recovers: 승인 응답 유실은 kind+key로 복구해 실행한다", async () => {
    const orderId = await createOrder("v-c-27");
    const q = await getCancelQuote(C_UI, orderId, "ORDER_MISTAKE");
    assert.ok(q.ok && q.data.quote);
    // 승인이 서버에 저장됐지만 클라이언트가 confirmation_id를 못 받은 상황을 재현
    const ap = await approveCancel(C_UI, orderId, {
      quote_token: q.data.quote.quote_token, reason_code: "ORDER_MISTAKE", action_key: "rec-lost",
    });
    assert.ok(ap.ok);
    const found = await getActionResult(C_UI, { kind: "CANCEL_ORDER", idempotency_key: "rec-lost" });
    assert.ok(found.ok);
    assert.equal(found.data.status, "READY");
    // 복구한 operation_id = confirmation_id로 실행
    const ex = await requestCancelOrder(C_UI, { confirmation_id: found.data.operation_id });
    assert.ok(ex.ok && ex.data.status === "REQUESTED");
  });

  test("cancel_then_ship_blocked: 접수된 주문은 출고 불가", async () => {
    const orderId = await createOrder("v-b-24");
    const cid = await requestViaApproval(orderId, "rec-ship");
    const ex = await requestCancelOrder(C_UI, { confirmation_id: cid });
    assert.ok(ex.ok);
    const sh = await shipOrder(orderId);
    assert.ok(!sh.ok && sh.error.code === "INVALID_STATE");
  });

  test("complete_cancellation: 주문/배송 CANCELLED·취소 COMPLETED·재고 1회 복원·환불 PENDING", async () => {
    const before = await stockOf("v-c-32");
    const orderId = await createOrder("v-c-32");
    assert.equal(await stockOf("v-c-32"), before - 1);
    const cid = await requestViaApproval(orderId, "rec-full");
    const ex = await requestCancelOrder(C_UI, { confirmation_id: cid });
    assert.ok(ex.ok);
    assert.equal(ex.data.order?.status, "CONFIRMED"); // 접수만으로 취소 아님

    const c1 = await completeCancellation(orderId);
    assert.ok(c1.ok && c1.data.status === "COMPLETED");
    const o = await getOrder(C_UI, orderId);
    assert.ok(o.ok);
    assert.equal(o.data.status, "CANCELLED");
    assert.ok(o.data.cancelled_at);
    assert.equal(o.data.shipping?.status, "CANCELLED");
    assert.ok(o.data.shipping?.events.some((e) => e.status === "CANCELLED"));
    assert.equal(o.data.cancel_request?.status, "COMPLETED");
    assert.equal(o.data.payment?.refund_status, "PENDING");
    assert.equal(await stockOf("v-c-32"), before); // 정확히 1회 복원

    // 재실행해도 재고·환불이 늘지 않는다 (재시작 안전)
    const c2 = await completeCancellation(orderId);
    assert.ok(c2.ok);
    assert.equal(await stockOf("v-c-32"), before);
  });

  test("complete_refund: PENDING→REFUNDED 전액 1회, 재실행 멱등", async () => {
    const orderId = await createOrder("v-b-24");
    const cid = await requestViaApproval(orderId, "rec-refund");
    const ex = await requestCancelOrder(C_UI, { confirmation_id: cid });
    assert.ok(ex.ok);
    const paid = ex.data.refund_amount_won;

    // 취소 처리 전 환불은 거절
    const early = await completeRefund(orderId);
    assert.ok(!early.ok && early.error.code === "INVALID_STATE");

    assert.ok((await completeCancellation(orderId)).ok);
    const r1 = await completeRefund(orderId);
    assert.ok(r1.ok && r1.data.status === "REFUNDED");
    assert.equal(r1.data.refunded_amount_won, paid); // 실결제액 전액

    const o = await getOrder(C_UI, orderId);
    assert.ok(o.ok);
    assert.equal(o.data.payment?.refund_status, "REFUNDED");
    assert.equal(o.data.payment?.refunded_amount_won, paid);
    assert.ok(o.data.payment?.refunded_at);

    const r2 = await completeRefund(orderId);
    assert.ok(r2.ok && r2.data.refunded_amount_won === paid); // 두 번 환불되지 않는다
  });

  test("payment_mismatch: 결제액!=주문합계는 DATA_INCONSISTENT로 중단", async () => {
    const orderId = await createOrder("v-b-27");
    await sql.unsafe(
      "UPDATE payments SET paid_amount_won = paid_amount_won - 1 WHERE order_id=$1", [orderId]);
    const el = await checkCancelEligibility(C_UI, orderId);
    assert.ok(el.ok && !el.data.eligible);
    assert.ok(el.data.reasons.some((r) => r.code === "DATA_INCONSISTENT"));
    // 불가 주문은 견적도 null — 승인이 만들어지지 않는다
    const q = await getCancelQuote(C_UI, orderId, "OTHER");
    assert.ok(q.ok && q.data.quote === null);
  });

  test("invalid internal transitions: 요청 없는 취소 처리/환불은 거절", async () => {
    const orderId = await createOrder("v-b-24");
    const c = await completeCancellation(orderId);
    assert.ok(!c.ok && c.error.code === "INVALID_STATE");
    const r = await completeRefund(orderId);
    assert.ok(!r.ok && r.error.code === "INVALID_STATE");
    const o = await getOrder(C_UI, orderId);
    assert.ok(o.ok && o.data.status === "CONFIRMED" && o.data.payment?.refund_status === "NONE");
  });
});

// sql 풀 연결을 닫아야 서브프로세스가 종료한다.
after(() => sql.end());
