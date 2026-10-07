// 쇼핑 홈 — 카테고리 탭 + AI 진입 카드 + 상품 그리드. 검색은 #/search로 이동한다.
import { useEffect, useState } from "react";
import { api, type ApiResult } from "../api.ts";
import type { SearchResult } from "../../contracts.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { Empty, ErrorState } from "../components/CommerceState.tsx";
import { IcSparkle } from "../icons.tsx";

const CAT_LABEL: Record<string, string> = { monitor: "모니터" };
const catLabel = (c: string) => CAT_LABEL[c] ?? c;

export function Shopping({
  category,
  onCategory,
  onOpenProduct,
  onOpenAgent,
}: {
  category: string;
  onCategory: (c: string) => void;
  onOpenProduct: (id: string) => void;
  onOpenAgent: () => void;
}) {
  const [res, setRes] = useState<ApiResult<SearchResult> | null>(null);
  const [loading, setLoading] = useState(true);
  const [cats, setCats] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    api<SearchResult>(
      "/api/products" + (category ? "?category=" + encodeURIComponent(category) : ""),
    )
      .then((r) => {
        setRes(r);
        // 탭 목록은 첫 성공 응답에서 한 번만 채운다 (필터링된 응답으로 덮지 않기 위함)
        setCats((prev) =>
          prev.length || !r.ok
            ? prev
            : [...new Set(r.data.items.map((i) => i.category))],
        );
      })
      .finally(() => setLoading(false));
  }, [category, tick]);

  return (
    <div className="screen">
      {cats.length > 0 && (
        <div className="cat-tabs">
          <button
            className={"cat-tab" + (category === "" ? " on" : "")}
            onClick={() => onCategory("")}
          >
            전체
          </button>
          {cats.map((c) => (
            <button
              key={c}
              className={"cat-tab" + (category === c ? " on" : "")}
              onClick={() => onCategory(c)}
            >
              {catLabel(c)}
            </button>
          ))}
        </div>
      )}

      <button className="ai-entry" onClick={onOpenAgent}>
        <span className="ai-entry-ico" aria-hidden><IcSparkle size={22} /></span>
        <span>
          <b>AI에게 조건 말하고 비교받기</b>
          <span className="ai-entry-sub">예산·용도만 말하면 상품을 찾아 비교해줘요</span>
        </span>
      </button>

      <h3 className="section-h">전체 상품</h3>

      {loading ? (
        <div className="product-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skel-card">
              <div className="skel-thumb" />
              <div className="skel-line" />
              <div className="skel-line sm" />
            </div>
          ))}
        </div>
      ) : !res ? null : !res.ok ? (
        <ErrorState
          text={"조회에 실패했어요 (" + res.error.code + ")"}
          onRetry={() => setTick((t) => t + 1)}
        />
      ) : res.data.items.length === 0 ? (
        <Empty text="조건에 맞는 상품이 없어요" />
      ) : (
        <div className="product-grid">
          {res.data.items.map((p) => (
            <ProductCard
              key={p.product_id}
              p={p}
              onOpen={() => onOpenProduct(p.product_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
