 import type { ProductSummary } from "../../contracts.ts";
import { fmtWon } from "../api.ts";

export function ProductCard({ p, onOpen }: { p: ProductSummary; onOpen: () => void }) {
  const minPrice = Math.min(...p.matched_variants.map((v) => v.unit_price_won));
  const soldOut = p.availability === "SOLD_OUT";
  return (
    <button className="product-card" onClick={onOpen}>
      <div className="product-thumb">{p.name.slice(0, 1)}</div>
      <div className="product-info">
        <div className="product-name">{p.name}</div>
        <div className="product-price">
          {fmtWon(minPrice)}{" "}
          {p.matched_variants.length > 1 && <span className="muted">~</span>}
        </div>
        <div className="product-meta">
          {p.rating_summary.avg !== null && (
            <span>★ {p.rating_summary.avg} · 리뷰 {p.rating_summary.count}</span>
          )}
          {soldOut && <span className="badge-soldout">품절</span>}
        </div>
      </div>
    </button>
  );
}
