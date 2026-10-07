// 쇼핑 홈 — 카테고리 그룹 탭 + 특가 레일 + AI 진입 카드 + 상품 그리드.
// 탭의 category prop은 display-meta의 상위 그룹 id(digital/beauty/...)이며,
// 상품은 한 번만 불러와 클라이언트에서 그룹으로 나눈다 (demo 규모 ~28개).
import { useEffect, useState } from "react";
import { api, type ApiResult } from "../api.ts";
import type { ProductSummary, SearchResult } from "../../contracts.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { Empty, ErrorState } from "../components/CommerceState.tsx";
import { IcSparkle } from "../icons.tsx";
import { CATEGORY_GROUPS, SECTION_LABEL, PRODUCT_META, groupOf, groupLabel } from "../display-meta.ts";

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
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    api<SearchResult>("/api/products?limit=50")
      .then(setRes)
      .finally(() => setLoading(false));
  }, [tick]);

  const items = res?.ok ? res.data.items : [];
  // 상품이 실제 있는 그룹만 탭으로 만든다.
  const groups = CATEGORY_GROUPS.filter((g) =>
    items.some((i) => groupOf(i.category) === g.id),
  );
  const shown = category
    ? items.filter((i) => groupOf(i.category) === category)
    : items;
  // 홈 상단 특가 레일 — static sectionTags 기반(추천 엔진 없음, 04-C에서 확장)
  const flash =
    category === ""
      ? items.filter(
          (i) =>
            i.availability !== "SOLD_OUT" &&
            PRODUCT_META[i.product_id]?.sections?.includes("flash-sale"),
        )
      : [];

  return (
    <div className="screen">
      {groups.length > 0 && (
        <div className="cat-tabs">
          <button
            className={"cat-tab" + (category === "" ? " on" : "")}
            onClick={() => onCategory("")}
          >
            전체
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              className={"cat-tab" + (category === g.id ? " on" : "")}
              onClick={() => onCategory(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {flash.length > 0 && (
        <section className="rail-sec">
          <h3 className="section-h rail-h">{SECTION_LABEL["flash-sale"]}</h3>
          <div className="rail">
            {flash.map((p: ProductSummary) => (
              <ProductCard
                key={p.product_id}
                p={p}
                onOpen={() => onOpenProduct(p.product_id)}
              />
            ))}
          </div>
        </section>
      )}

      <button className="ai-entry" onClick={onOpenAgent}>
        <span className="ai-entry-ico" aria-hidden><IcSparkle size={22} /></span>
        <span>
          <b>AI에게 조건 말하고 비교받기</b>
          <span className="ai-entry-sub">예산·용도만 말하면 상품을 찾아 비교해줘요</span>
        </span>
      </button>

      <h3 className="section-h">
        {category ? groupLabel(category) : "전체 상품"}
      </h3>

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
        ) : shown.length === 0 ? (
          <Empty text="조건에 맞는 상품이 없어요" />
        ) : (
          <div className="product-grid">
            {shown.map((p) => (
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
