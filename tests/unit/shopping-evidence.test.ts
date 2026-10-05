import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ungroundedCitations } from "../../src/agent.ts";

const refs = {
  products: ["p-a", "p-b"],
  variants: ["v-a-24"],
  reviews: ["r-01", "r-02"],
};

describe("citation grounding", () => {
  test("citations of retrieved ids pass", () => {
    const msg = "p-a와 p-b를 비교했어요. p-a의 v-a-24가 180,000원, 근거 r-01.";
    assert.deepEqual(ungroundedCitations(msg, refs), []);
  });

  test("citation_must_exist: id not in tool results is flagged", () => {
    const msg = "p-c가 더 낫습니다. 근거 r-99와 v-z-9 참고.";
    assert.deepEqual(ungroundedCitations(msg, refs).sort(), ["p-c", "r-99", "v-z-9"].sort());
  });

  test("no citations -> nothing flagged", () => {
    assert.deepEqual(ungroundedCitations("추천만 할게요", refs), []);
  });
});
