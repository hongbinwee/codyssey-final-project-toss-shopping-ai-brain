import { useState } from "react";
import type { ProductSummary } from "../../contracts.ts";
import { fmtWon } from "../api.ts";
import { IcStar } from "../icons.tsx";

// 시드 image_urls가 모두 비어 있어, 없을 때는 로컬 생성 에셋을 convention으로 쓴다.
// DB에 실제 URL이 들어오면 p.image가 우선이고, 로컬 파일도 없으면 글자 플레이스홀더로 떨어진다.
const localImage = (id: string) => `/assets/products/${id}.webp`;

export function ProductCard({ p, onOpen }: { p: ProductSummary; onOpen: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const minPrice = Math.min(...p.matched_variants.map((v) => v.unit_price_won));
  const soldOut = p.availability === "SOLD_OUT";
  const src = p.image ?? localImage(p.product_id);
  return (
    <button className="product-card" onClick={onOpen}>
      <div className="product-thumb">
      {imgErr ? (
        <span className="thumb-fallback">{p.name.slice(0, 1)}</span>
      ) : (
        <img src={src} alt={p.name} loading="lazy" onError={() => setImgErr(true)} />
      )}
      {soldOut && <span className="thumb-soldout">품절</span>}
      </div>
      <div className="product-info">
        <div className="product-name">{p.name}</div>
        <div className="product-price">
          {fmtWon(minPrice)}
          {p.matched_variants.length > 1 && <span className="muted">~</span>}
        </div>
        <div className="product-meta">
          {p.rating_summary.avg !== null && (
            <span>
              <IcStar size={12} /> {p.rating_summary.avg}{" "}
              <span className="muted">리뷰 {p.rating_summary.count}</span>
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
