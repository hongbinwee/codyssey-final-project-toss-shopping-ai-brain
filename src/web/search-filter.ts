// 검색 전용 필터 — 전용 전체화면(draft → apply/reset/back)과 결과 리스트가 공유하는
// 순수 계산 모듈 [PMQA-071 F02]. BottomSheet가 아닌 Ref105/106의 전용 화면 구조다.
//
// 정직 계약:
// - 가격대 라벨은 Ref105/106 관측값 [Observed] — 경계 규칙은 미관측이라 반개구간
//   (이하≤, 구간 >lo~≤hi, 이상≥) [Project].
// - 가격대는 **variant 단위** 매칭이다 — 상품이 남으면 표시 variants도 밴드 안으로
//   좁힌다. 1만원+5만원 옵션 상품이 '2만원~6만원'이면 표시 최저가는 5만원이다
//   (minPriceOf·PRICE_ASC와 같은 계산 경로 — 상한만으로 잘못 표시하지 않는다) [Luna].
// - availability·품절제외도 좁힌 variant 집합 기준이다 — 밴드 밖 재고 옵션이
//   상품을 구매 가능한 것처럼 통과시키지 않는다(서버 productAvailability와
//   동일 규칙으로 재계산) [PM].
// - PRICE_ASC는 서버의 상품 전체 최저가 정렬과 별개로, 밴드가 적용되면
//   필터된 variants의 최저가로 클라이언트가 재정렬한다(stable 유지) [PM].
// - 선택지는 실제 결과 데이터에 존재하는 category(그룹)/brand만 제공한다 —
//   없는 브랜드·도착보장·포인트 같은 미지원 계약은 만들지 않는다.
// - 개수는 로드된 전체 결과 집합 기준 — 호출부가 has_more/로딩을 검사해
//   미완료 페이지 수를 최종 수로 표시하지 않는다.
import type { Availability, MatchedVariant, ProductSummary } from "../contracts.ts";
import { CATEGORY_GROUPS, groupOf, PRODUCT_META } from "./display-meta.ts";

export interface FilterDraft {
  priceBand: string | null;
  category: string | null;
  brand: string | null;
  discountOnly: boolean;
  inStockOnly: boolean;
}
export const EMPTY_FILTER: FilterDraft = {
  priceBand: null,
  category: null,
  brand: null,
  discountOnly: false,
  inStockOnly: false,
};
export const isEmptyFilter = (f: FilterDraft): boolean =>
  !f.priceBand && !f.category && !f.brand && !f.discountOnly && !f.inStockOnly;
export const countActiveFilters = (f: FilterDraft): number =>
  (f.priceBand ? 1 : 0) + (f.category ? 1 : 0) + (f.brand ? 1 : 0) +
  (f.discountOnly ? 1 : 0) + (f.inStockOnly ? 1 : 0);

export interface PriceBand {
  id: string;
  label: string;
  minEx?: number; // > minEx
  minIn?: number; // >= minIn
  maxIn?: number; // <= maxIn
  maxEx?: number; // < maxEx
}
// Ref105/106 [Observed 라벨, 경계 규칙은 Project] — 인접 밴드가 겹치지 않는다.
export const PRICE_BANDS: PriceBand[] = [
  { id: "b1", label: "2만원 이하", maxIn: 20000 },
  { id: "b2", label: "2만원 ~ 6만원", minEx: 20000, maxIn: 60000 },
  { id: "b3", label: "6만원 ~ 10만원", minEx: 60000, maxIn: 100000 },
  { id: "b4", label: "10만원 ~ 14만원", minEx: 100000, maxEx: 140000 },
  { id: "b5", label: "14만원 이상", minIn: 140000 },
];
export const bandById = (id: string | null): PriceBand | null =>
  PRICE_BANDS.find((b) => b.id === id) ?? null;
export const bandMatch = (b: PriceBand, price: number): boolean =>
  (b.minEx === undefined || price > b.minEx) &&
  (b.minIn === undefined || price >= b.minIn) &&
  (b.maxIn === undefined || price <= b.maxIn) &&
  (b.maxEx === undefined || price < b.maxEx);

export const minVariantPrice = (vs: MatchedVariant[]): number | null =>
  vs.length ? Math.min(...vs.map((v) => v.unit_price_won)) : null;

// 서버 productAvailability(catalog.ts)와 같은 규칙을 좁힌 집합에 적용 —
// 밴드로 variants가 줄어든 뒤의 구매 가능 여부를 이 집합으로 판정한다.
const filteredAvailability = (vs: MatchedVariant[]): Availability => {
  if (vs.length === 0) return "UNAVAILABLE";
  if (vs.some((v) => v.availability === "AVAILABLE")) return "AVAILABLE";
  if (vs.every((v) => v.availability === "SOLD_OUT")) return "SOLD_OUT";
  return "UNAVAILABLE";
};

// '할인' 판정은 SYNTHETIC 데모 표시 메타(PRODUCT_META.original_price_won)
// 기준이다 — 실제 가격 이력·정가 검증 계약이 없으므로 UI/문서에서
// '검증된 실제 할인'으로 표현하지 않는다 [PM]. 비교가격은 필터로 좁혀진
// matched_variants의 최저가라 밴드 적용 후에도 일관된다.
const hasDiscount = (p: ProductSummary): boolean => {
  const o = PRODUCT_META[p.product_id]?.original_price_won;
  const m = minVariantPrice(p.matched_variants);
  return o != null && m != null && o > m;
};

// 필터는 언제나 호출부가 넘긴 '전체 결과 집합'에 적용한다 — 새 객체를 반환하고
// 입력 items/matched_variants는 변이하지 않는다.
// opts.minPriceSort: 서버 PRICE_ASC는 상품 전체 최저가 기준이라 밴드로
// variants가 좁혀지면 표시 최저가 순서와 어긋날 수 있다 — 필터된 variants의
// 최저가로 재정렬한다(Array.sort는 stable — 동일 최저가는 서버 순서 유지).
export const applySearchFilter = (
  items: ProductSummary[],
  f: FilterDraft,
  opts?: { minPriceSort?: boolean },
): ProductSummary[] => {
  const band = bandById(f.priceBand);
  const out = items
    .map((p) => {
      const vs = band
        ? p.matched_variants.filter((v) => bandMatch(band, v.unit_price_won))
        : p.matched_variants;
      return {
        ...p,
        // 밴드가 있으면 표시 variants도 밴드 내로 좁힌다 — 표시 최저가가
        // 밴드 밖 저가 옵션을 가리키지 않는다.
        matched_variants: vs,
        // 표시 availability도 좁힌 집합 기준 — 밴드 안에 남은 옵션이
        // 전부 품절이면 상품도 품절로 다시 계산한다 [PM].
        availability: band ? filteredAvailability(vs) : p.availability,
      };
    })
    .filter((p) => {
      if (band && p.matched_variants.length === 0) return false;
      if (f.category && groupOf(p.category) !== f.category) return false;
      if (f.brand && p.brand !== f.brand) return false;
      if (f.discountOnly && !hasDiscount(p)) return false;
      // '품절 제외'는 좁힌 variant 집합 기준 — 상품 레벨 availability는
      // 밴드 밖 옵션까지 섞여 있어 오판할 수 있다 [PM].
      if (
        f.inStockOnly &&
        !p.matched_variants.some((v) => v.availability === "AVAILABLE")
      )
        return false;
      return true;
    });
  if (opts?.minPriceSort) {
    out.sort(
      (a, b) =>
        (minVariantPrice(a.matched_variants) ?? Number.MAX_SAFE_INTEGER) -
        (minVariantPrice(b.matched_variants) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return out;
};

// 결과에 실제 존재하는 카테고리 그룹만 — 알 수 없는 원문 category도 그대로 둔다.
export const categoriesIn = (items: ProductSummary[]): string[] => {
  const set = new Set(items.map((i) => groupOf(i.category)));
  const known = CATEGORY_GROUPS.filter((g) => set.has(g.id)).map((g) => g.id);
  const extra = [...set].filter((id) => !CATEGORY_GROUPS.some((g) => g.id === id));
  return [...known, ...extra];
};

// 결과에 실제 존재하는 브랜드만, 개수 내림차순→이름순.
export const brandsIn = (items: ProductSummary[]): { id: string; count: number }[] => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.brand, (m.get(i.brand) ?? 0) + 1);
  return [...m.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id, "ko"));
};
