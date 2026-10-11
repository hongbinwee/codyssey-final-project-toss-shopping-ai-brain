// 주문 카드 헤더 상태·우측 상태일·CTA 노출 규칙 — 서버 원본값만으로 유도하는
// 순수 함수 모음. DB 의존 0이라 unit 테스트로 그대로 검증한다 [PMQA-048-A].
// 라벨 매핑은 Toss Shopping Ref orders(079/080/081/084/090/091)의 Observed 문구를
// 우선하고, 관찰되지 않은 상태(IN_TRANSIT·DELIVERED 헤더·타임라인 표기)는
// [Project] 라벨로 둔다 — 실제 상태명을 꾸미지 않는다.

export type OrderStatusInput = {
  order_status: string;                       // CONFIRMED | CANCELLED
  cancel_status: string | null;               // REQUESTED | COMPLETED | null
  shipping_status: string | null;             // PREPARING | IN_TRANSIT | DELIVERED | CANCELLED | null
  payment_status: string | null;              // PAID | null
};

export type CardHead = { label: string; tone: "normal" | "muted" };
export type RightLabel = { text: string; tone: "ok" | "muted" };

// 카드 헤더 상태 — 우선순위: CANCELLED > 취소요청 > 배송 > 결제.
// REQUESTED≠CANCELLED≠REFUNDED를 헤더 하나로 섞지 않는다 [PM 지침].
export function cardHead(o: OrderStatusInput): CardHead {
  if (o.order_status === "CANCELLED" || o.cancel_status === "COMPLETED")
    return { label: "취소완료", tone: "muted" };
  if (o.cancel_status === "REQUESTED") return { label: "취소요청", tone: "normal" };
  switch (o.shipping_status) {
    case "PREPARING":
      return { label: "상품준비중", tone: "normal" };      // [Observed Ref084]
    case "IN_TRANSIT":
      return { label: "배송 중", tone: "normal" };         // Not Observed → [Project]
    case "DELIVERED":
      return { label: "배송 완료", tone: "normal" };       // Not Observed → [Project]
    case "CANCELLED":
      return { label: "배송 취소", tone: "muted" };         // Not Observed → [Project]
  }
  if (o.payment_status === "PAID") return { label: "결제완료", tone: "normal" }; // [Observed Ref080]
  // 미확인 결제(payment 없음/알 수 없음)를 '결제완료'로 단정하지 않는다 — 주문 자체는
  // CONFIRMED이므로 주문 확정 상태로 정직하게 표시 [PM048-A 보조 검수].
  return { label: "주문 완료", tone: "normal" };
}

const WD = ["일", "월", "화", "수", "목", "금", "토"];

// "M월 D일 (요일)" — 우측 상태일 표기.
export function koLongDate(iso: string): string {
  const d = new Date(iso);
  return (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + WD[d.getDay()] + ")";
}

// "M.D (요일)" — '결제 상세 >' 링크 앞 결제일 표기.
export function koShortDate(iso: string): string {
  const d = new Date(iso);
  return (d.getMonth() + 1) + "." + d.getDate() + " (" + WD[d.getDay()] + ")";
}

// 카드 우측 상태일 — 취소 완료 > 배송 완료 > 도착 예정 순으로 하나만 표시한다.
// estimated/delivered는 서버가 보낸 실제 값만 사용하고 null이면 아예 숨긴다
// (임의 ETA 생성 금지). 취소요청 중에도 도착 예정은 Ref091처럼 그대로 둔다.
export function cardRightLabel(o: OrderStatusInput & {
  cancelled_at?: string | null;
  shipping_estimated_arrival_at?: string | null;
  delivered_at?: string | null;
}): RightLabel | null {
  if (o.order_status === "CANCELLED" || o.cancel_status === "COMPLETED")
    return o.cancelled_at
      ? { text: koLongDate(o.cancelled_at) + " 취소 완료", tone: "muted" }
      : { text: "취소 완료", tone: "muted" };
  if (o.shipping_status === "DELIVERED")
    return o.delivered_at
      ? { text: koLongDate(o.delivered_at) + " 도착", tone: "muted" }
      : { text: "배송 완료", tone: "muted" };
  if (o.shipping_estimated_arrival_at)
    return { text: koLongDate(o.shipping_estimated_arrival_at) + " 도착 예정", tone: "ok" };
  return null;
}

// '배송 조회' 칩 — 배송이 진행·완료된 주문에만 노출 [Observed Ref079 구매확정 카드].
// 결과 섹션 앵커로 이동하며, 배송 정보 없음은 정직하게 표시한다.
export function showShipChip(o: OrderStatusInput): boolean {
  return o.shipping_status === "IN_TRANSIT" || o.shipping_status === "DELIVERED";
}

// '취소하기' 버튼 — 확정 주문 + 아직 취소 요청이 없을 때만 [Observed Ref079/090].
export function canRequestCancel(o: OrderStatusInput): boolean {
  return o.order_status === "CONFIRMED" && !o.cancel_status;
}

// delivered_at 유도 — 서버 listOrders 전용. 마지막 event의 실제 status가
// DELIVERED일 때만 그 occurred_at을 쓰고, 그 외에는 null을 돌려준다
// (event 없음·마지막 상태 불일치면 날짜를 만들지 않는다) [PM 지침 교차검증].
export function deliveredAtFromEvents(
  shipStatus: string | null,
  events: { status: string; occurred_at: string }[] | null | undefined,
): string | null {
  if (shipStatus !== "DELIVERED" || !events?.length) return null;
  const last = events[events.length - 1];
  if (last?.status !== "DELIVERED") return null;
  return last.occurred_at;
}

// 서버 refund_status의 별도 라벨 — 카드 헤더(CANCELLED)만으로 실제 환불 진행을
// 유추하지 않는다. NONE·미설정이면 숨기고, 미확인 값은 '완료'로 단정하지 않고
// 서버 원문을 그대로 표시한다 [PM048-A — 기존 목록 환불 배지 회귀 보존].
const REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: "환불 처리 중",
  REFUNDED: "환불 완료",
};
export function refundLabel(o: { refund_status: string | null }): string | null {
  const s = o.refund_status;
  if (!s || s === "NONE") return null;
  return REFUND_STATUS_LABEL[s] ?? s;
}
