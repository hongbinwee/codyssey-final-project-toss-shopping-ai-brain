// W05 내 주문 목록 — 최신순. 행 클릭 시 W06 주문 상세로 이동한다.
import { useEffect, useState } from "react";
import { api, fmtWon, type ApiResult } from "../api.ts";
import type { OrderListItem } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";

const ORDER_LABEL: Record<string, string> = {
  CONFIRMED: "주문 완료",
  CANCELLED: "주문 취소",
};
const SHIP_LABEL: Record<string, string> = {
  PREPARING: "배송 준비 중",
  IN_TRANSIT: "배송 중",
  DELIVERED: "배송 완료",
  CANCELLED: "배송 취소",
};
const REFUND_LABEL: Record<string, string> = {
  PENDING: "환불 처리 중",
  REFUNDED: "환불 완료",
};

export function Orders({
  onOpenOrder,
  onOpenShop,
}: {
  onOpenOrder: (orderId: string) => void;
  onOpenShop: () => void;
}) {
  const [res, setRes] = useState<ApiResult<{ orders: OrderListItem[] }> | null>(null);

  useEffect(() => {
    api<{ orders: OrderListItem[] }>("/api/orders").then(setRes);
  }, []);

  if (!res) return <Loading text="주문 내역을 불러오는 중…" />;
  if (!res.ok)
    return <ErrorState text="주문 내역을 불러오지 못했어요" onRetry={() => location.reload()} />;
  const orders = res.data.orders;

  return (
    <div className="screen">
      <h2 className="section-title">내 주문</h2>
      {orders.length === 0 ? (
        <Empty
          text="주문 내역이 없어요"
          action={<button className="btn primary" onClick={onOpenShop}>쇼핑하러 가기</button>}
        />
      ) : (
        <ul className="cart-list">
          {orders.map((o) => (
            <li key={o.id}>
              <button className="order-row" onClick={() => onOpenOrder(o.id)}>
                <div className="cart-info">
                  <div>{o.item_summary}</div>
                  <div className="muted sm">
                    {o.id} · {new Date(o.created_at).toLocaleDateString("ko-KR")}
                  </div>
                  <div className="order-badges">
                    <span className={"badge" + (o.order_status === "CANCELLED" ? " bad" : "")}>
                      {ORDER_LABEL[o.order_status] ?? o.order_status}
                    </span>
                    {o.payment_status === "PAID" && <span className="badge">결제 완료</span>}
                    {o.shipping_status
                      ? <span className="badge">{SHIP_LABEL[o.shipping_status] ?? o.shipping_status}</span>
                      : <span className="badge muted-b">배송 정보 없음</span>}
                    {o.refund_status && o.refund_status !== "NONE" && (
                      <span className="badge">{REFUND_LABEL[o.refund_status] ?? o.refund_status}</span>
                    )}
                  </div>
                </div>
                <div className="cart-right"><b>{fmtWon(o.total_won)}</b></div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
