// W06 주문 상세 — 상품/금액 스냅샷·결제·배송 이력·취소 요청/환불 결과를 한 화면에서 본다.
// 배송 갱신은 서버 데이터를 다시 조회하는 '새로고침'으로만 — 상태는 시뮬레이터가 바꾼다.
import { useEffect, useState } from "react";
import { apiSafe, fmtWon, type ApiResult } from "../api.ts";
import type { OrderView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { CancelSheet } from "../components/CancelSheet.tsx";

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
  onBack,
  onAskAgent,
}: {
  orderId: string;
  onBack: () => void;
  onAskAgent: (orderId: string) => void;
}) {
  const [res, setRes] = useState<ApiResult<OrderView> | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  async function reload() {
    const r = await apiSafe<OrderView>("/api/orders/" + encodeURIComponent(orderId));
    setRes(r);
    return r;
  }
  useEffect(() => {
    reload();
  }, [orderId]);

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

  return (
    <div className="screen">
      <div className="order-head">
        <div>
          <h2 className="section-title">주문 상세</h2>
          <div className="muted sm">
            {o.id} · {new Date(o.created_at).toLocaleString("ko-KR")}
          </div>
        </div>
        <button className="btn ghost" onClick={() => reload()}>새로고침</button>
      </div>

      {o.status === "CANCELLED" && (
        <div className="state-box">취소된 주문이에요{o.cancelled_at ? " · " + new Date(o.cancelled_at).toLocaleString("ko-KR") : ""}</div>
      )}

      <ul className="cart-list">
        {o.items.map((i) => (
          <li key={i.order_item_id} className="cart-item">
            <div className="cart-thumb">{i.product_name.slice(0, 1)}</div>
            <div className="cart-info">
              <div>{i.product_name}</div>
              <div className="muted">
                {Object.values(i.option_values).join(" · ")} · {i.quantity}개
              </div>
            </div>
            <div className="cart-right"><b>{fmtWon(i.line_total_won)}</b></div>
          </li>
        ))}
      </ul>

      <div className="checkout-block">
        <h3 className="section-title">결제 정보</h3>
        {o.payment ? (
          <>
            <div>
              모의 결제 {fmtWon(o.payment.paid_amount_won)}
              <span className="muted sm"> · {new Date(o.payment.paid_at).toLocaleString("ko-KR")}</span>
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
        <div className="muted">
          상품 {fmtWon(o.items_total_won)} + 배송비 {fmtWon(o.shipping_fee_won)} = {fmtWon(o.total_won)}
        </div>
      </div>

      <div className="checkout-block">
        <h3 className="section-title">배송지</h3>
        <div>{o.address_snapshot.name} · {o.address_snapshot.phone}</div>
        <div className="muted">
          {o.address_snapshot.address} {o.address_snapshot.detail}
        </div>
      </div>

      <div className="checkout-block">
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
      </div>

      {o.cancel_request && (
        <div className="checkout-block">
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
        </div>
      )}

      <div className="bottom-bar">
        <button className="btn ghost" onClick={onBack}>목록</button>
        {o.status === "CONFIRMED" && !o.cancel_request && (
          <button className="btn ghost" onClick={() => setCancelOpen(true)}>주문 취소</button>
        )}
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
