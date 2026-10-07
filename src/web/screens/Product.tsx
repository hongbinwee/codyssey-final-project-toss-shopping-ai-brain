// W02 상품 상세·옵션·리뷰
import { useEffect, useMemo, useState } from "react";
import { api, fmtWon, newActionKey, type ApiResult } from "../api.ts";
import type {
  CartView, MatchedVariant, ProductDetail, ReviewsResult,
 } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { PRODUCT_META, SPEC_LABEL } from "../display-meta.ts";

export function Product({
  productId,
  onOpenCart,
  onCartChanged,
}: {
  productId: string;
  onOpenCart: () => void;
  onCartChanged: (v: CartView) => void;
}) {
  const [detail, setDetail] = useState<ApiResult<ProductDetail> | null>(null);
  const [reviews, setReviews] = useState<ApiResult<ReviewsResult> | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [showAllReviews, setShowAllReviews] = useState(false);

  useEffect(() => {
    api<ProductDetail>("/api/products/" + productId).then(setDetail);
    api<ReviewsResult>("/api/products/" + productId + "/reviews").then(setReviews);
  }, [productId]);

  const selected: MatchedVariant | null = useMemo(
    () => detail?.ok ? detail.data.variants.find((v) => v.variant_id === variantId) ?? null : null,
    [detail, variantId],
  );

  async function add() {
    if (!selected || adding) return;
    setAdding(true);
    setFeedback(null);
    const key = actionKey ?? newActionKey();
    setActionKey(key); // 같은 행동의 재시도는 같은 키
    const cartRes = await api<CartView>("/api/cart");
    if (!cartRes.ok) {
      setAdding(false);
      setFeedback("카트를 확인하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    const r = await api<{ cart: CartView; changed_item_id: string }>("/api/cart/items", {
      method: "POST",
      body: JSON.stringify({
        variant_id: selected.variant_id,
        quantity: qty,
        expected_cart_version: cartRes.data.version,
        expected_variant_version: selected.version,
        idempotency_key: key,
      }),
    });
    setAdding(false);
    if (r.ok) {
      setFeedback("장바구니에 담았어요");
      onCartChanged(r.data.cart);
      setActionKey(null);
      // 재조회된 카트 버전으로 후속 행동이 정확한 버전을 쓰게 한다.
    } else if (r.error.code === "OUTCOME_UNKNOWN") {
      setFeedback("결과를 확인 중입니다… 잠시 후 카트에서 확인해 주세요.");
    } else {
      setFeedback("담기 실패: " + r.error.message);
      setActionKey(null);
    }
  }

  if (!detail) return <Loading />;
  if (!detail.ok) return <ErrorState text="상품을 불러오지 못했어요" />;
  const p = detail.data.product;
  const heroSrc = p.images?.[0] ?? "/assets/products/" + p.id + ".webp";

  return (
    <div className="screen">
      <div className="detail-hero">
        <img
          src={heroSrc}
          alt={p.name}
          onError={(e) => {
            // 이미지가 없으면 첫 글자 플레이스홀더로 대체한다.
            const el = e.currentTarget;
            el.style.display = "none";
            el.parentElement?.setAttribute("data-fallback", p.name.slice(0, 1));
          }}
        />
      </div>
      <h2 className="detail-name">{p.name}</h2>
      <div className="muted">{p.brand} · {p.description}</div>
      <div className="spec-chips">
        {Object.entries(p.specs).map(([k, v]) => (
          <span key={k} className="chip">{SPEC_LABEL[k] ?? k}: {v}</span>
        ))}
      </div>

      <h3 className="section-title">옵션 선택</h3>
      <div className="option-list">
        {detail.data.variants.map((v) => {
          const soldOut = v.availability !== "AVAILABLE";
          return (
            <button
              key={v.variant_id}
              className={"option-btn" + (variantId === v.variant_id ? " on" : "")}
              disabled={soldOut}
              onClick={() => { setVariantId(v.variant_id); setActionKey(null); setFeedback(null); }}
            >
              <span>
                {Object.values(v.option_values).join(" · ")}{" "}
              </span>
              <span>
                {fmtWon(v.unit_price_won)}
                {soldOut && <span className="badge-soldout"> {v.availability === "SOLD_OUT" ? "품절" : "판매 중단"}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="qty-row">
          <span>수량</span>
          <div className="qty-ctrl">
            <button onClick={() => setQty(Math.max(1, qty - 1))} disabled={qty <= 1}>−</button>
            <b>{qty}</b>
            <button onClick={() => setQty(qty + 1)}>+</button>
          </div>
          <span className="muted">재고 {selected.stock_qty}개</span>
        </div>
      )}
      <div className="muted">배송비 {fmtWon(detail.data.shipping_fee_won)}</div>

      <h3 className="section-title">리뷰</h3>
      {!reviews ? (
        <Loading text="리뷰 불러오는 중…" />
      ) : !reviews.ok ? (
        <ErrorState text="리뷰를 불러오지 못했어요" />
      ) : reviews.data.reviews.length === 0 ? (
        <Empty text="아직 리뷰가 없어요. 근거로 쓸 실사용 평가가 부족합니다." />
      ) : (
        <>
          <div className="review-summary muted">
            리뷰 {reviews.data.total_matching}개
            {reviews.data.has_more && " (일부만 표시)"}
          </div>
          <ul className="review-list">
            {(showAllReviews ? reviews.data.reviews : reviews.data.reviews.slice(0, 2)).map((r) => (
              <li key={r.id} className="review-item">
                <div>
                  <b>{"★".repeat(r.rating)}</b>{" "}
                  <span className="muted">{r.source_kind === "SYNTHETIC" ? "테스트 리뷰" : "실사용 리뷰"}</span>
                </div>
                <p>{r.body}</p>
                <span className="muted">id: {r.id}{r.variant_id ? " · 옵션 " + r.variant_id : ""}</span>
              </li>
            ))}
          </ul>
          {reviews.data.reviews.length > 2 && (
            <button className="link" onClick={() => setShowAllReviews(!showAllReviews)}>
              {showAllReviews ? "접기" : "리뷰 전체 보기"}
            </button>
          )}
        </>
      )}

      <div className="bottom-bar">
        <div>
          {selected ? (
            <>
              <div className="muted">{Object.values(selected.option_values).join(" · ")} × {qty}</div>
              <b>{fmtWon(selected.unit_price_won * qty)}</b>
            </>
          ) : (
            <span className="muted">옵션을 선택하세요</span>
          )}
        </div>
        <button className="btn primary" disabled={!selected || adding} onClick={add}>
          {adding ? "담는 중…" : "장바구니 담기"}
        </button>
      </div>
      {feedback && (
        <div className="toast">
          {feedback}
          {feedback.includes("담았") && (
            <button className="link" onClick={onOpenCart}>장바구니 보기</button>
          )}
        </div>
      )}
    </div>
  );
}
