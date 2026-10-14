// src/web/detail-resume.ts의 DB-free 검증 — F07 복귀 스냅샷의 계정·상품
// 스코프·1회 소비·stale 미소비·부분 복원 안내를 실제 저장소/판정 함수로
// 회귀한다 [PMQA-066 — PM 지적 2건의 배선 검증].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDetailResume,
  saveDetailResume,
  takeDetailResume,
  takeDetailResumeIfFresh,
  type DetailResume,
} from "../../src/web/detail-resume.ts";

const variants = [
  { variant_id: "v-24", availability: "AVAILABLE", stock_qty: 10 },
  { variant_id: "v-27", availability: "SOLD_OUT", stock_qty: 0 },
  { variant_id: "v-32", availability: "AVAILABLE", stock_qty: 5 },
];

describe("detail-resume 스냅샷 저장/소비", () => {
  test("저장 → take는 entry를 돌려주고 두 번째 호출은 소비된 상태", () => {
    saveDetailResume("t-p1", {
      user: "u-1",
      variantId: "v-32",
      qty: 3,
      scrollY: 640,
    });
    const first = takeDetailResume("t-p1");
    assert.equal(first?.variantId, "v-32");
    assert.equal(takeDetailResume("t-p1"), undefined);
  });

  test("다른 상품 id는 서로의 스냅샷을 보지 못한다", () => {
    saveDetailResume("t-pA", {
      user: "u-1",
      variantId: "v-24",
      qty: 1,
      scrollY: 100,
    });
    assert.equal(takeDetailResume("t-pB"), undefined);
    // 남아 있는 t-pA entry는 다른 상품 조회를 거쳐도 보존된다
    assert.equal(takeDetailResume("t-pA")?.variantId, "v-24");
  });

  test("isStale(언마운트·세대 갱신)이면 스냅샷을 소비하지 않는다", () => {
    saveDetailResume("t-stale", {
      user: "u-1",
      variantId: "v-24",
      qty: 2,
      scrollY: 300,
    });
    // 화면 밖의 늦은 응답 — 소비 없이 undefined
    assert.equal(takeDetailResumeIfFresh(() => true, "t-stale"), undefined);
    // 스냅샷이 남아 있어 실제 복귀 시 다시 복원할 수 있다
    const kept = takeDetailResumeIfFresh(() => false, "t-stale");
    assert.equal(kept?.variantId, "v-24");
    assert.equal(takeDetailResumeIfFresh(() => false, "t-stale"), undefined);
  });
});

describe("resolveDetailResume 복원 판정", () => {
  const snap = (over: Partial<DetailResume>) => ({
    user: "u-1",
    variantId: "v-32",
    qty: 3,
    scrollY: 640,
    ...over,
  });

  test("비기본 옵션 + 수량 3을 그대로 복원한다", () => {
    const plan = resolveDetailResume(variants, snap({}), "u-1");
    assert.equal(plan.apply, true);
    assert.equal(plan.variantId, "v-32");
    assert.equal(plan.qty, 3);
    assert.equal(plan.scrollY, 640);
    assert.equal(plan.notice, null);
  });

  test("다른 계정의 스냅샷은 적용하지 않는다", () => {
    const plan = resolveDetailResume(variants, snap({}), "u-2");
    assert.equal(plan.apply, false);
    assert.equal(plan.variantId, null);
  });

  test("스냅샷이 없으면 기본 초기화 경로", () => {
    const plan = resolveDetailResume(variants, undefined, "u-1");
    assert.equal(plan.apply, false);
  });

  test("저장 옵션이 품절이면 조용히 교체하지 않고 OPTION_UNAVAILABLE 안내", () => {
    const plan = resolveDetailResume(variants, snap({ variantId: "v-27" }), "u-1");
    assert.equal(plan.apply, true);
    assert.equal(plan.variantId, null); // 호출부가 기본 선택 + 안내
    assert.equal(plan.notice, "OPTION_UNAVAILABLE");
    assert.equal(plan.scrollY, 640); // 같은 상품 화면 — 위치는 복원한다
  });

  test("저장 옵션이 목록에서 사라져도 OPTION_UNAVAILABLE 안내", () => {
    const plan = resolveDetailResume(
      variants,
      snap({ variantId: "v-gone" }),
      "u-1",
    );
    assert.equal(plan.notice, "OPTION_UNAVAILABLE");
    assert.equal(plan.variantId, null);
  });

  test("저장 수량이 현재 재고를 넘으면 클램프 + QTY_REDUCED 안내", () => {
    const plan = resolveDetailResume(
      [{ variant_id: "v-32", availability: "AVAILABLE", stock_qty: 2 }],
      snap({ qty: 5 }),
      "u-1",
    );
    assert.equal(plan.apply, true);
    assert.equal(plan.variantId, "v-32");
    assert.equal(plan.qty, 2);
    assert.equal(plan.notice, "QTY_REDUCED");
  });
});
