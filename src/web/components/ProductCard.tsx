import { useState } from "react";
import type { ProductSummary } from "../../contracts.ts";
import { fmtWon } from "../api.ts";
import { IcCart, IcEye, IcStar } from "../icons.tsx";
import {
  PRODUCT_META,
  PRODUCT_SIGNALS,
  cardMinPriceOf,
  fmtViewerCount,
  lowest30dFor,
  rateOf,
} from "../display-meta.ts";

// 시드 image_urls가 모두 비어 있어, 없을 때는 로컬 생성 에셋을 convention으로 쓴다.
// DB에 실제 URL이 들어오면 p.image가 우선이고, 로컬 파일도 없으면 글자 플레이스홀더로 떨어진다.
const localImage = (id: string) => `/assets/products/${id}.webp`;

export function ProductCard({
  p,
  onOpen,
  variant,
  hideCommerce = false,
}: {
  p: ProductSummary;
  onOpen: () => void;
  variant?: "search";
  hideCommerce?: boolean;
}) {
  const [imgErr, setImgErr] = useState(false);
  const isSearch = variant === "search";
  // 빈 matched_variants는 카드 전용 nullable 헬퍼로 '가격 정보 없음' [F03] —
  // 전역 minPriceOf(빈 배열 → Infinity) 계약은 건드리지 않는다.
  const minPrice = cardMinPriceOf(p);
  const soldOut = p.availability === "SOLD_OUT";
  const src = p.image ?? localImage(p.product_id);
  // 표시용 메타: 정가/배송/배지는 카드 꾸밈일 뿐, 주문 가격은 항상 서버 값이 정본이다.
  const meta = PRODUCT_META[p.product_id];
  const rate = rateOf(p);
  // 보조 지표 — 출처가 명시된 SYNTHETIC 데모 값. 없는 상품은 행을 숨긴다.
  const sig = PRODUCT_SIGNALS[p.product_id];
  const views = sig?.view_count;
  const lowest = lowest30dFor(p);
  const hasRating = p.rating_summary.avg !== null;
  return (
    <button className={"product-card" + (isSearch ? " search" : "")} onClick={onOpen}>
      <div className="product-thumb">
      {imgErr ? (
        <span className="thumb-fallback">{p.name.slice(0, 1)}</span>
      ) : (
        <img src={src} alt={p.name} loading="lazy" onError={() => setImgErr(true)} />
      )}
      {soldOut && <span className="thumb-soldout">품절</span>}
      {!soldOut && rate > 0 && <span className="thumb-badge">{rate}% 특가</span>}
      {/* 검색 카드의 쇼핑백 윤곽은 이미지 안 우하단 [Observed search/103] — 장식 */}
      {isSearch && !soldOut && (
        <span className="thumb-cart" aria-hidden><IcCart size={20} /></span>
      )}
      </div>
      <div className="product-info">
        {/* 검색 카드의 최저가는 상품명 위 다크 배너 [Observed search/103] */}
        {isSearch && lowest && (
          <div
            className="search-lowest"
            data-source={lowest.source}
            title="시연용 합성 가격 이력 지표"
          >
            지금 30일 내 최저가예요
            {lowest.source === "SYNTHETIC" && <small className="signal-demo">데모</small>}
          </div>
        )}
        <div className="product-name">{p.name}</div>
        <div className="product-price">
          {minPrice === null ? (
            <span className="price-none">가격 정보 없음</span>
          ) : (
            <>
              {rate > 0 && <span className="price-rate">{rate}%</span>}
              {fmtWon(minPrice)}
              {p.matched_variants.length > 1 && <span className="muted">~</span>}
            </>
          )}
        </div>
        {/* 그리드 카드는 정가 취소선 없음 [Observed home/02] — 특가 DealCard만 사용 */}
        {!isSearch && lowest && (
          <div
            className="product-lowest"
            data-source={lowest.source}
            title="시연용 합성 가격 이력 지표"
          >
            지금 30일 내 최저가 <span aria-hidden>↓</span>
            {lowest.source === "SYNTHETIC" && <small className="signal-demo">데모</small>}
          </div>
        )}
        {((!isSearch && views) || hasRating) && (
          <div className="product-meta">
            {!isSearch && views && (
              <span
                className="meta-item"
                data-source={views.source}
                title={"시연용 합성 지표 · 최근 " + views.window_days + "일 고유 방문자"}
              >
                <IcEye size={13} className="meta-eye" /> {fmtViewerCount(views.unique_viewers)}
                {views.source === "SYNTHETIC" && <small className="signal-demo">데모</small>}
              </span>
            )}
            {!isSearch && views && hasRating && <span className="meta-sep" aria-hidden />}
            {hasRating && (
              <span className="meta-item">
                <IcStar size={12} className="meta-star" /> {p.rating_summary.avg}{" "}
                <span className="muted">({p.rating_summary.count})</span>
              </span>
            )}
          </div>
        )}
        {meta?.delivery && (
          <div className="product-chips">
            <span className="product-chip">{meta.delivery}</span>
          </div>
        )}
      </div>
      {!isSearch && !hideCommerce && <span className="card-cart" aria-hidden><IcCart size={21} /></span>}
    </button>
  );
}
