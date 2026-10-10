// W04 주문서·모의 결제·완료 (UI 전용 — Agent가 호출할 수 없는 checkout 경로).
// 견적(5분 서명 토큰) → 확인 클릭 → Processing → 성공 시 W06 주문 상세로 이동.
// 같은 클릭 행동의 재시도는 같은 idempotency key를 쓰고, 견적이 바뀌면 새 키를 쓴다
// (토큰 해시가 payload라 같은 키+다른 견적은 IDEMPOTENCY_CONFLICT가 된다).
import { useEffect, useRef, useState } from "react";
import { api, apiSafe, fmtWon, newActionKey, type ApiResult } from "../api.ts";
import type { CheckoutQuoteView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";

type Phase = "confirm" | "processing" | "error";

export function Checkout({
  onOpenOrder,
  onOpenCart,
}: {
  onOpenOrder: (orderId: string) => void;
  onOpenCart: () => void;
}) {
  const [quote, setQuote] = useState<ApiResult<CheckoutQuoteView> | null>(null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [notice, setNotice] = useState<string | null>(null);
  const actionKey = useRef<string | null>(null);
  const pendingKey = useRef<string | null>(null);

  async function loadQuote() {
    const r = await apiSafe<CheckoutQuoteView>("/api/checkout/quote");
    setQuote(r);
    if (r.ok) actionKey.current = newActionKey(); // 새 견적 = 새 행동 키
    return r;
  }
  useEffect(() => {
    loadQuote().then((r) => {
      if (r.ok && r.data.cart.items.length === 0)
        setNotice("주문할 상품이 없어요. 장바구니에서 담아 주세요.");
    });
  }, []);

  async function confirm() {
    if (!quote?.ok || phase === "processing") return;
    const key = actionKey.current ?? newActionKey();
    actionKey.current = key;
    setPhase("processing");
    setNotice(null);
    let r: ApiResult<{ order_id: string; total_won: number }> | null = null;
    try {
      r = await api<{ order_id: string; total_won: number }>(
        "/api/checkout/confirm",
        {
          method: "POST",
          body: JSON.stringify({
            quote_token: quote.data.quote_token,
            idempotency_key: key,
          }),
        },
      );
    } catch {
      r = null; // transport/timeout — 서버 커밋 여부 불확정 → 결과 조회 경로
    }
    if (r?.ok) {
      onOpenOrder(r.data.order_id); // W04 완료 → W06
      return;
    }
    setPhase("error");
    if (!r || r.error.code === "OUTCOME_UNKNOWN") {
      pendingKey.current = key;
      setNotice("주문 결과를 확인하지 못했어요. 결과 확인으로 이어서 확인할 수 있어요.");
      return;
    }
    if (r.error.code === "STALE_QUOTE" || r.error.code === "CART_BLOCKED") {
      // 카트/가격/재고 변동 — 새 견적(새 키)으로 다시 확인하게 한다.
      setNotice(r.error.message);
      setPhase("confirm");
      await loadQuote();
      return;
    }
    setNotice("주문 실패: " + r.error.message);
  }

  async function checkPending() {
    const key = pendingKey.current;
    if (!key) return;
    const r = await apiSafe<{ status: string; result?: { order_id?: string } }>(
      "/api/actions?kind=CHECKOUT&idempotency_key=" + encodeURIComponent("ui-" + key),
    );
    if (r.ok && r.data.status === "SUCCEEDED" && r.data.result?.order_id) {
      onOpenOrder(r.data.result.order_id);
      return;
    }
    if (r.ok && r.data.status === "REJECTED") {
      pendingKey.current = null;
      setNotice("주문이 거절되었어요. 견적을 새로 받아 다시 확인해 주세요.");
      setPhase("confirm");
      await loadQuote();
      return;
    }
    setNotice("아직 결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
  }

  if (!quote) return <Loading text="주문서를 준비하는 중…" />;
  if (!quote.ok)
    return (
      <ErrorState
        text={quote.error.message}
        onRetry={() => { setQuote(null); loadQuote(); }}
      />
    );
  const c = quote.data.cart;

  return (
    <div className="screen">
      <h2 className="section-title">주문서</h2>
      {notice && <div className="state-box">{notice}</div>}
      {pendingKey.current && (
        <button className="btn ghost" onClick={checkPending}>결과 확인</button>
      )}
      {c.items.length === 0 ? (
        <Empty
          text="주문할 상품이 없어요"
          action={<button className="btn primary" onClick={onOpenCart}>장바구니로</button>}
        />
      ) : (
        <>
          <ul className="cart-list">
            {c.items.map((i) => (
              <li key={i.cart_item_id} className="cart-item">
                <div className="cart-thumb">{i.product_name.slice(0, 1)}</div>
                <div className="cart-info">
                  <div>{i.product_name}</div>
                  <div className="muted">
                    {Object.values(i.option_values).join(" · ")} · {i.quantity}개
                  </div>
                </div>
                <div className="cart-right"><b>{fmtWon(i.unit_price_won * i.quantity)}</b></div>
              </li>
            ))}
          </ul>

          <div className="checkout-block">
            <h3 className="section-title">배송지 (테스트)</h3>
            <div>{quote.data.address.name} · {quote.data.address.phone}</div>
            <div className="muted">
              {quote.data.address.address} {quote.data.address.detail}
            </div>
          </div>

          <div className="checkout-block">
            <h3 className="section-title">결제</h3>
            <div className="muted sm">모의 결제 — 실제 결제는 발생하지 않아요</div>
            <div className="muted">
              상품 {fmtWon(c.items_total_won)} + 배송비 {fmtWon(c.shipping_fee_won)}
            </div>
          </div>

          <div className="bottom-bar">
            <div>
              <div className="muted">총 결제 금액</div>
              <b>{fmtWon(c.total_won)}</b>
            </div>
            <button
              className="btn primary"
              disabled={phase === "processing"}
              onClick={confirm}
            >
              {phase === "processing" ? "결제 처리 중…" : fmtWon(c.total_won) + " 결제하기"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
