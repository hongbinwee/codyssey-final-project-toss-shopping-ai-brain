// shipFeeLabel — 배송비 표시 검증 [PMQA-068]. >0 비교만으로는 NaN·음수·
// 부재 값을 '무료배송'으로 오표기하므로 0/양의 안전 정수/비정상을 구분한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shipFeeLabel } from "../../src/web/api.ts";

describe("shipFeeLabel [PMQA-068]", () => {
  test("정확히 0 → 무료배송", () => {
    assert.equal(shipFeeLabel(0), "무료배송");
  });

  test("양의 안전 정수 → 실제 금액", () => {
    assert.equal(shipFeeLabel(3000), "배송비 3,000원");
    assert.equal(shipFeeLabel(1), "배송비 1원");
  });

  test("부재·비정상 값 → 배송비 정보 없음", () => {
    for (const bad of [undefined, null, NaN, -1, 3000.5, Infinity] as const) {
      assert.equal(shipFeeLabel(bad), "배송비 정보 없음", String(bad));
    }
  });
});
