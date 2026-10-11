// src/order-display.ts의 DB-free 검증 — 카드 헤더 우선순위·우측 상태일·
// delivered 교차검증·CTA 노출 규칙을 실제 서버값 흐름으로 단정한다 [PMQA-048-A].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  canRequestCancel, cardHead, cardRightLabel, deliveredAtFromEvents,
  koLongDate, koShortDate, refundLabel, showShipChip,
} from "../../src/order-display.ts";

const base = {
  order_status: "CONFIRMED",
  cancel_status: null as string | null,
  shipping_status: null as string | null,
  payment_status: "PAID" as string | null,
};

describe("cardHead", () => {
  test("우선순위: CANCELLED > 취소요청 > 배송 > 결제", () => {
    // CANCELLED가 최우선 — 취소요청·배송 값이 있어도 '취소완료'
    assert.equal(
      cardHead({ ...base, order_status: "CANCELLED", cancel_status: "REQUESTED", shipping_status: "PREPARING" }).label,
      "취소완료",
    );
    // 취소 COMPLETED도 취소완료(REQUESTED와 충돌 없음)
    assert.equal(cardHead({ ...base, cancel_status: "COMPLETED" }).label, "취소완료");
    // 취소요청은 배송 상태보다 우선 [Observed Ref090: 취소요청 + 도착 예정 공존]
    assert.equal(cardHead({ ...base, cancel_status: "REQUESTED", shipping_status: "PREPARING" }).label, "취소요청");
    assert.equal(cardHead({ ...base, shipping_status: "PREPARING" }).label, "상품준비중");
    assert.equal(cardHead({ ...base, shipping_status: "IN_TRANSIT" }).label, "배송 중");
    assert.equal(cardHead({ ...base, shipping_status: "DELIVERED" }).label, "배송 완료");
    assert.equal(cardHead({ ...base }).label, "결제완료"); // PAID + 배송 행 없음
  });

  test("미확인 결제를 '결제완료'로 단정하지 않는다 [PM048 보조 검수]", () => {
    // payment 행 자체가 없거나 상태가 알려지지 않으면 '주문 완료'로 둔다.
    assert.equal(cardHead({ ...base, payment_status: null }).label, "주문 완료");
    assert.equal(cardHead({ ...base, payment_status: "PENDING" }).label, "주문 완료");
  });
});

describe("cardRightLabel", () => {
  test("취소 완료는 cancelled_at 실값만 사용 — 없으면 날짜 없이 상태만", () => {
    assert.deepEqual(
      cardRightLabel({ ...base, order_status: "CANCELLED", cancelled_at: "2026-09-15T12:00:00" }),
      { text: "9월 15일 (화) 취소 완료", tone: "muted" },
    );
    assert.deepEqual(
      cardRightLabel({ ...base, order_status: "CANCELLED", cancelled_at: null }),
      { text: "취소 완료", tone: "muted" },
    );
  });

  test("DELIVERED는 delivered_at 있을 때만 날짜 표시", () => {
    assert.deepEqual(
      cardRightLabel({ ...base, shipping_status: "DELIVERED", delivered_at: "2026-09-16T12:00:00" }),
      { text: "9월 16일 (수) 도착", tone: "muted" },
    );
    assert.deepEqual(
      cardRightLabel({ ...base, shipping_status: "DELIVERED", delivered_at: null }),
      { text: "배송 완료", tone: "muted" },
    );
  });

  test("estimated null이면 우측 라벨을 만들지 않는다(임의 ETA 금지)", () => {
    assert.equal(cardRightLabel({ ...base, shipping_status: "PREPARING", shipping_estimated_arrival_at: null }), null);
    assert.equal(cardRightLabel({ ...base, shipping_status: "PREPARING" }), null);
  });

  test("취소요청 중에도 도착 예정은 그대로 둔다 [Observed Ref091]", () => {
    assert.deepEqual(
      cardRightLabel({ ...base, cancel_status: "REQUESTED", shipping_status: "PREPARING", shipping_estimated_arrival_at: "2026-10-07T12:00:00" }),
      { text: "10월 7일 (수) 도착 예정", tone: "ok" },
    );
  });
});

describe("deliveredAtFromEvents", () => {
  const ev = (s: string, t: string) => ({ status: s, occurred_at: t });
  test("마지막 event가 DELIVERED일 때만 날짜 반환", () => {
    assert.equal(
      deliveredAtFromEvents("DELIVERED", [ev("PREPARING", "t1"), ev("DELIVERED", "t2")]),
      "t2",
    );
  });
  test("마지막 event 상태가 DELIVERED가 아니면 null", () => {
    // 과거 DELIVERED 후 다른 이벤트가 있으면 '도착'으로 단정하지 않는다.
    assert.equal(
      deliveredAtFromEvents("DELIVERED", [ev("DELIVERED", "t1"), ev("IN_TRANSIT", "t2")]),
      null,
    );
    assert.equal(deliveredAtFromEvents("DELIVERED", []), null);
    assert.equal(deliveredAtFromEvents("DELIVERED", null), null);
    assert.equal(deliveredAtFromEvents("IN_TRANSIT", [ev("DELIVERED", "t1")]), null);
  });
});

describe("CTA 규칙", () => {
  test("취소하기는 확정 주문 + 취소 요청 없을 때만", () => {
    assert.equal(canRequestCancel({ ...base }), true);
    assert.equal(canRequestCancel({ ...base, cancel_status: "REQUESTED" }), false);
    assert.equal(canRequestCancel({ ...base, order_status: "CANCELLED" }), false);
  });
  test("배송 조회 칩은 진행·완료 배송에만", () => {
    assert.equal(showShipChip({ ...base, shipping_status: "IN_TRANSIT" }), true);
    assert.equal(showShipChip({ ...base, shipping_status: "DELIVERED" }), true);
    assert.equal(showShipChip({ ...base, shipping_status: "PREPARING" }), false);
    assert.equal(showShipChip({ ...base, shipping_status: null }), false);
  });
});

describe("날짜 라벨", () => {
  test("koLongDate / koShortDate — 요일은 고정 실날짜 기준", () => {
    // 2026-10-04는 일요일, 2026-10-07은 수요일(고정값, tz 영향 없는 정오 사용)
    assert.equal(koLongDate("2026-10-04T12:00:00"), "10월 4일 (일)");
    assert.equal(koShortDate("2026-10-07T12:00:00"), "10.7 (수)");
  });
});

describe("refundLabel — 목록 환불 라벨 회귀 보존 [PM048-A]", () => {
  test("NONE·미설정이면 숨기고 PENDING/REFUNDED만 한글 라벨로", () => {
    assert.equal(refundLabel({ refund_status: null }), null);
    assert.equal(refundLabel({ refund_status: "NONE" }), null);
    assert.equal(refundLabel({ refund_status: "PENDING" }), "환불 처리 중");
    assert.equal(refundLabel({ refund_status: "REFUNDED" }), "환불 완료");
    // 미확인 값은 '완료'로 단정하지 않고 서버 원문 그대로 — CANCELLED 헤더로 환불 유추 금지
    assert.equal(refundLabel({ refund_status: "PROCESSING" }), "PROCESSING");
  });
});
