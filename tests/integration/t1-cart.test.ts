import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { getCart, addToCart, updateCartQuantity, removeCartItem } from "../../src/cart.ts";
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

describe("t1 cart update/remove", () => {
  let itemId = "";
  let firstUpd: {
    cart_item_id: string; quantity: number;
    expected_cart_version: number; expected_variant_version: number;
  };
  before(async () => {
    await ensureTestDb(1);
    await cleanUserData();
    const r = await addToCart(
      { variant_id: "v-a-24", quantity: 1, expected_cart_version: 1, expected_variant_version: V24_VERSION },
      A,
      "t2-seed-add",
    );
    assert.ok(r.ok);
    itemId = r.data.changed_item_id;
  });

  const upd = (quantity: number, cartV: number, key: string, variantV = V24_VERSION, ctx = A) =>
    updateCartQuantity(
      { cart_item_id: itemId, quantity, expected_cart_version: cartV, expected_variant_version: variantV },
      ctx,
      key,
    );

  test("update qty 1 -> 3: totals 540,000 + 3,000", async () => {
    const cv = await cartVersion(A);
    firstUpd = { cart_item_id: itemId, quantity: 3, expected_cart_version: cv, expected_variant_version: V24_VERSION };
    const r = await updateCartQuantity(firstUpd, A, "t2-upd-3");
    assert.ok(r.ok);
    assert.equal(r.data.cart.items[0].quantity, 3);
    assert.equal(r.data.cart.items_total_won, 540000);
    assert.equal(r.data.cart.total_won, 543000);
  });

  test("update replay: same key + same payload returns stored result", async () => {
    // 최초 요청과 동일한 payload + 동일 키의 재전송 → 실행 없이 저장 결과 복원
    const r = await updateCartQuantity(firstUpd, A, "t2-upd-3");
    assert.ok(r.ok && r.replayed === true);
    const c = await getCart(A);
    assert.ok(c.ok && c.data.items[0].quantity === 3); // 재실행 아님
  });

  test("update qty 0 / -1 -> VALIDATION", async () => {
    const cv = await cartVersion(A);
    const r0 = await upd(0, cv, "t2-upd-0");
    const rn = await upd(-1, cv, "t2-upd-neg");
    assert.ok(!r0.ok && r0.error.code === "VALIDATION");
    assert.ok(!rn.ok && rn.error.code === "VALIDATION");
  });

  test("update qty > stock -> OUT_OF_STOCK", async () => {
    const cv = await cartVersion(A);
    const r = await upd(6, cv, "t2-upd-over"); // 재고 5
    assert.ok(!r.ok && r.error.code === "OUT_OF_STOCK");
    const c = await getCart(A);
    assert.ok(c.ok && c.data.items[0].quantity === 3); // 변경 없음
  });

  test("stale_cart_and_replay: stale cart version -> VERSION_CONFLICT, stored REJECTED", async () => {
    const r = await upd(2, 999, "t2-upd-stale");
    assert.ok(!r.ok && r.error.code === "VERSION_CONFLICT");
    const replay = await upd(2, 999, "t2-upd-stale");
    assert.ok(!replay.ok && replay.replayed === true);
  });

  test("stale variant version -> VERSION_CONFLICT", async () => {
    const cv = await cartVersion(A);
    const r = await upd(2, cv, "t2-upd-stalev", 999);
    assert.ok(!r.ok && r.error.code === "VERSION_CONFLICT");
  });

  test("other user's cart item -> NOT_FOUND", async () => {
    const cb = await getCart(B);
    assert.ok(cb.ok);
    const r = await upd(1, cb.data.version, "t2-upd-other", V24_VERSION, B);
    assert.ok(!r.ok && r.error.code === "NOT_FOUND");
    const rr = await removeCartItem(
      { cart_item_id: itemId, expected_cart_version: cb.data.version },
      B,
      "t2-rm-other",
    );
    assert.ok(!rr.ok && rr.error.code === "NOT_FOUND");
  });

  test("same option name, different product stays distinct", async () => {
    const cv = await cartVersion(A);
    const r = await addToCart(
      { variant_id: "v-b-24", quantity: 1, expected_cart_version: cv, expected_variant_version: 1 },
      A,
      "t2-add-b24",
    );
    assert.ok(r.ok);
    const item = r.data.cart.items.find((i) => i.variant_id === "v-b-24");
    assert.equal(item?.product_id, "p-b"); // "24인치"라는 같은 옵션명이어도 p-a와 섞이지 않는다
  });

  test("delete_sold_out_item: removal is not blocked by sold-out", async () => {
    const c = await getCart(A);
    assert.ok(c.ok);
    const b24 = c.data.items.find((i) => i.variant_id === "v-b-24");
    assert.ok(b24);
    // 옵션이 담긴 뒤 품절된 상황을 만든다
    await sql.unsafe("UPDATE product_variants SET stock_qty=0 WHERE id='v-b-24'");
    try {
      const g = await getCart(A);
      assert.ok(g.ok);
      const stuck = g.data.items.find((i) => i.variant_id === "v-b-24");
      assert.equal(stuck?.purchasable, false);
      const r = await removeCartItem(
        { cart_item_id: b24.cart_item_id, expected_cart_version: g.data.version },
        A,
        "t2-rm-soldout",
      );
      assert.ok(r.ok);
      assert.equal(r.data.removed_item_id, b24.cart_item_id);
      assert.ok(!r.data.cart.items.some((i) => i.variant_id === "v-b-24"));
    } finally {
      await sql.unsafe("UPDATE product_variants SET stock_qty=8 WHERE id='v-b-24'");
    }
  });

  test("remove last item -> empty cart, shipping 0", async () => {
    const c = await getCart(A);
    assert.ok(c.ok);
    const left = c.data.items;
    // 남은 항목을 모두 지운다 (각 삭제는 최신 버전으로)
    for (const it of left) {
      const g = await getCart(A);
      assert.ok(g.ok);
      const r = await removeCartItem(
        { cart_item_id: it.cart_item_id, expected_cart_version: g.data.version },
        A,
        "t2-rm-" + it.cart_item_id,
      );
      assert.ok(r.ok);
    }
    const final = await getCart(A);
    assert.ok(final.ok);
    assert.equal(final.data.items.length, 0);
    assert.equal(final.data.shipping_fee_won, 0);
    assert.equal(final.data.total_won, 0);
  });

  test("remove unknown item -> NOT_FOUND", async () => {
    const cv = await cartVersion(A);
    const r = await removeCartItem(
      { cart_item_id: "nope", expected_cart_version: cv },
      A,
      "t2-rm-nope",
    );
    assert.ok(!r.ok && r.error.code === "NOT_FOUND");
  });
});
