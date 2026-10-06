// 취소 자격 판정 표 테스트 — pure 함수라 DB 없이 전체 조합을 검증한다 (DTD 4.3).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCancelFacts, type CancelFacts } from "../../src/cancellation.ts";

const base: CancelFacts = {
  order_status: "CONFIRMED",
  order_total_won: 152000,
  payment: { status: "PAID", refund_status: "NONE", paid_amount_won: 152000 },
  has_cancel_request: false,
  shipment_status: "PREPARING",
};

const codes = (f: Partial<CancelFacts>) =>
  evaluateCancelFacts({ ...base, ...f }).reasons.map((r) => r.code);

describe("cancel eligibility policy (p0-v1)", () => {
  test("모든 조건 충족 → eligible", () => {
    const r = evaluateCancelFacts(base);
    assert.equal(r.eligible, true);
    assert.equal(r.reasons.length, 0);
  });

  test("이미 취소된 주문", () => {
    assert.ok(codes({ order_status: "CANCELLED", shipment_status: "CANCELLED" })
      .includes("ALREADY_CANCELLED"));
  });

  test("결제 없음/미PAID/환불 진행·완료 → PAYMENT_NOT_ELIGIBLE", () => {
    assert.ok(codes({ payment: null }).includes("PAYMENT_NOT_ELIGIBLE"));
    assert.ok(codes({ payment: { status: "X", refund_status: "NONE", paid_amount_won: 152000 } })
      .includes("PAYMENT_NOT_ELIGIBLE"));
    for (const rs of ["PENDING", "REFUNDED"] as const)
      assert.ok(codes({ payment: { status: "PAID", refund_status: rs, paid_amount_won: 152000 } })
        .includes("PAYMENT_NOT_ELIGIBLE"));
  });

  test("결제액과 주문 합계 불일치 → DATA_INCONSISTENT", () => {
    assert.ok(codes({ payment: { status: "PAID", refund_status: "NONE", paid_amount_won: 1 } })
      .includes("DATA_INCONSISTENT"));
    // 환불 예정액은 저장된 실결제액이며 현재 상품 가격과 무관 — 상품가는 facts에 없다.
  });

  test("기존 취소 요청 → CANCEL_ALREADY_REQUESTED", () => {
    assert.ok(codes({ has_cancel_request: true }).includes("CANCEL_ALREADY_REQUESTED"));
  });

  test("배송 정보 없음 → SHIPPING_UNVERIFIED (출고 전 추정 금지)", () => {
    assert.ok(codes({ shipment_status: null }).includes("SHIPPING_UNVERIFIED"));
  });

  test("배송 중/완료 → ALREADY_SHIPPED", () => {
    for (const s of ["IN_TRANSIT", "DELIVERED"])
      assert.ok(codes({ shipment_status: s }).includes("ALREADY_SHIPPED"));
  });

  test("배송 CANCELLED 등 PREPARING 아닌 상태 → SHIPPING_UNVERIFIED", () => {
    assert.ok(codes({ shipment_status: "CANCELLED" }).includes("SHIPPING_UNVERIFIED"));
  });

  test("복합 불가 사유는 전부 나열한다", () => {
    const r = codes({
      order_status: "CANCELLED",
      shipment_status: "CANCELLED",
      has_cancel_request: true,
    });
    assert.ok(r.includes("ALREADY_CANCELLED") && r.includes("CANCEL_ALREADY_REQUESTED"));
  });
});
