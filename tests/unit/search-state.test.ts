// search-state — PM 지정: 입력 변경·역순 응답·실패·확정 빈 결과·count 상태를
// 실제 사용 helper로 검증한다(DB-free·React 없음). A 소유 결과가 B 입력 아래
// 표시/실행되는 경로가 차단되는지가 핵심 계약이다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { filterCountState, owned, suggestState } = await import(
  "../../src/web/search-state.ts"
);
import type { ApiResult } from "../../src/web/api.ts";
import type { ProductSummary, SearchResult } from "../../src/contracts.ts";

const mkItem = (id: string): ProductSummary => ({
  product_id: id,
  name: id,
  brand: "b",
  category: "digital",
  image: null,
  matched_variants: [],
  rating_summary: { avg: null, count: 0 },
  availability: "AVAILABLE",
});

const okPage = (n: number, has_more = false): ApiResult<SearchResult> => ({
  ok: true,
  data: {
    items: Array.from({ length: n }, (_, i) => mkItem("p" + i)),
    shipping_fee_won: 0,
    next_cursor: null,
    has_more,
  },
});

const fail = (): ApiResult<SearchResult> => ({
  ok: false,
  error: { code: "NETWORK", message: "x" },
});

describe("owned — query 소유권", () => {
  test("같은 query의 결과만 돌려준다", () => {
    const o = { q: "모니터", r: okPage(3) };
    assert.equal(owned(o, "모니터"), o.r);
  });
  test("다른 query의 결과는 null — A 결과가 B 아래 표시되지 않는다", () => {
    const o = { q: "모니터", r: okPage(3) };
    assert.equal(owned(o, "이어폰"), null);
  });
  test("null 소유자는 항상 null", () => {
    assert.equal(owned(null, "모니터"), null);
  });
});

describe("suggestState — 입력 변경·역순 응답·실패·빈 결과 구분", () => {
  test("응답 전(sugs null)은 loading", () => {
    assert.equal(suggestState("모니", null), "loading");
  });
  test("이전 query의 sugs는 loading — 입력 변경 중 이전 결과 미표시", () => {
    const sugs = { q: "모니터", r: okPage(3) };
    assert.equal(suggestState("모니터링", sugs), "loading");
  });
  test("실패는 error — '일치하는 상품명이 없어요'로 오표시하지 않는다", () => {
    const sugs = { q: "모니터", r: fail() };
    assert.equal(suggestState("모니터", sugs), "error");
  });
  test("ok+0건은 empty — 확정된 빈 결과", () => {
    const sugs = { q: "모니터", r: okPage(0) };
    assert.equal(suggestState("모니터", sugs), "empty");
  });
  test("ok+N건은 items", () => {
    const sugs = { q: "모니터", r: okPage(2) };
    assert.equal(suggestState("모니터", sugs), "items");
  });
});

describe("filterCountState — 로딩·실패·준비 구분", () => {
  test("조회 중이면 loading(결과가 있어도)", () => {
    assert.equal(filterCountState(true, okPage(5)), "loading");
  });
  test("응답 전은 loading", () => {
    assert.equal(filterCountState(false, null), "loading");
  });
  test("조회 실패는 error — 영구 '확인 중'이 아니다", () => {
    assert.equal(filterCountState(false, fail()), "error");
  });
  test("ok이지만 has_more면 loading — 미완료 수를 최종 수로 약속 안 함", () => {
    assert.equal(filterCountState(false, okPage(3, true)), "loading");
  });
  test("ok+has_more=false+비로딩이면 ready", () => {
    assert.equal(filterCountState(false, okPage(3)), "ready");
  });
});
