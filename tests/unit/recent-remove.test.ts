// 최근본 삭제-로드 레이스 — 실제 화면이 쓰는 createRequestGate와
// filterLookupRemove를 그대로 연결해, pending load 도중 삭제 후 늦은 응답이
// 도착해도 삭제 카드가 되살아나지 않음을 검증한다(DB-free, 실제 네트워크 없음).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { createRequestGate } = await import("../../src/web/request-gate.ts");
const { filterLookupRemove } = await import(
  "../../src/web/catalog-lookup.ts"
);
import type { ProductSummary } from "../../src/contracts.ts";
import type { ProductLookup } from "../../src/web/catalog-lookup.ts";

const mkItem = (id: string): ProductSummary => ({
  product_id: id,
  name: "상품 " + id,
  brand: "b",
  category: "digital",
  image: null,
  matched_variants: [],
  rating_summary: { avg: null, count: 0 },
  availability: "AVAILABLE",
});

const lookupOf = (ids: string[]): ProductLookup => ({
  ok: true,
  found: ids.map(mkItem),
  missing: [],
  unread: [],
});

describe("recent remove vs pending load", () => {
  test("삭제 전 ids로 만든 늦은 응답은 삭제된 카드를 되살리지 못한다", async () => {
    const gate = createRequestGate();
    // 화면 상태 — Recent의 lookup state에 해당
    let lookup: ProductLookup | null = lookupOf(["p-a", "p-b"]);

    // '다시 시도' 등으로 진행 중인 읽기(삭제 이전 ids의 응답이 늦게 온다)
    const staleResponse = (async () => {
      const live = gate.begin();
      await new Promise((r) => setTimeout(r, 5));
      if (live()) lookup = lookupOf(["p-a", "p-b", "p-c"]);
    })();

    // 사용자가 p-a를 삭제 — 컴포넌트와 같은 순서: 세대 무효화 → 로컬 필터
    gate.begin();
    lookup = lookup ? filterLookupRemove(lookup, "p-a") : lookup;

    await staleResponse;
    assert.ok(lookup && lookup.ok);
    if (lookup && lookup.ok)
      assert.deepEqual(
        lookup.found.map((p) => p.product_id),
        ["p-b"],
        "삭제된 p-a가 되살아나거나 stale 응답이 덮어쓰면 안 된다",
      );
  });

  test("filterLookupRemove는 found/missing/unread 모두에서 id를 제거한다", () => {
    const cur: ProductLookup = {
      ok: true,
      found: [mkItem("p-keep"), mkItem("p-x")],
      missing: ["p-x", "p-gone"],
      unread: ["p-x", "p-later"],
    };
    const next = filterLookupRemove(cur, "p-x");
    assert.ok(next.ok);
    if (next.ok) {
      assert.deepEqual(next.found.map((p) => p.product_id), ["p-keep"]);
      assert.deepEqual(next.missing, ["p-gone"]);
      assert.deepEqual(next.unread, ["p-later"]);
    }
    // 실패 결과는 그대로 통과
    const err: ProductLookup = { ok: false };
    assert.equal(filterLookupRemove(err, "p-x"), err);
  });
});
