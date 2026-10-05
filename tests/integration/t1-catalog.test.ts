import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb } from "../helpers/testdb.ts";
import { searchProducts, getProduct, getReviews } from "../../src/catalog.ts";
import { sql } from "../../src/db.ts";

const A = { actorUserId: "u-a", origin: "AGENT" as const };

describe("t1 catalog", () => {
  before(async () => {
    await ensureTestDb(1);
  });

  test("seed reproduction: V-A-24 180000/stock5, V-A-27 220000/stock0", async () => {
    const r = await getProduct({ product_id: "p-a" });
    assert.ok(r.ok);
    const v24 = r.data.variants.find((v) => v.variant_id === "v-a-24")!;
    const v27 = r.data.variants.find((v) => v.variant_id === "v-a-27")!;
    assert.equal(v24.unit_price_won, 180000);
    assert.equal(v24.stock_qty, 5);
    assert.equal(v24.availability, "AVAILABLE");
    assert.equal(v27.unit_price_won, 220000);
    assert.equal(v27.availability, "SOLD_OUT");
    assert.equal(r.data.shipping_fee_won, 3000);
  });

  test("search: query + price filter + spec filter", async () => {
    const all = await searchProducts({ query: "모니터" });
    assert.ok(all.ok);
    assert.equal(all.data.items.length, 3);
    const cheap = await searchProducts({ max_unit_price_won: 200000 });
    assert.ok(cheap.ok);
    assert.deepEqual(
      cheap.data.items.map((i) => i.product_id).sort(),
      ["p-a", "p-b"],
    );
    const spec = await searchProducts({ required_specs: { size: "27인치" } });
    assert.ok(spec.ok);
    for (const it of spec.data.items)
      assert.ok(it.matched_variants.every((v) => v.option_values.size === "27인치"));
    const empty = await searchProducts({ query: "냉장고" });
    assert.ok(empty.ok);
    assert.equal(empty.data.items.length, 0); // 0건은 성공의 빈 배열
  });

  test("variant_and_evidence_match: variant reviews are scoped to same product", async () => {
    const r = await getReviews({ product_id: "p-a", variant_id: "v-a-24" });
    assert.ok(r.ok);
    assert.equal(r.data.reviews.length, 2);
    assert.ok(r.data.reviews.every((x) => x.variant_id === "v-a-24"));
    // 다른 상품의 variant_id는 거절
    const bad = await getReviews({ product_id: "p-a", variant_id: "v-b-24" });
    assert.ok(!bad.ok);
    assert.equal(bad.error.code, "VALIDATION");
    // 다른 옵션 리뷰가 섞이지 않는다
    const all = await getReviews({ product_id: "p-a" });
    assert.ok(all.ok);
    assert.equal(all.data.total_matching, 4);
    assert.ok(all.data.reviews.every((x) => x.source_kind === "SYNTHETIC"));
  });

  test("search rejects malformed inputs", async () => {
    const bad = await searchProducts({ sort: "CHEAPEST" as never });
    assert.ok(!bad.ok);
    assert.equal(bad.error.code, "VALIDATION");
    const bad2 = await searchProducts({ cursor: "!!!" });
    assert.ok(!bad2.ok);
  });

  test("unknown product -> NOT_FOUND", async () => {
    const r = await getProduct({ product_id: "p-zzz" });
    assert.ok(!r.ok && r.error.code === "NOT_FOUND");
    const rr = await getReviews({ product_id: "p-zzz" });
    assert.ok(!rr.ok && rr.error.code === "NOT_FOUND");
  });
});
