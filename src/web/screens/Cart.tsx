// W03 장바구니 (Phase 2: 수량 변경/삭제/실패 복구. 주문 진입은 Phase 3).
// 쓰기 요청은 idempotency_key를 단다. OUTCOME_UNKNOWN(응답 유실)이면 같은 키를
// 보존해 결과 조회로 복구하고, 확정 거절(VERSION_CONFLICT 등)이면 새 키로
// 최신 상태 재확인을 요구한다 — 자동 재실행은 하지 않는다.
import { useEffect, useRef, useState } from "react";
import { api, fmtWon, newActionKey, type ApiResult } from "../api.ts";
import type { CartItemView, CartView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";

type Pending = { itemId: string; kind: "UPDATE_CART" | "REMOVE_CART"; key: string };

export function Cart({
  cart,
  onCartLoaded,
  onOpenShop,
  onCheckout,
}: {
  cart: CartView | null;
  onCartLoaded: (v: CartView) => void;
  onOpenShop: () => void;
  onCheckout: () => void;
}) {
  const [res, setRes] = useState<ApiResult<CartView> | null>(cart ? { ok: true, data: cart } : null);
  const [loading, setLoading] = useState(!cart);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<Pending | null>(null);

  async function reload() {
    const r = await api<CartView>("/api/cart");
    if (r.ok) { setRes(r); onCartLoaded(r.data); }
    return r;
  }

  useEffect(() => {
    reload().then(() => setLoading(false));
  }, []);

  function applyWrite(r: ApiResult<CartView>, pendingKind: Pending["kind"], itemId: string, key: string) {
    if (r.ok) {
      pending.current = null;
      setRes({ ok: true, data: r.data });
      onCartLoaded(r.data);
      setNotice(r.replayed ? "이미 처리된 요청이에요 (재전송 복원)" : null);
      return;
    }
    if (r.error.code === "OUTCOME_UNKNOWN") {
      // 커밋 여부 미확정 — 같은 키/항목을 보존하고 결과 조회로 복구한다.
      pending.current = { itemId, kind: pendingKind, key };
      setNotice("결과를 확인하지 못했어요. '결과 확인'으로 이어서 확인할 수 있어요.");
      return;
    }
    pending.current = null;
    if (r.error.code === "VERSION_CONFLICT") {
      setNotice("카트가 변경되었어요. 최신 상태로 다시 불러왔습니다.");
      reload();
      return;
    }
    setNotice("변경 실패: " + r.error.message);
  }

  async function changeQty(item: CartItemView, quantity: number) {
    if (busy || !res?.ok) return;
    setBusy(true);
    setNotice(null);
    const key = newActionKey();
    const r = await api<{ cart: CartView }>("/api/cart/items/" + item.cart_item_id, {
      method: "PATCH",
      body: JSON.stringify({
        quantity,
        expected_cart_version: res.data.version,
        expected_variant_version: item.variant_version,
        idempotency_key: key,
      }),
    });
    setBusy(false);
    applyWrite(
      r.ok ? { ok: true, data: r.data.cart, replayed: r.replayed } : r,
      "UPDATE_CART", item.cart_item_id, key,
    );
  }

  async function removeItem(item: CartItemView) {
    if (busy || !res?.ok) return;
    setBusy(true);
    setNotice(null);
    const key = newActionKey();
    const r = await api<{ cart: CartView }>("/api/cart/items/" + item.cart_item_id, {
      method: "DELETE",
      body: JSON.stringify({
        expected_cart_version: res.data.version,
        idempotency_key: key,
      }),
    });
    setBusy(false);
    applyWrite(
      r.ok ? { ok: true, data: r.data.cart, replayed: r.replayed } : r,
      "REMOVE_CART", item.cart_item_id, key,
    );
  }

  async function checkPending() {
    const p = pending.current;
    if (!p) return;
    const r = await api<{ status: string; result?: { cart?: CartView } }>(
      "/api/actions?kind=" + p.kind + "&idempotency_key=" + encodeURIComponent("ui-" + p.key),
    );
    if (r.ok && r.data.status === "SUCCEEDED" && r.data.result?.cart) {
      pending.current = null;
      setRes({ ok: true, data: r.data.result.cart });
      onCartLoaded(r.data.result.cart);
      setNotice("처리가 완료된 요청이었어요. 최신 상태로 반영했습니다.");
    } else if (r.ok && r.data.status === "REJECTED") {
      pending.current = null;
      setNotice("요청이 거절되었어요. 최신 상태를 확인해 주세요.");
      reload();
    } else {
      setNotice("아직 결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  if (loading) return <Loading />;
  if (!res) return null;
  if (!res.ok)
    return <ErrorState text="카트를 불러오지 못했어요" onRetry={() => location.reload()} />;
  const c = res.data;

  return (
    <div className="screen">
      {notice && <div className="state-box">{notice}</div>}
      {pending.current && (
        <button className="btn ghost" onClick={checkPending}>결과 확인</button>
      )}
      {c.items.length === 0 ? (
        <Empty
          text="장바구니가 비어 있어요"
          action={<button className="btn primary" onClick={onOpenShop}>쇼핑하러 가기</button>}
        />
      ) : (
        <>
          <ul className="cart-list">
            {c.items.map((i) => (
              <li key={i.cart_item_id} className="cart-item">
                <div className="cart-thumb">{i.product_name.slice(0, 1)}</div>
                <div className="cart-info">
                  <div>{i.product_name}</div>
                  <div className="muted">{Object.values(i.option_values).join(" · ")}</div>
                  {!i.purchasable && (
                    <div className="badge-soldout">{i.block_reason} — 주문할 수 없어요</div>
                  )}
                  <div className="qty-ctrl sm">
                    <button
                      aria-label={"수량 감소 " + i.cart_item_id}
                      disabled={busy || i.quantity <= 1}
                      onClick={() => changeQty(i, i.quantity - 1)}
                    >
                      −
                    </button>
                    <b>{i.quantity}</b>
                    <button
                      aria-label={"수량 증가 " + i.cart_item_id}
                      disabled={busy || i.quantity >= i_avail(i)}
                      onClick={() => changeQty(i, i.quantity + 1)}
                    >
                      +
                    </button>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => removeItem(i)}
                    >
                      삭제
                    </button>
                  </div>
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
            <div>
              {!c.can_checkout && (
                <div className="muted sm">주문 불가 항목을 삭제해 주세요</div>
              )}
              <button
                className="btn primary"
                disabled={!c.can_checkout}
                onClick={onCheckout}
              >
                주문하기
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 카트 뷰에는 stock이 없으므로 +버튼은 구매 가능 여부만 힌트로 쓴다.
// 실제 재고 초과는 서버가 OUT_OF_STOCK으로 막는다.
const i_avail = (i: CartItemView) => (i.purchasable ? Number.MAX_SAFE_INTEGER : 0);
