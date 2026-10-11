// W06 주문 상세 — Ref080/081/084/090 구조: 주문 카드 → 배송지 → 결제 정보 →
// 배송 상태/events → 취소 요청. 스냅샷(이름·옵션·수량·가격)만 서버값으로 쓰고,
// 이미지·상품 링크는 조회 시점 카탈로그 표시용으로 분리한다 [PM 지침].
// 배송 갱신은 서버 데이터를 다시 조회하는 '새로고침'으로만 — 상태는 시뮬레이터가 바꾼다.
import { useEffect, useRef, useState } from "react";
import { apiSafe, fmtWon, type ApiResult } from "../api.ts";
import type { OrderView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { CancelSheet } from "../components/CancelSheet.tsx";
import { OrderCard } from "../components/OrderCard.tsx";
import {
  cardHead, cardRightLabel, deliveredAtFromEvents, showShipChip,
} from "../../order-display.ts";

const SHIP_LABEL: Record<string, string> = {
  PREPARING: "배송 준비 중",
  IN_TRANSIT: "배송 중",
  DELIVERED: "배송 완료",
  CANCELLED: "배송 취소",
};

const CANCEL_LABEL: Record<string, string> = {
  REQUESTED: "취소 요청 접수됨",
  COMPLETED: "취소 완료",
};
const REASON_LABEL: Record<string, string> = {
  ORDER_MISTAKE: "주문을 잘못 입력",
  CHANGE_OF_MIND: "단순 변심",
  OTHER: "기타",
};

export function OrderDetail({
  orderId,
  focus,
  onBack,
  onAskAgent,
  onOpenProduct,
}: {
  orderId: string;
  focus?: "shipping"; // 목록 '배송 조회' 칩 진입 — 실제 배송 섹션으로 스크롤
  onBack: () => void;
  onAskAgent: (orderId: string) => void;
  onOpenProduct: (productId: string) => void; // 상품 행 → 실제 상품 링크(지원 경로)
}) {
  const [res, setRes] = useState<ApiResult<OrderView> | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const shipRef = useRef<HTMLDivElement | null>(null);
  // 응답 역전 가드 — 주문 A→B 빠른 이동 시 느린 A 응답이 B 화면을 덮지 않는다 [PM 보조 기준].
  const seqRef = useRef(0);

  async function reload() {
    const seq = ++seqRef.current;
    const r = await apiSafe<OrderView>("/api/orders/" + encodeURIComponent(orderId));
    if (seq !== seqRef.current) return r; // 오래된 응답 — 상태에 반영하지 않는다
    setRes(r);
    return r;
  }
  useEffect(() => {
    // orderId 변경 시 이전 주문의 응답·취소 시트가 남지 않게 초기화한다.
    setRes(null);
    setCancelOpen(false);
    reload();
  }, [orderId]);

  // '배송 조회' 진입 시 실제 배송 섹션으로만 이동 — 결과가 없으면 Empty가 정직 표시.
  useEffect(() => {
    if (focus === "shipping" && res?.ok && shipRef.current)
      shipRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, res]);

  if (!res) return <Loading text="주문을 불러오는 중…" />;
  if (!res.ok)
    return (
      <div className="screen">
        <ErrorState
          text={res.error.code === "NOT_FOUND" ? "주문을 찾을 수 없어요" : "주문을 불러오지 못했어요"}
          onRetry={() => reload()}
        />
        <button className="btn ghost" onClick={onBack}>주문 목록으로</button>
      </div>
    );
  const o = res.data;
  const head = cardHead({
    order_status: o.status,
    cancel_status: o.cancel_request?.status ?? null,
    shipping_status: o.shipping?.status ?? null,
    payment_status: o.payment?.status ?? null,
  });
  const right = cardRightLabel({
    order_status: o.status,
    cancel_status: o.cancel_request?.status ?? null,
    shipping_status: o.shipping?.status ?? null,
    payment_status: o.payment?.status ?? null,
    cancelled_at: o.cancelled_at,
    shipping_estimated_arrival_at: o.shipping?.estimated_arrival_at ?? null,
    delivered_at: o.shipping
      ? deliveredAtFromEvents(o.shipping.status, o.shipping.events)
      : null,
  });

  return (
    <div className="screen order-detail">
      <div className="order-head">
        <div>
          <h2 className="section-title">주문 상세 내역</h2>
          <div className="muted sm">
            {new Date(o.created_at).toLocaleDateString("ko-KR")} ·{" "}
            {o.payment ? "결제완료" : "결제 정보 없음"}
          </div>
        </div>
        <button className="btn ghost" onClick={() => reload()}>새로고침</button>
      </div>

      {o.status === "CANCELLED" && (
        <div className="state-box">취소된 주문이에요{o.cancelled_at ? " · " + new Date(o.cancelled_at).toLocaleString("ko-KR") : ""}</div>
      )}

      <OrderCard
        orderId={o.id}
        headLabel={head.label}
        headMuted={head.tone === "muted"}
        rightLabel={right}
        shipChip={showShipChip({
          order_status: o.status,
          cancel_status: o.cancel_request?.status ?? null,
          shipping_status: o.shipping?.status ?? null,
          payment_status: o.payment?.status ?? null,
        })}
        onShip={() => shipRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        onOpenDetail={() => {}}
        detailDateLabel=""
        hideLink
        onItemClick={(it) => {
          if (it.productId) onOpenProduct(it.productId);
        }}
        items={o.items.map((i) => ({
          key: i.order_item_id,
          name: i.product_name,
          option: Object.values(i.option_values).join(" · ") || null,
          qty: i.quantity,
          lineWon: i.line_total_won,
          image: i.image,
          productId: i.product_id,
          clickable: i.product_id != null, // variant 삭제 시 행은 비interactive
        }))}
        deliveryLine={
          o.shipping_fee_won === 0 ? "무료배송" : "배송비 " + fmtWon(o.shipping_fee_won)
        }
        onCancel={
          o.status === "CONFIRMED" && !o.cancel_request
            ? () => setCancelOpen(true)
            : undefined
        }
        onAsk={() => onAskAgent(o.id)}
      />

      <div className="checkout-band" />

      <section className="od-sec">
        <h3 className="section-title">배송지</h3>
        {/* Ref080 배송지 — 이름 → 주소/상세 → 연락처 정보 계층 [Observed 계층, 지원 범위] */}
        <div className="od-addr-name">{o.address_snapshot.name}</div>
        <div className="od-addr">
          {o.address_snapshot.address} {o.address_snapshot.detail}
        </div>
        <div className="muted sm od-addr-phone">{o.address_snapshot.phone}</div>
      </section>

      <div className="checkout-band" />

      <section className="od-sec">
        <h3 className="section-title">결제 정보</h3>
        <div className="pay-row"><span>상품 금액</span><b>{fmtWon(o.items_total_won)}</b></div>
        <div className="pay-row"><span>배송비</span><b>{fmtWon(o.shipping_fee_won)}</b></div>
        <div className="pay-row total"><span>총 결제 금액</span><b>{fmtWon(o.total_won)}</b></div>
        {o.payment ? (
          <>
            <div className="muted sm">
              모의 결제 {fmtWon(o.payment.paid_amount_won)} — 실제 결제는 발생하지 않아요
              {" · "}{new Date(o.payment.paid_at).toLocaleString("ko-KR")}
            </div>
            {o.payment.refund_status !== "NONE" && (
              <div className="muted">
                환불 {o.payment.refund_status === "PENDING" ? "처리 중" : "완료"}
                {" · "}{fmtWon(o.payment.refunded_amount_won)}
              </div>
            )}
          </>
        ) : (
          <div className="muted">결제 정보가 없어요</div>
        )}
      </section>

      <div className="checkout-band" />

      <section className="od-sec" ref={shipRef} id="order-shipping">
        <h3 className="section-title">배송 상태</h3>
        {o.shipping ? (
          <>
            <div>
              <span className="badge">{SHIP_LABEL[o.shipping.status] ?? o.shipping.status}</span>
              {o.shipping.estimated_arrival_at && (
                <span className="muted sm">
                  {" "}도착 예정 {new Date(o.shipping.estimated_arrival_at).toLocaleDateString("ko-KR")}
                </span>
              )}
            </div>
            {/* [Project] — 배송 Timeline 자체는 Ref에서 Not Observed. 실제 events만 표시한다. */}
            <ul className="timeline">
              {o.shipping.events.map((e, i) => (
                <li key={i}>
                  <b>{SHIP_LABEL[e.status] ?? e.status}</b>
                  <span className="muted sm">
                    {" "}{new Date(e.occurred_at).toLocaleString("ko-KR")}
                    {e.note ? " · " + e.note : ""}
                  </span>
                </li>
              ))}
            </ul>
            <div className="muted sm">
              마지막 갱신 {new Date(o.shipping.updated_at).toLocaleString("ko-KR")}
            </div>
          </>
        ) : (
          <Empty text="배송 정보가 아직 등록되지 않았어요" />
        )}
      </section>

      {o.cancel_request && (
        <>
        <div className="checkout-band" />
        <section className="od-sec">
          <h3 className="section-title">취소 요청</h3>
          <div>
            <span className="badge">{CANCEL_LABEL[o.cancel_request.status] ?? o.cancel_request.status}</span>
            {" "}사유: {REASON_LABEL[o.cancel_request.reason_code] ?? o.cancel_request.reason_code}
          </div>
          <div className="muted sm">
            접수 {new Date(o.cancel_request.requested_at).toLocaleString("ko-KR")}
            {o.cancel_request.completed_at && " · 처리 " + new Date(o.cancel_request.completed_at).toLocaleString("ko-KR")}
          </div>
          <div className="muted">
            환불 예정 {fmtWon(o.cancel_request.refund_amount_won)}
            {o.payment?.refund_status === "REFUNDED" ? " — 환불 완료" : o.payment?.refund_status === "PENDING" ? " — 환불 처리 중" : ""}
          </div>
        </section>
        </>
      )}

      <div className="bottom-bar">
        <button className="btn ghost" onClick={onBack}>목록</button>
        <button className="btn primary" onClick={() => onAskAgent(o.id)}>
          AI에게 이 주문 물어보기
        </button>
      </div>

      {cancelOpen && (
        <CancelSheet
          orderId={o.id}
          itemSummary={
            o.items[0]?.product_name +
            (o.items.length > 1 ? " 외 " + (o.items.length - 1) + "건" : "")
          }
          onClose={(changed) => {
            setCancelOpen(false);
            if (changed) reload();
          }}
        />
      )}
    </div>
  );
}
