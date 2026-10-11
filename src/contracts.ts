// DATA_TOOL_DESIGN 5~7절 공통 계약. 구현된 Tool만 registry에 노출한다.
export type RecoveryAction =
  | "RETRY_READ"
  | "REFRESH_AND_RECONFIRM"
  | "CHECK_OPERATION"
  | "STOP";

export type ToolError = {
  code: string;
  message: string;
  recovery_action: RecoveryAction;
};

export type ToolResult<T> =
  | {
      ok: true;
      data: T;
      observed_at: string;
      trace_id: string;
      operation_id?: string;
      action_status?: string;
      replayed?: boolean;
    }
  | {
      ok: false;
      error: ToolError;
      trace_id: string;
      operation_id?: string;
      action_status?: string;
      replayed?: boolean;
    };

export const ok = <T>(data: T, trace_id: string): ToolResult<T> => ({
  ok: true,
  data,
  observed_at: new Date().toISOString(),
  trace_id,
});

export const fail = <T>(
  error: ToolError,
  trace_id: string,
  operation_id?: string,
): ToolResult<T> => ({ ok: false, error, trace_id, operation_id });

export const err = (
  code: string,
  message: string,
  recovery_action: RecoveryAction = "STOP",
): ToolError => ({ code, message, recovery_action });

export type Availability = "AVAILABLE" | "SOLD_OUT" | "UNAVAILABLE";

export interface MatchedVariant {
  variant_id: string;
  option_values: Record<string, string>;
  effective_specs: Record<string, string>;
  unit_price_won: number;
  stock_qty: number;
  availability: Availability;
  version: number;
}

export interface ProductSummary {
  product_id: string;
  name: string;
  brand: string;
  category: string;
  image: string | null;
  matched_variants: MatchedVariant[];
  rating_summary: { avg: number | null; count: number };
  availability: Availability;
}

export interface SearchResult {
  items: ProductSummary[];
  shipping_fee_won: number;
  next_cursor: string | null;
  has_more: boolean;
}

export interface ProductDetail {
  product: {
    id: string;
    name: string;
    brand: string;
    category: string;
    description: string;
    images: string[];
    specs: Record<string, string>;
    active: boolean;
    version: number;
    availability: Availability;
  };
  variants: MatchedVariant[];
  shipping_fee_won: number;
}

export interface ReviewItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  rating: number;
  body: string;
  source_kind: "REAL" | "SYNTHETIC";
  source_ref: string;
  written_at: string;
}

export interface ReviewsResult {
  reviews: ReviewItem[];
  total_matching: number;
  returned_count: number;
  next_cursor: string | null;
  has_more: boolean;
}

export interface CartItemView {
  cart_item_id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  image: string | null;
  option_values: Record<string, string>;
  quantity: number;
  unit_price_won: number;
  variant_version: number;
  availability: Availability;
  purchasable: boolean;
  block_reason: string | null;
}

export interface CartView {
  cart_id: string;
  version: number;
  items: CartItemView[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  can_checkout: boolean;
}

// A01 비교 카드. 서버가 Tool 조회 결과로만 조립한다 — LLM 텍스트를 근거로 쓰지 않는다.
export interface CompareCard {
  products: {
    product_id: string;
    name: string;
    min_price_won: number;
    max_price_won: number;
    rating_summary: { avg: number | null; count: number };
    availability: Availability;
    evidence_review_ids: string[];
  }[];
  limitations: string[];
}

// 주문/결제/배송 (Phase 3). 주문 항목은 구매 시점 스냅샷이다.
export interface OrderItemView {
  order_item_id: string;
  variant_id: string;
  product_name: string;
  option_values: Record<string, string>;
  unit_price_won: number;
  quantity: number;
  line_total_won: number;
  // 현재 카탈로그 이미지 — 구매 시점 스냅샷이 아니라 조회 시점 표시용이다.
  // 이름/옵션/수량/가격은 저장 스냅샷만 사용하고, 이미지는 없으면 null.
  image: string | null;
  // 이미지 fallback·상품 링크에 쓰는 현재 variant의 product id.
  // variant가 삭제됐으면 null — 스냅샷 필드가 아니라 조회 시점 참조다.
  product_id: string | null;
}

export interface PaymentView {
  status: "PAID";
  paid_amount_won: number;
  paid_at: string;
  refund_status: "NONE" | "PENDING" | "REFUNDED";
  refunded_amount_won: number;
  refunded_at: string | null;
}

export interface ShipmentEvent {
  status: "PREPARING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
  occurred_at: string;
  note?: string;
}

export interface ShipmentView {
  status: ShipmentEvent["status"];
  events: ShipmentEvent[];
  estimated_arrival_at: string | null;
  updated_at: string;
}

export interface OrderView {
  id: string;
  version: number;
  status: "CONFIRMED" | "CANCELLED";
  created_at: string;
  cancelled_at: string | null;
  items: OrderItemView[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  address_snapshot: Record<string, string>;
  payment: PaymentView | null;
  shipping: ShipmentView | null;
  cancel_request: {
    id: string; status: string; reason_code: string;
    refund_amount_won: number; requested_at: string; completed_at: string | null;
  } | null;
}

export interface OrderListFirstItem {
  product_name: string;                    // 스냅샷
  option_values: Record<string, string>;   // 스냅샷
  quantity: number;                        // 스냅샷 — 첫 품목 수량(주문 전체 수량 아님)
  line_total_won: number;                  // 스냅샷 — 첫 품목 금액(주문 총액 아님, '외 N건'과 총액 별도 표시)
  // 조회 시점 카탈로그 이미지 — 구매 시점 스냅샷이 아니다. 없으면 null.
  image: string | null;
  // 이미지 fallback·상품 링크용 조회 시점 참조 — variant 삭제 시 null. 스냅샷 아님.
  product_id: string | null;
}

export interface OrderListItem {
  id: string;
  created_at: string;
  item_summary: string;
  total_won: number;
  order_status: string;
  payment_status: string | null;
  shipping_status: string | null;
  refund_status: string | null;
  cancel_status: string | null;
  // ── 06B additive (PMQA-048-A) — 기존 소비자 필드 의미 불변, 전부 optional ──
  item_count?: number;                     // 주문 내 품목 수 — '외 N건' 표시용
  first_item?: OrderListFirstItem | null;  // 카드 썸네일 행 — 없으면 요약 텍스트로 대체
  paid_at?: string | null;                 // 'N.N 결제 상세' 라벨 — 없으면 created_at 사용
  cancelled_at?: string | null;            // 취소 완료 상태일 — 주문 취소 시에만
  shipping_estimated_arrival_at?: string | null; // 도착 예정 — null이면 미노출(임의 ETA 금지)
  delivered_at?: string | null;            // 마지막 배송 event가 실제 DELIVERED일 때만 설정
}

export interface ShippingStatusResult {
  order_id: string;
  order_version: number;
  information: "AVAILABLE" | "NO_INFORMATION";
  status: ShipmentEvent["status"] | null;
  events: ShipmentEvent[];
  estimated_arrival_at: string | null;
  updated_at: string | null;
}

// T3 취소 (Phase 4). 가능 여부·견적·환불액은 서버가 결정한다 — LLM 입력은 사유 선택뿐.
export type CancelReasonCode = "ORDER_MISTAKE" | "CHANGE_OF_MIND" | "OTHER";

export interface CancelEligibilityResult {
  order_id: string;
  order_version: number;
  eligible: boolean;
  reasons: { code: string; message: string }[];
  policy_version: string;
}

export interface CancelQuoteResult {
  order_id: string;
  order_version: number;
  eligible: boolean;
  reasons: { code: string; message: string }[];
  quote: {
    order_id: string;
    order_version: number;
    reason_code: CancelReasonCode;
    refund_amount_won: number;
    currency: "KRW";
    policy_version: string;
    expires_at: string;
    quote_token: string;
  } | null;
}

export interface CancelRequestResult {
  cancel_request_id: string;
  status: "REQUESTED";
  refund_amount_won: number;
  order: OrderView | null; // 최초 접수 결과 + 현재 주문 상태 재조회. 조회 실패 시 null.
}

// W04 주문서 견적 (UI 전용 — Agent Tool이 아니다). 서명된 불투명 토큰 + 표시용 카트/주소.
export interface CheckoutQuoteView {
  quote_token: string;
  expires_at: string;
  cart: CartView;
  address: Record<string, string>;
}
