// 검색 전용 필터 화면 — Ref105/106 [Observed]: 전용 전체화면(공용 BottomSheet 아님),
// 상단 탭(가격대·카테고리·브랜드·특징) + 섹션 칩 + 선택 시 '초기화' + 하단
// 'N개 상품 보기' 고정 CTA. 선택은 적용 전까지 draft — 뒤로가기는 폐기한다.
// 특징 섹션은 실제 데이터가 뒷받침되는 필터만 제공한다(할인=표시 메타 정가 기준,
// 품절 제외=서버 availability) — Ref의 미지원 특징을 흉내 내지 않는다 [Project].
import { useEffect, useRef, useState } from "react";
import type { ProductSummary } from "../../contracts.ts";
import { IcBack, IcChevronDown } from "../icons.tsx";
import { groupLabel } from "../display-meta.ts";
import {
  applySearchFilter,
  brandsIn,
  categoriesIn,
  EMPTY_FILTER,
  isEmptyFilter,
  PRICE_BANDS,
  type FilterDraft,
} from "../search-filter.ts";

const TABS = [
  { id: "price", label: "가격대" },
  { id: "cat", label: "카테고리" },
  { id: "brand", label: "브랜드" },
  { id: "feat", label: "특징" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const CHIP_COLLAPSE = 10; // 이 이상이면 '더 보기'로 접는다 [Ref 패턴]

export function SearchFilterPage({
  items,
  countState,
  onRetry,
  initial,
  onBack,
  onApply,
}: {
  // 호출부가 보유한 전체 결과 집합 — 부분 페이지를 넘기지 않는다.
  items: ProductSummary[];
  // 개수 상태 — 'loading'(로딩·부분 결과)과 'error'(조회 실패)를 구분한다.
  // 미확정 개수는 약속하지 않고 실패를 영구 로딩으로 표시하지 않는다 [PM].
  countState: "loading" | "error" | "ready";
  onRetry: () => void;
  initial: FilterDraft;
  onBack: () => void;
  onApply: (f: FilterDraft) => void;
}) {
  const [draft, setDraft] = useState<FilterDraft>(initial);
  const [tab, setTab] = useState<TabId>("price");
  const [moreCat, setMoreCat] = useState(false);
  const [moreBrand, setMoreBrand] = useState(false);
  // 배경 스크롤 잠금 — 공용 sheet/imageviewer의 lockScroll과 같은 패턴을
  // 전체화면에 최소 적용한다(열린 동안 뒤 페이지가 스크롤되지 않도록) [PM].
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  const secRef = {
    price: useRef<HTMLElement>(null),
    cat: useRef<HTMLElement>(null),
    brand: useRef<HTMLElement>(null),
    feat: useRef<HTMLElement>(null),
  };
  const cats = categoriesIn(items);
  const brands = brandsIn(items);
  const shownCats = moreCat ? cats : cats.slice(0, CHIP_COLLAPSE);
  const shownBrands = moreBrand ? brands : brands.slice(0, CHIP_COLLAPSE);
  const count = countState === "ready" ? applySearchFilter(items, draft).length : null;

  const pick = (key: "priceBand" | "category" | "brand", id: string) =>
    setDraft((d) => ({ ...d, [key]: d[key] === id ? null : id }));
  const flag = (key: "discountOnly" | "inStockOnly") =>
    setDraft((d) => ({ ...d, [key]: !d[key] }));
  const goTab = (t: TabId) => {
    setTab(t);
    secRef[t].current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="flt-screen" role="dialog" aria-label="필터">
      <header className="flt-head">
        <button type="button" className="back-btn" aria-label="뒤로가기" onClick={onBack}>
          <IcBack size={24} />
        </button>
        {!isEmptyFilter(draft) && (
          <button type="button" className="flt-reset" onClick={() => setDraft(EMPTY_FILTER)}>
            초기화
          </button>
        )}
      </header>
      <nav className="flt-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"flt-tab" + (tab === t.id ? " on" : "")}
            onClick={() => goTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flt-body">
        <section ref={secRef.price} className="flt-sec">
          <h3 className="flt-sec-t">가격대</h3>
          <div className="flt-chips">
            {PRICE_BANDS.map((b) => (
              <button
                key={b.id}
                type="button"
                className={"fchip" + (draft.priceBand === b.id ? " on" : "")}
                onClick={() => pick("priceBand", b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </section>

        {cats.length > 0 && (
          <section ref={secRef.cat} className="flt-sec">
            <h3 className="flt-sec-t">카테고리</h3>
            <div className="flt-chips">
              {shownCats.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={"fchip" + (draft.category === c ? " on" : "")}
                  onClick={() => pick("category", c)}
                >
                  {groupLabel(c)}
                </button>
              ))}
              {cats.length > CHIP_COLLAPSE && (
                <button type="button" className="fchip more" onClick={() => setMoreCat((v) => !v)}>
                  {moreCat ? "접기" : "더 보기"} <IcChevronDown size={13} />
                </button>
              )}
            </div>
          </section>
        )}

        {brands.length > 0 && (
          <section ref={secRef.brand} className="flt-sec">
            <h3 className="flt-sec-t">브랜드</h3>
            <div className="flt-chips">
              {shownBrands.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={"fchip" + (draft.brand === b.id ? " on" : "")}
                  onClick={() => pick("brand", b.id)}
                >
                  {b.id}
                </button>
              ))}
              {brands.length > CHIP_COLLAPSE && (
                <button type="button" className="fchip more" onClick={() => setMoreBrand((v) => !v)}>
                  {moreBrand ? "접기" : "더 보기"} <IcChevronDown size={13} />
                </button>
              )}
            </div>
          </section>
        )}

        <section ref={secRef.feat} className="flt-sec">
          <h3 className="flt-sec-t">특징</h3>
          <div className="flt-chips">
            <button
              type="button"
              className={"fchip" + (draft.discountOnly ? " on" : "")}
              onClick={() => flag("discountOnly")}
            >
              할인 상품만
            </button>
            <button
              type="button"
              className={"fchip" + (draft.inStockOnly ? " on" : "")}
              onClick={() => flag("inStockOnly")}
            >
              품절 제외
            </button>
          </div>
          {/* 할인은 SYNTHETIC 데모 정가 메타 기준 — 실제 가격 이력/검증된
              할인이 아님을 사용자에게도 보인다(코드 주석만으로 부족) [PM]. */}
          <p className="flt-note">
            * 할인은 데모 정가 표시 기준이에요 (실제 가격 이력이 아니에요)
          </p>
        </section>
      </div>

      <div className="flt-cta">
        {countState === "error" ? (
          <div className="flt-cta-err" role="alert">
            <span>상품 수를 확인하지 못했어요</span>
            <button type="button" className="flt-apply ghost" onClick={onRetry}>
              다시 시도
            </button>
          </div>
        ) : count === null ? (
          <button type="button" className="flt-apply" disabled>
            상품 수 확인 중…
          </button>
        ) : (
          <button type="button" className="flt-apply" onClick={() => onApply(draft)}>
            {count}개 상품 보기
          </button>
        )}
      </div>
    </div>
  );
}
