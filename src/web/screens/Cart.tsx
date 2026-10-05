// W03 장바구니 (Phase 1: 조회 + 담기 결과 확인. 수량 수정/삭제/주문은 후속 Phase)
import { useEffect, useState } from "react";
import { api, fmtWon, type ApiResult } from "../api.ts";
 import type { CartView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";

export function Cart({
  cart,
  onCartLoaded,
  onOpenShop,
}: {
  cart: CartView | null;
  onCartLoaded: (v: CartView) => void;
  onOpenShop: () => void;
}) {
  const [res, setRes] = useState<ApiResult<CartView> | null>(cart ? { ok: true, data: cart } : null);
  const [loading, setLoading] = useState(!cart);

  useEffect(() => {
    api<CartView>("/api/cart").then((r) => {
      setRes(r);
      if (r.ok) onCartLoaded(r.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <Loading />;
  if (!res) return null;
  if (!res.ok)
    return <ErrorState text="카트를 불러오지 못했어요" onRetry={() => location.reload()} />;
  const c = res.data;

  if (c.items.length === 0)
    return (
      <Empty
        text="장바구니가 비어 있어요"
        action={<button className="btn primary" onClick={onOpenShop}>쇼핑하러 가기</button>}
      />
    );

  return (
    <div className="screen">
      <ul className="cart-list">
        {c.items.map((i) => (
          <li key={i.cart_item_id} className="cart-item">
            <div className="cart-thumb">{i.product_name.slice(0, 1)}</div>
            <div className="cart-info">
              <div>{i.product_name}</div>
              <div className="muted">{Object.values(i.option_values).join(" · ")}</div>
              {!i.purchasable && <div className="badge-soldout">{i.block_reason} — 주문할 수 없어요</div>}
            </div>
            <div className="cart-right">
              <b>{fmtWon(i.unit_price_won)}</b>
              <span className="muted">× {i.quantity}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="bottom-bar">
        <div>
          <div className="muted">상품 {fmtWon(c.items_total_won)} + 배송비 {fmtWon(c.shipping_fee_won)}</div>
          <b>{fmtWon(c.total_won)}</b>
        </div>
        {/* 주문 버튼은 Phase 3에서 연결 — 존재하지 않는 기능을 노출하지 않는다 */}
      </div>
    </div>
  );
}
