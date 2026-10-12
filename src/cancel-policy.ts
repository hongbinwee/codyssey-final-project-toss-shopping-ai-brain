// 취소 자격 판정 — pure 정책 모듈(DB 의존 없음) [PMQA-06B-053 MJ053-1].
// 이 파일이 취소 가능 여부의 단일 Source다.
//   - cancellation.ts: 서버 실행·견적·자격 API가 같은 판정을 사용
//   - orders.ts: 목록/상세 DTO의 cancel_eligible이 같은 판정을 사용
//   - order-display.ts: UI CTA는 서버 계산 cancel_eligible만 소비(fail closed)
// 자격·환불액은 서버 정책이 결정한다 — LLM·UI 임의 추정 금지.
// DB import를 두지 않는다 — 주문 화면·주문서 양쪽에서 순환 참조 없이 쓸 수 있게.

export interface CancelFacts {
  order_status: string;
  order_total_won: number;
  payment: { status: string; refund_status: string; paid_amount_won: number } | null;
  has_cancel_request: boolean;
  shipment_status: string | null; // null = 배송 레코드 없음
}

const REASON_TEXT: Record<string, string> = {
  ALREADY_CANCELLED: "이미 취소된 주문이에요",
  PAYMENT_NOT_ELIGIBLE: "결제/환불 상태가 취소 가능한 상태가 아니에요",
  CANCEL_ALREADY_REQUESTED: "이미 취소 요청이 접수된 주문이에요",
  ALREADY_SHIPPED: "이미 출고된 주문은 취소할 수 없어요",
  SHIPPING_UNVERIFIED: "배송 정보가 없어 출고 전인지 확인할 수 없어요",
  DATA_INCONSISTENT: "결제 금액과 주문 금액이 일치하지 않아요",
};

export function evaluateCancelFacts(
  f: CancelFacts,
): { eligible: boolean; reasons: { code: string; message: string }[] } {
  const reasons: { code: string; message: string }[] = [];
  const push = (code: string) => reasons.push({ code, message: REASON_TEXT[code] });
  if (f.order_status !== "CONFIRMED") push("ALREADY_CANCELLED");
  if (!f.payment || f.payment.status !== "PAID" || f.payment.refund_status !== "NONE")
    push("PAYMENT_NOT_ELIGIBLE");
  else if (f.payment.paid_amount_won !== f.order_total_won) push("DATA_INCONSISTENT");
  if (f.has_cancel_request) push("CANCEL_ALREADY_REQUESTED");
  if (f.shipment_status === null) push("SHIPPING_UNVERIFIED");
  else if (f.shipment_status === "IN_TRANSIT" || f.shipment_status === "DELIVERED")
    push("ALREADY_SHIPPED");
  else if (f.shipment_status !== "PREPARING") push("SHIPPING_UNVERIFIED");
  // 허용은 PREPARING뿐이다. CANCELLED 등 다른 상태는 출고 전 여부를 증명할 수 없다.
  return { eligible: reasons.length === 0, reasons };
}
