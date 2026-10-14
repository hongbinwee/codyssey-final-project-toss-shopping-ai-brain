// search-filter — PM 지정 회귀: 밴드로 좁힌 variant 집합 기준의
// availability·품절제외·가격 재정렬이 맞는지 함수 수준(DB-free)으로 검증한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const {
  applySearchFilter,
  bandById,
  bandMatch,
  brandsIn,
  categoriesIn,
  countActiveFilters,
  EMPTY_FILTER,
  isEmptyFilter,
  minVariantPrice,
  PRICE_BANDS,
} = await import("../../src/web/search-filter.ts");
import type { MatchedVariant, ProductSummary } from "../../src/contracts.ts";
import type { FilterDraft } from "../../src/web/search-filter.ts";

const mkV = (
  price: number,
  availability: MatchedVariant["availability"] = "AVAILABLE",
  id = "v",
): MatchedVariant => ({
  variant_id: id,
  option_values: {},
  effective_specs: {},
  unit_price_won: price,
  stock_qty: availability === "AVAILABLE" ? 5 : 0,
  availability,
  version: 1,
});

const mkP = (
  id: string,
  variants: MatchedVariant[],
  over: Partial<ProductSummary> = {},
): ProductSummary => ({
  product_id: id,
  name: id,
  brand: "브랜드",
  category: "digital",
  image: null,
  matched_variants: variants,
  rating_summary: { avg: null, count: 0 },
  // 상품 레벨 availability는 서버 규칙(catalog.ts productAvailability)대로
  // 전체 variant 집합에서 미리 계산해 둔다.
  availability:
    variants.length === 0
      ? "UNAVAILABLE"
      : variants.some((v) => v.availability === "AVAILABLE")
        ? "AVAILABLE"
        : variants.every((v) => v.availability === "SOLD_OUT")
          ? "SOLD_OUT"
          : "UNAVAILABLE",
  ...over,
});

const f = (over: Partial<FilterDraft> = {}): FilterDraft => ({
  ...EMPTY_FILTER,
  ...over,
});

describe("PRICE_BANDS 경계", () => {
  test("반개구간 — 이하≤·구간 (lo,hi]·이상≥이 인접 밴드와 겹치지 않는다", () => {
    const b = (id: string) => bandById(id)!;
    assert.ok(bandMatch(b("b1"), 20000));
    assert.ok(!bandMatch(b("b1"), 20001));
    assert.ok(bandMatch(b("b2"), 20001));
    assert.ok(bandMatch(b("b2"), 60000));
    assert.ok(!bandMatch(b("b2"), 60001));
    assert.ok(bandMatch(b("b3"), 100000));
    assert.ok(!bandMatch(b("b3"), 100001));
    assert.ok(bandMatch(b("b4"), 139999));
    assert.ok(!bandMatch(b("b4"), 140000));
    assert.ok(bandMatch(b("b5"), 140000));
    assert.equal(PRICE_BANDS.length, 5);
  });
});

describe("가격대 — variant 단위 매칭", () => {
  test("1만+5만 상품에 2~6만원 → 남고 표시 variants는 5만원 하나로 좁혀진다", () => {
    const p = mkP("p", [
      mkV(10000, "AVAILABLE", "v1"),
      mkV(50000, "AVAILABLE", "v2"),
    ]);
    const out = applySearchFilter([p], f({ priceBand: "b2" }));
    assert.equal(out.length, 1);
    assert.deepEqual(
      out[0].matched_variants.map((v) => v.variant_id),
      ["v2"],
    );
    assert.equal(minVariantPrice(out[0].matched_variants), 50000);
  });
  test("밴드에 드는 variant가 하나도 없으면 상품 제외", () => {
    const p = mkP("p", [mkV(10000), mkV(15000)]);
    assert.equal(applySearchFilter([p], f({ priceBand: "b2" })).length, 0);
  });
});

describe("품절 제외 — 좁힌 variant 집합 기준 [PM]", () => {
  test("1만 AVAILABLE + 5만 SOLD_OUT에 2~6만+품절제외 → 제외된다", () => {
    const p = mkP("p", [
      mkV(10000, "AVAILABLE", "v1"),
      mkV(50000, "SOLD_OUT", "v2"),
    ]);
    const out = applySearchFilter(
      [p],
      f({ priceBand: "b2", inStockOnly: true }),
    );
    assert.equal(out.length, 0);
  });
  test("밴드만 적용해도 남은 variant가 전부 품절이면 availability=SOLD_OUT", () => {
    const p = mkP("p", [
      mkV(10000, "AVAILABLE", "v1"),
      mkV(50000, "SOLD_OUT", "v2"),
    ]);
    const out = applySearchFilter([p], f({ priceBand: "b2" }));
    assert.equal(out.length, 1);
    assert.equal(out[0].availability, "SOLD_OUT");
  });
  test("밴드 안에 AVAILABLE이 남으면 품절제외를 통과한다", () => {
    const p = mkP("p", [
      mkV(50000, "SOLD_OUT", "v1"),
      mkV(55000, "AVAILABLE", "v2"),
    ]);
    const out = applySearchFilter(
      [p],
      f({ priceBand: "b2", inStockOnly: true }),
    );
    assert.equal(out.length, 1);
  });
  test("밴드 없이 품절제외 — 구매 가능 variant가 없으면 제외", () => {
    const p = mkP("p", [mkV(30000, "SOLD_OUT")]);
    assert.equal(applySearchFilter([p], f({ inStockOnly: true })).length, 0);
  });
});

describe("가격 정렬 — 필터된 variants 최저가 [PM]", () => {
  test("서버 전체 min 정렬이 밴드 뒤 역전되지 않게 필터 min으로 재정렬한다", () => {
    const p1 = mkP("p1", [
      mkV(10000, "AVAILABLE", "v1"),
      mkV(55000, "AVAILABLE", "v2"),
    ]);
    const p2 = mkP("p2", [mkV(30000, "AVAILABLE", "v1")]);
    // 서버 PRICE_ASC 입력 순서: p1(전체 min 1만) < p2(3만)
    const keep = applySearchFilter([p1, p2], f({ priceBand: "b2" }));
    assert.deepEqual(
      keep.map((x) => x.product_id),
      ["p1", "p2"],
    );
    // 밴드 뒤 표시 min: p1=5.5만 > p2=3만 → 재정렬하면 p2가 먼저
    const sorted = applySearchFilter([p1, p2], f({ priceBand: "b2" }), {
      minPriceSort: true,
    });
    assert.deepEqual(
      sorted.map((x) => x.product_id),
      ["p2", "p1"],
    );
  });
  test("동일 최저가는 입력 순서를 보존한다(stable)", () => {
    const p1 = mkP("p1", [mkV(40000)]);
    const p2 = mkP("p2", [mkV(40000)]);
    const p3 = mkP("p3", [mkV(30000)]);
    const sorted = applySearchFilter([p1, p2, p3], f(), {
      minPriceSort: true,
    });
    assert.deepEqual(
      sorted.map((x) => x.product_id),
      ["p3", "p1", "p2"],
    );
  });
});

describe("카테고리·브랜드·특징 필터", () => {
  test("category는 상위 그룹 기준 — monitor는 digital로 묶인다", () => {
    const mon = mkP("m", [mkV(30000)], { category: "monitor" });
    const lip = mkP("l", [mkV(30000)], { category: "beauty" });
    const out = applySearchFilter([mon, lip], f({ category: "digital" }));
    assert.deepEqual(
      out.map((x) => x.product_id),
      ["m"],
    );
  });
  test("brand는 정확 일치", () => {
    const a = mkP("a", [mkV(30000)], { brand: "A사" });
    const b = mkP("b", [mkV(30000)], { brand: "B사" });
    const out = applySearchFilter([a, b], f({ brand: "A사" }));
    assert.deepEqual(
      out.map((x) => x.product_id),
      ["a"],
    );
  });
  test("discountOnly — SYNTHETIC 표시 메타 정가보다 표시 최저가가 낮을 때만", () => {
    // p-d-foam-1은 PRODUCT_META.original_price_won=12900 [SYNTHETIC demo meta],
    // p-d-foam-2는 정가 메타가 없다 → 할인으로 치지 않는다.
    const d = mkP("p-d-foam-1", [mkV(9900)]);
    const nd = mkP("p-d-foam-2", [mkV(20000)]);
    const over = mkP("p-d-foam-1", [mkV(13000)]); // 최저가가 정가 이상이면 할인 아님
    const out = applySearchFilter([d, nd, over], f({ discountOnly: true }));
    assert.deepEqual(
      out.map((x) => x.product_id),
      ["p-d-foam-1"],
    );
    assert.equal(out[0].matched_variants[0].unit_price_won, 9900);
  });
});

describe("선택지·빈 필터", () => {
  test("categoriesIn/brandsIn은 결과에 실제 존재하는 값만 돌려준다", () => {
    const items = [
      mkP("a", [mkV(10000)], { category: "monitor", brand: "B사" }),
      mkP("b", [mkV(10000)], { category: "beauty", brand: "A사" }),
      mkP("c", [mkV(10000)], { category: "beauty", brand: "A사" }),
    ];
    const cats = categoriesIn(items);
    assert.ok(cats.includes("digital"));
    assert.ok(cats.includes("beauty"));
    const brands = brandsIn(items);
    assert.deepEqual(
      brands.map((b) => b.id),
      ["A사", "B사"], // 개수 내림차순
    );
    assert.equal(brands[0].count, 2);
  });
  test("isEmptyFilter/countActiveFilters", () => {
    assert.ok(isEmptyFilter(EMPTY_FILTER));
    assert.equal(countActiveFilters(EMPTY_FILTER), 0);
    assert.equal(
      countActiveFilters(f({ priceBand: "b2", inStockOnly: true })),
      2,
    );
    assert.ok(!isEmptyFilter(f({ discountOnly: true })));
  });
  test("입력 items/matched_variants를 변이하지 않는다", () => {
    const vs = [mkV(10000, "AVAILABLE", "v1"), mkV(50000, "AVAILABLE", "v2")];
    const p = mkP("p", vs);
    applySearchFilter([p], f({ priceBand: "b2" }), { minPriceSort: true });
    assert.equal(p.matched_variants.length, 2);
    assert.equal(vs.length, 2);
  });
});
