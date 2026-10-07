import { useState } from "react";
import type { ProductSummary } from "../../contracts.ts";
import { fmtWon } from "../api.ts";
import { IcStar } from "../icons.tsx";
import { PRODUCT_META } from "../display-meta.ts";

// 시드 image_urls가 모두 비어 있어, 없을 때는 로컬 생성 에셋을 convention으로 쓴다.
// DB에 실제 URL이 들어오면 p.image가 우선이고, 로컬 파일도 없으면 글자 플레이스홀더로 떨어진다.
const localImage = (id: string) => `/assets/products/${id}.webp`;

export function ProductCard({ p, onOpen }: { p: ProductSummary; onOpen: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const minPrice = Math.min(...p.matched_variants.map((v) => v.unit_price_won));
  const soldOut = p.availability === "SOLD_OUT";
  const src = p.image ?? localImage(p.product_id);
  // 표시용 메타: 정가/배송/배지는 카드 꾸밈일 뿐, 주문 가격은 항상 서버 값이 정본이다.
  const meta = PRODUCT_META[p.product_id];
  const orig = meta?.original_price_won;
  const rate = orig && orig > minPrice ? Math.round(((orig - minPrice) / orig) * 100) : 0;
  const flash = meta?.sections?.includes("flash-sale") && !soldOut;
  return (
    <button className="product-card" onClick={onOpen}>
      <div className="product-thumb">
      {imgErr ? (
        <span className="thumb-fallback">{p.name.slice(0, 1)}</span>
      ) : (
        <img src={src} alt={p.name} loading="lazy" onError={() => setImgErr(true)} />
      )}
      {soldOut && <span className="thumb-soldout">품절</span>}
      {flash && <span className="thumb-badge">특가</span>}
      </div>
      <div className="product-info">
        <div className="product-name">{p.name}</div>
        <div className="product-price">
          {rate > 0 && <span className="price-rate">{rate}%</span>}
          {fmtWon(minPrice)}
          {p.matched_variants.length > 1 && <span className="muted">~</span>}
        </div>
        {rate > 0 && <div className="price-orig">{fmtWon(orig!)}</div>}
        <div className="product-meta">
          {p.rating_summary.avg !== null && (
            <span>
              <IcStar size={12} /> {p.rating_summary.avg}{" "}
              <span className="muted">리뷰 {p.rating_summary.count}</span>
            </span>
          )}
          {meta?.delivery && <span className="delivery-tag">{meta.delivery}</span>}
        </div>
      </div>
    </button>
  );
}
