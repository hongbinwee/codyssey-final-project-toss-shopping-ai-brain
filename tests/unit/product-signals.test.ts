import assert from "node:assert/strict";
import test from "node:test";
import type { ProductSummary } from "../../src/contracts.ts";
import {
  PRODUCT_SIGNALS,
  fmtViewerCount,
  lowest30dFor,
  type PriceObservation,
} from "../../src/web/display-meta.ts";

const product = (
  product_id: string,
  variant_id: string,
  unit_price_won: number,
): ProductSummary =>
  ({
    product_id,
    matched_variants: [{ variant_id, unit_price_won }],
  }) as unknown as ProductSummary;

test("viewer signal uses Toss-like integer ten-thousands and distinguishes smaller counts", () => {
  assert.equal(fmtViewerCount(32400), "3만 명");
  assert.equal(fmtViewerCount(5200), "5,200명");
});

test("30-day low is derived for the exact product variant and hides when current price is higher", () => {
  const now = Date.now();
  const sameVariant = product("p-d-ear-lite", "v-d-ear-lite-w", 89000);
  assert.equal(lowest30dFor(sameVariant, now)?.price_won, 89000);

  const otherVariant = product("p-d-ear-lite", "v-d-ear-lite-b", 89000);
  assert.equal(lowest30dFor(otherVariant, now), null);

  const aboveObservedLow = product("p-d-bat-20", "v-d-bat-20", 45000);
  assert.equal(lowest30dFor(aboveObservedLow, now), null);
});

test("30-day low hides when all observations are outside the current window", () => {
  const now = Date.now() + 31 * 86400000;
  assert.equal(
    lowest30dFor(product("p-d-ear-lite", "v-d-ear-lite-w", 89000), now),
    null,
  );
});

// 출처 분리: 카드에 쓰이는 지표는 항상 source/source_name을 명시해야 한다.
// EXTERNAL/INTERNAL 데이터가 들어와도 같은 계약으로 구분된다.
test("signals keep explicit source and source_name for every metric", () => {
  const sig = PRODUCT_SIGNALS["p-d-ear-lite"];
  assert.equal(sig?.view_count?.source, "SYNTHETIC");
  assert.equal(sig?.view_count?.source_name, "demo-traffic-sample");
  assert.ok(
    sig?.price_observations?.every(
      (o) => o.source === "SYNTHETIC" && o.source_name === "demo-price-history",
    ),
  );
});

// 빈 variant 목록이면 비교 대상이 없으므로 null.
test("empty variant list yields no signal", () => {
  const p = { product_id: "p-d-ear-lite", matched_variants: [] } as unknown as ProductSummary;
  assert.equal(lowest30dFor(p), null);
});

// 최저가 variant에 이력이 없으면 보수적으로 숨긴다(다른 variant의 최저가를
// 최저가 옵션 가격과 혼합해 주장하지 않는 정책).
test("history on a non-cheapest variant stays hidden", () => {
  const p = {
    product_id: "p-d-ear-lite",
    matched_variants: [
      { variant_id: "v-d-ear-lite-b", unit_price_won: 85000 }, // 최저가 — 이력 없음
      { variant_id: "v-d-ear-lite-w", unit_price_won: 89000 }, // 이력 있음
    ],
  } as unknown as ProductSummary;
  assert.equal(lowest30dFor(p), null);
});

// 경계값: 정확히 30일 전 관측은 포함, 미래·잘못된 날짜·NaN 가격은 제외된다.
// 어떤 이상값도 섞이면 low가 오염되거나 결과가 숨겨지므로 하나로 같이 검증한다.
test("window boundary and invalid observations are filtered correctly", () => {
  const now = 1_900_000_000_000;
  const isoAt = (msAgo: number) => new Date(now - msAgo).toISOString();
  const obs = (over: Partial<PriceObservation>): PriceObservation => ({
    product_id: "p-t-edge",
    variant_id: "v-t-edge",
    observed_at: isoAt(86400000),
    price_won: 50000,
    source: "SYNTHETIC",
    source_name: "test-source",
    ...over,
  });
  PRODUCT_SIGNALS["p-t-edge"] = {
    price_observations: [
      obs({ observed_at: isoAt(30 * 86400000) }),           // 경계값 — 포함
      obs({ observed_at: isoAt(-86400000), price_won: 40000 }), // 미래 — 제외
      obs({ observed_at: "not-a-date", price_won: 30000 }),    // 파싱 불가 — 제외
      obs({ price_won: NaN }),                                // NaN 가격 — 제외
    ],
  };
  try {
    const r = lowest30dFor(product("p-t-edge", "v-t-edge", 50000), now);
    // 유효한 것은 경계값 50,000뿐 — 이상값이 섞였다면 low가 낮아져 null이 됐을 것
    assert.equal(r?.price_won, 50000);
    assert.equal(r?.source, "SYNTHETIC");
  } finally {
    delete PRODUCT_SIGNALS["p-t-edge"];
  }
});

// 출처(source:source_name)가 다른 이력은 하나의 시리즈로 섞지 않고,
// 최신 관측을 가진 출처 그룹만 선택한다.
test("observations from different sources are not mixed; the newest source group wins", () => {
  const now = 1_900_000_000_000;
  const isoAt = (msAgo: number) => new Date(now - msAgo).toISOString();
  const base = {
    product_id: "p-t-src",
    variant_id: "v-t-src",
    source: "SYNTHETIC" as const,
  };
  PRODUCT_SIGNALS["p-t-src"] = {
    price_observations: [
      // src-a(구 시리즈): 40,000까지 내려갔지만 그 값이 결과를 오염시키면 안 된다
      { ...base, source_name: "src-a", observed_at: isoAt(20 * 86400000), price_won: 40000 },
      { ...base, source_name: "src-a", observed_at: isoAt(10 * 86400000), price_won: 42000 },
      // src-b(최신 시리즈): 이 그룹의 low만 계산에 쓰여야 한다
      { ...base, source_name: "src-b", observed_at: isoAt(5 * 86400000), price_won: 51000 },
      { ...base, source_name: "src-b", observed_at: isoAt(2 * 86400000), price_won: 50000 },
    ],
  };
  try {
    const r = lowest30dFor(product("p-t-src", "v-t-src", 50000), now);
    // src-b 그룹의 low=50,000 → 현재가 50,000 <= low → 표시.
    // src-a의 40,000이 섞였다면 current > low라 null이 됐을 것.
    assert.equal(r?.price_won, 50000);
  } finally {
    delete PRODUCT_SIGNALS["p-t-src"];
  }
});

// variant_id가 같아도 product_id가 다르면 그 낮은 가격을 끌어오지 않는다.
// 오염 관측은 대상 상품의 observations 배열 안에 넣어야 product_id 필터를 증명한다.
test("observations of another product sharing a variant id cannot contaminate", () => {
  const now = Date.now();
  const target = PRODUCT_SIGNALS["p-d-ear-lite"];
  const foreign: PriceObservation = {
    product_id: "p-t-other",             // 다른 상품 id
    variant_id: "v-d-ear-lite-w",        // 같은 variant_id
    observed_at: new Date(now - 86400000).toISOString(),
    price_won: 10000,
    source: "SYNTHETIC",
    source_name: "test",
  };
  target.price_observations!.push(foreign);
  try {
    const r = lowest30dFor(product("p-d-ear-lite", "v-d-ear-lite-w", 89000), now);
    // 본 상품 이력의 low=89,000만 유효 — 10,000이 섞였다면 null이 됐을 것
    assert.equal(r?.price_won, 89000);
  } finally {
    target.price_observations!.splice(
      target.price_observations!.indexOf(foreign), 1,
    );
  }
});
