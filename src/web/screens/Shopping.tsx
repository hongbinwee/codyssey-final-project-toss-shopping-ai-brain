// W01 쇼핑 홈·검색 결과
import { useEffect, useState } from "react";
import { api, type ApiResult } from "../api.ts";
 import type { ProductSummary, SearchResult } from "../../contracts.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";

export function Shopping({
  query,
  onSearch,
  onOpenProduct,
  onOpenAgent,
}: {
  query: string;
  onSearch: (q: string) => void;
  onOpenProduct: (id: string) => void;
  onOpenAgent: () => void;
}) {
  const [res, setRes] = useState<ApiResult<SearchResult> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api<SearchResult>("/api/products?query=" + encodeURIComponent(query))
      .then(setRes)
      .finally(() => setLoading(false));
  }, [query]);

  return (
    <div className="screen">
      <button className="ai-entry" onClick={onOpenAgent}>
        🤖 AI에게 조건 말하고 비교받기
      </button>
      {query && (
        <div className="query-summary">
          검색: <b>{query}</b>
          <button className="link" onClick={() => onSearch("")}>초기화</button>
        </div>
      )}
      {loading ? (
        <Loading />
      ) : !res ? null : !res.ok ? (
        <ErrorState
          text={"조회에 실패했어요 (" + res.error.code + ")"}
          onRetry={() => onSearch(query)}
        />
      ) : res.data.items.length === 0 ? (
        <Empty
          text="조건에 맞는 상품이 없어요"
          action={
            <button className="btn ghost" onClick={() => onSearch("")}>전체 상품 보기</button>
          }
        />
      ) : (
        <div className="product-grid">
          {res.data.items.map((p) => (
            <ProductCard key={p.product_id} p={p} onOpen={() => onOpenProduct(p.product_id)} />
          ))}
        </div>
      )}
    </div>
  );
}
