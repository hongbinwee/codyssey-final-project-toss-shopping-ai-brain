import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { getCart, addToCart } from "../../src/cart.ts";
import { getActionResult } from "../../src/actions.ts";
import { sql } from "../../src/db.ts";

const A = { actorUserId: "u-a", origin: "AGENT" as const };
const B = { actorUserId: "u-b", origin: "AGENT" as const };
const V24_VERSION = 1;
let firstInput: {
  variant_id: string;
  quantity: number;
  expected_cart_version: number;
  expected_variant_version: number;
};

async function cartVersion(u: typeof A) {
  const r = await getCart(u);
  assert.ok(r.ok);
  return r.data.version;
}

describe("t1 cart", () => {
  before(async () => {
    await ensureTestDb(1);
    await cleanUserData();
  });

  test("add V-A-24 x1 -> totals 180,000 + 3,000 = 183,000, stock unchanged", async () => {
    const cv = await cartVersion(A);
    firstInput = { variant_id: "v-a-24", quantity: 1, expected_cart_version: cv, expected_variant_version: V24_VERSION };
    const r = await addToCart(firstInput, A, "t1-add-1");
    assert.ok(r.ok);
    assert.equal(r.action_status, "SUCCEEDED");
    assert.equal(r.data.cart.items.length, 1);
    assert.equal(r.data.cart.items[0].quantity, 1);
    assert.equal(r.data.cart.items_total_won, 180000);
    assert.equal(r.data.cart.shipping_fee_won, 3000);
    assert.equal(r.data.cart.total_won, 183000);
    const [v] = await sql.unsafe<{ stock_qty: number }[]>(
      "SELECT stock_qty FROM product_variants WHERE id='v-a-24'",
    );
    assert.equal(v.stock_qty, 5); // 담기는 재고 차감이 아니다
  });

  test("add_merges_once: same key replay returns stored result, qty stays 1", async () => {
    const r2 = await addToCart(firstInput, A, "t1-add-1"); // 같은 키+같은 payload 재전송
    assert.ok(r2.ok);
    assert.equal(r2.replayed, true);
    const c = await getCart(A);
    assert.ok(c.ok);
    assert.equal(c.data.items[0].quantity, 1);
  });

  test("same key + different payload -> IDEMPOTENCY_CONFLICT", async () => {
    const cv = await cartVersion(A);
    const r = await addToCart(
      { variant_id: "v-a-24", quantity: 2, expected_cart_version: cv, expected_variant_version: V24_VERSION },
      A,
      "t1-add-1",
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("lost_first_response_recovers via kind+key", async () => {
    const r = await getActionResult(A, { kind: "ADD_CART", idempotency_key: "t1-add-1" });
    assert.ok(r.ok);
    assert.equal(r.data.status, "SUCCEEDED");
    const cart = (r.data.result as { cart: { items_total_won: number } }).cart;
    assert.equal(cart.items_total_won, 180000);
    // 타인의 요청 조회는 NOT_FOUND
    const other = await getActionResult(B, { kind: "ADD_CART", idempotency_key: "t1-add-1" });
    assert.ok(!other.ok && other.error.code === "NOT_FOUND");
  });

  test("new user action (new key) merges quantity", async () => {
    const cv = await cartVersion(A);
    const r = await addToCart(
      { variant_id: "v-a-24", quantity: 1, expected_cart_version: cv, expected_variant_version: V24_VERSION },
      A,
      "t1-add-2",
    );
    assert.ok(r.ok);
    assert.equal(r.data.cart.items[0].quantity, 2);
    assert.equal(r.data.cart.total_won, 363000);
  });

  test("OUT_OF_STOCK: v-a-27 cannot be added, result stored as REJECTED", async () => {
    const cv = await cartVersion(A);
    const r = await addToCart(
      { variant_id: "v-a-27", quantity: 1, expected_cart_version: cv, expected_variant_version: 1 },
      A,
      "t1-add-oos",
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, "OUT_OF_STOCK");
    assert.equal(r.action_status, "REJECTED");
    const replay = await addToCart(
      { variant_id: "v-a-27", quantity: 1, expected_cart_version: cv, expected_variant_version: 1 },
      A,
      "t1-add-oos",
    );
    assert.ok(!replay.ok && replay.replayed);
  });

  test("over-stock quantity rejected", async () => {
    const cv = await cartVersion(A);
    const r = await addToCart(
      { variant_id: "v-a-24", quantity: 10, expected_cart_version: cv, expected_variant_version: V24_VERSION },
      A,
      "t1-add-over",
    );
    assert.ok(!r.ok && r.error.code === "OUT_OF_STOCK"); // 2+10 > 5
  });

  test("VERSION_CONFLICT on stale cart version", async () => {
    const r = await addToCart(
      { variant_id: "v-a-24", quantity: 1, expected_cart_version: 999, expected_variant_version: V24_VERSION },
      A,
      "t1-add-stale",
    );
    assert.ok(!r.ok && r.error.code === "VERSION_CONFLICT");
  });

  test("cart isolation: u-b sees only its own empty cart", async () => {
    const c = await getCart(B);
    assert.ok(c.ok);
    assert.equal(c.data.items.length, 0);
    assert.equal(c.data.total_won, 0);
  });
});
