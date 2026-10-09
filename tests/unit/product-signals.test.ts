import assert from "node:assert/strict";
import test from "node:test";
import type { ProductSummary } from "../../src/contracts.ts";
import { fmtViewerCount, lowest30dFor } from "../../src/web/display-meta.ts";

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
