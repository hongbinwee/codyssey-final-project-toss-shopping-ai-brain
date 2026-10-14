// Phase 3 모의 결제·주문 생성 검증. 핵심: 원자성·중복 차단·동시 재고·Agent 우회 불가.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { addToCart, getCart, updateCartQuantity } from "../../src/cart.ts";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import { getActionResult } from "../../src/actions.ts";
import { executeTool, toolDefs } from "../../src/agent.ts";
import { sql } from "../../src/db.ts";
import { config } from "../../src/config.ts";
import { createHmac } from "node:crypto";

const A = { actorUserId: "u-a", origin: "AGENT" as const };
const B = { actorUserId: "u-b", origin: "AGENT" as const };

const vver = async (id: string) =>
  (await sql.unsafe<{ version: number }[]>(
    "SELECT version FROM product_variants WHERE id=$1", [id],
  ))[0].version;

// 생성 주문 id는 ord-<8hex> — 시나리오 seed(ord-a-pre 등)와 구분된다.
const testOrders = async () =>
  sql.unsafe<{ id: string; user_id: string }[]>(
    "SELECT id, user_id FROM orders WHERE id ~ '^ord-[0-9a-f-]{8,}$'",
  );

async function putInCart(
  ctx: typeof A, variantId: string, qty: number, key: string,
) {
  const c = await getCart(ctx);
  assert.ok(c.ok);
  const r = await addToCart(
    {
      variant_id: variantId,
      quantity: qty,
      expected_cart_version: c.data.version,
      expected_variant_version: await vver(variantId),
    },
    ctx, key,
  );
  assert.ok(r.ok, JSON.stringify(r));
}

describe("phase3 checkout", () => {
  let quoteToken = "";
  let orderId = "";

  before(async () => {
    await ensureTestDb(3);
    await cleanUserData();
  });

  test("empty cart -> quote rejected", async () => {
    const r = await checkoutQuote(A);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "VALIDATION");
  });

  test("checkout_is_atomic: order+payment+shipment+stock+cart in one commit", async () => {
    await putInCart(A, "v-a-24", 1, "t3-add-a");
    const q = await checkoutQuote(A);
    assert.ok(q.ok);
    quoteToken = q.data.quote_token;
    const qc = q.data.cart; // CART_FULL 견적은 카트 뷰를 동반한다(DIRECT는 null)
    assert.ok(qc);
    assert.equal(qc.total_won, 183000);
    assert.ok(q.data.address.name);

    const r = await confirmCheckout(quoteToken, A, "ui-t3-co-1");
    assert.ok(r.ok, JSON.stringify(r));
    orderId = r.data.order_id;
    assert.equal(r.action_status, "SUCCEEDED");

    const [o] = await sql.unsafe<{ status: string; total_won: number }[]>(
      "SELECT status, total_won FROM orders WHERE id=$1", [orderId]);
    assert.equal(o.status, "CONFIRMED");
    assert.equal(o.total_won, 183000);
    const [p] = await sql.unsafe<{ status: string; paid_amount_won: number }[]>(
      "SELECT status, paid_amount_won FROM payments WHERE order_id=$1", [orderId]);
    assert.equal(p.status, "PAID");
    assert.equal(p.paid_amount_won, 183000);
    const [s] = await sql.unsafe<{ status: string; events_json: unknown[] }[]>(
      "SELECT status, events_json FROM shipments WHERE order_id=$1", [orderId]);
    assert.equal(s.status, "PREPARING");
    assert.equal(s.events_json.length, 1);
    const [v] = await sql.unsafe<{ stock_qty: number }[]>(
      "SELECT stock_qty FROM product_variants WHERE id='v-a-24'");
    assert.equal(v.stock_qty, 4); // 5 -> 4, 주문 시점에만 차감
    const c = await getCart(A);
    assert.ok(c.ok);
    assert.equal(c.data.items.length, 0);
  });

  test("duplicate_checkout_one_order: same key replays stored result", async () => {
    const before2 = await testOrders();
    const r = await confirmCheckout(quoteToken, A, "ui-t3-co-1");
    assert.ok(r.ok);
    assert.equal(r.replayed, true);
    assert.equal(r.data.order_id, orderId);
    assert.equal((await testOrders()).length, before2.length);
  });

  test("lost_first_response_recovers via kind+key (CHECKOUT)", async () => {
    const r = await getActionResult(A, { kind: "CHECKOUT", idempotency_key: "ui-t3-co-1" });
    assert.ok(r.ok);
    assert.equal(r.data.status, "SUCCEEDED");
    assert.equal((r.data.result as { order_id: string }).order_id, orderId);
  });

  test("STALE_QUOTE: 카트가 바뀌면 견적은 무효", async () => {
    await putInCart(A, "v-b-24", 1, "t3-add-b1");
    const q = await checkoutQuote(A);
    assert.ok(q.ok);
    await putInCart(A, "v-c-27", 1, "t3-add-b2"); // 견적 이후 카트 변경
    const r = await confirmCheckout(q.data.quote_token, A, "ui-t3-co-stale");
    assert.ok(!r.ok);
    assert.equal(r.error.code, "STALE_QUOTE");
    assert.equal(r.action_status, "REJECTED");
  });

  test("concurrent_last_stock: 재고 1개 동시 주문은 1건만 성공", async () => {
    await sql.unsafe("UPDATE product_variants SET stock_qty=1 WHERE id='v-c-32'");
    await putInCart(A, "v-c-32", 1, "t3-race-a");
    await putInCart(B, "v-c-32", 1, "t3-race-b");
    const qa = await checkoutQuote(A);
    const qb = await checkoutQuote(B);
    assert.ok(qa.ok && qb.ok);
    const before2 = await testOrders();

    const [ra, rb] = await Promise.all([
      confirmCheckout(qa.data.quote_token, A, "ui-race-a"),
      confirmCheckout(qb.data.quote_token, B, "ui-race-b"),
    ]);
    const wins = [ra, rb].filter((r) => r.ok);
    const loses = [ra, rb].filter((r) => !r.ok);
    assert.equal(wins.length, 1, "정확히 한 명만 성공해야 한다");
    assert.equal(loses.length, 1);
    assert.ok(
      ["OUT_OF_STOCK", "STALE_QUOTE"].includes(loses[0].error.code),
      "패자 코드: " + loses[0].error.code,
    );
    const [v] = await sql.unsafe<{ stock_qty: number }[]>(
      "SELECT stock_qty FROM product_variants WHERE id='v-c-32'");
    assert.equal(v.stock_qty, 0); // 음수 재고 없음
    // 주문은 정확히 1건만 늘어야 한다 (패자의 주문/결제 잔여물 없음)
    const after = await testOrders();
    assert.equal(after.length, before2.length + 1, "승자 1건만 생성 — 패자 잔여 주문 0");
    // 패자 카트는 그대로 남아 있어야 한다 (롤백된 게 아니라 처음부터 주문이 안 만들어진 것)
    const loserCtx = ra.ok ? B : A;
    const loserCart = await getCart(loserCtx);
    assert.ok(loserCart.ok);
    assert.ok(loserCart.data.items.some((i) => i.variant_id === "v-c-32"));
    await sql.unsafe("UPDATE product_variants SET stock_qty=2 WHERE id='v-c-32'");
  });

  test("agent_cannot_checkout: checkout은 Tool registry에 없다", async () => {
    const names = new Set([...toolDefs("shopping"), ...toolDefs("cs")]
      .map((t) => t.function.name));
    assert.ok(![...names].some((n) => n.includes("checkout") || n.includes("pay")));
    const r = await executeTool("confirm_checkout", {}, A, "k");
    assert.ok(!r.ok && r.error.code === "TOOL_NOT_ALLOWED");
    // CS Tool을 shopping brain으로 호출해도 거절된다
    const x = await executeTool("list_orders", {}, A, "k2", "shopping");
    assert.ok(!x.ok && x.error.code === "TOOL_NOT_ALLOWED");
  });
});

// ── PMQA-077-A — 승인된 C 구매 계약 실DB 회귀 ────────────────────────
// DIRECT(바로 구매)·CART_SELECTED(선택 주문)·서명 토큰 위변조의 서버 계약.
// 격리: 이 suite는 자체 before에서 ensureTestDb(3)+cleanUserData로 fixture를
// 재설정한다 — 위 phase3 suite가 남긴 주문·재고 변경을 상속받지 않는다.
// 위변조 토큰 서명은 테스트 환경의 config.sessionSecret로 만든다 — 실배포
// 클라이언트는 비밀 없이 유효 HMAC을 만들 수 없다(테스트 전용 증명).

const stockOf = async (id: string) =>
  (await sql.unsafe<{ stock_qty: number }[]>(
    "SELECT stock_qty FROM product_variants WHERE id=$1",
    [id],
  ))[0].stock_qty;

const cartItemOf = async (ctx: typeof A, variantId: string) => {
  const c = await getCart(ctx);
  assert.ok(c.ok);
  const it = c.data.items.find((i) => i.variant_id === variantId);
  assert.ok(it, "cart에 " + variantId + " 없음");
  return {
    cart: c.data,
    cart_item_id: it.cart_item_id,
    variant_id: it.variant_id,
    quantity: it.quantity,
    variant_version: it.variant_version,
  };
};

// 견적 전/후·confirm 전/후의 카트 행 관련 필드 전체 비교용 스냅샷.
const cartSnapOf = async (ctx: typeof A, variantId: string) => {
  const it = await cartItemOf(ctx, variantId);
  return {
    cart_item_id: it.cart_item_id,
    variant_id: it.variant_id,
    quantity: it.quantity,
    variant_version: it.variant_version,
    cart_version: it.cart.version,
  };
};

const tableCount = async (t: string) =>
  (await sql.unsafe<{ n: number }[]>(
    "SELECT count(*)::int AS n FROM " + t,
  ))[0].n;

// 거절(REJECTED·VALIDATION)된 시도가 업무 상태를 건드리지 않았다는 전/후 비교용
// 스냅샷 — action_requests의 REJECTED 행은 정상 기록이므로 대상에 넣지 않는다.
const bizSnap = async (ctx: typeof A, variantIds: string[]) => {
  const c = await getCart(ctx);
  assert.ok(c.ok);
  const stocks: Record<string, number> = {};
  for (const v of variantIds) stocks[v] = await stockOf(v);
  return {
    orders: await tableCount("orders"),
    order_items: await tableCount("order_items"),
    payments: await tableCount("payments"),
    shipments: await tableCount("shipments"),
    stocks,
    cart_version: c.data.version,
    cart_items: c.data.items.map((i) => ({
      cart_item_id: i.cart_item_id,
      variant_id: i.variant_id,
      quantity: i.quantity,
      variant_version: i.variant_version,
    })),
  };
};

// src/checkout.ts의 비공개 sign과 같은 알고리즘 — 유효 서명의 위조 페이로드를 만든다.
const quoteSign = (body: string) =>
  createHmac("sha256", config.sessionSecret)
    .update("checkout:" + body)
    .digest("base64url");
const quotePayload = (token: string) =>
  JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString(),
  ) as {
    user_id: string;
    source: string;
    items: Record<string, unknown>[];
    items_total_won: number;
    shipping_fee_won: number;
    total_won: number;
  };
const signedQuoteToken = (payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + quoteSign(body);
};

describe("PMQA-077-A 구매 계약 — DIRECT·CART_SELECTED·토큰", () => {
  before(async () => {
    await ensureTestDb(3);
    await cleanUserData();
  });

  test("DIRECT — 견적은 무상태, confirm만 주문/결제/재고를 1회 반영, 카트는 완전 무접촉", async () => {
    await putInCart(A, "v-b-24", 1, "077-d-cart");
    const cartBefore = await cartSnapOf(A, "v-b-24");
    const ordersBefore = await testOrders();
    const stockBefore = await stockOf("v-a-24");

    const q = await checkoutQuote(A, {
      kind: "DIRECT",
      variant_id: "v-a-24",
      quantity: 1,
    });
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(q.data.source, "DIRECT");
    assert.equal(q.data.cart, null); // DIRECT는 카트 스냅샷조차 만들지 않는다
    assert.equal(q.data.items.length, 1);
    assert.equal(q.data.items[0].cart_item_id, null);
    assert.equal(q.data.items[0].variant_id, "v-a-24");
    assert.equal(q.data.total_won, 183000); // 180,000 + 배송비 3,000

    // 견적 발급은 주문·재고·카트를 바꾸지 않는다 — 카트는 행 id·variant·
    // 수량·variant_version·cart version 전부 불변이어야 한다
    assert.equal((await testOrders()).length, ordersBefore.length);
    assert.equal(await stockOf("v-a-24"), stockBefore);
    assert.deepEqual(await cartSnapOf(A, "v-b-24"), cartBefore);

    const r = await confirmCheckout(q.data.quote_token, A, "ui-077-direct-1");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.action_status, "SUCCEEDED");
    const orderId = r.data.order_id;
    // confirm은 orders 테이블에 정확히 1행만 추가한다
    assert.equal((await testOrders()).length, ordersBefore.length + 1);

    const [o] = await sql.unsafe<{ status: string; total_won: number }[]>(
      "SELECT status, total_won FROM orders WHERE id=$1",
      [orderId],
    );
    assert.equal(o.status, "CONFIRMED");
    assert.equal(o.total_won, 183000);
    // confirm이 만드는 부속 행의 cardinality·금액 — 품목 1·결제 1·배송 1
    const oi = await sql.unsafe<
      { variant_id: string; quantity: number; line_total_won: number }[]
    >(
      "SELECT variant_id, quantity, line_total_won FROM order_items WHERE order_id=$1",
      [orderId],
    );
    assert.equal(oi.length, 1);
    assert.equal(oi[0].variant_id, "v-a-24");
    assert.equal(oi[0].quantity, 1);
    assert.equal(oi[0].line_total_won, 180000);
    const pays = await sql.unsafe<
      { status: string; paid_amount_won: number }[]
    >("SELECT status, paid_amount_won FROM payments WHERE order_id=$1", [
      orderId,
    ]);
    assert.equal(pays.length, 1);
    assert.equal(pays[0].status, "PAID");
    assert.equal(pays[0].paid_amount_won, 183000);
    const ships = await sql.unsafe<{ status: string }[]>(
      "SELECT status FROM shipments WHERE order_id=$1",
      [orderId],
    );
    assert.equal(ships.length, 1);
    assert.equal(ships[0].status, "PREPARING");
    assert.equal(await stockOf("v-a-24"), stockBefore - 1);

    // 핵심 구별 계약 — 카트 행 id·variant·수량·버전이 전부 보존된다
    const cartAfter = await getCart(A);
    assert.ok(cartAfter.ok);
    assert.equal(cartAfter.data.items.length, 1);
    assert.deepEqual(await cartSnapOf(A, "v-b-24"), cartBefore);
  });

  test("DIRECT — 같은 키 replay·다른 토큰 같은 키 CONFLICT·getActionResult 복구", async () => {
    const q = await checkoutQuote(A, {
      kind: "DIRECT",
      variant_id: "v-b-27",
      quantity: 1,
    });
    assert.ok(q.ok);
    const r1 = await confirmCheckout(q.data.quote_token, A, "ui-077-dup");
    assert.ok(r1.ok, JSON.stringify(r1));

    const ordersBefore = await testOrders();
    const stockBefore = await stockOf("v-b-27");
    // 같은 키+같은 토큰 — 서버는 저장된 주문 결과를 재생한다(재실행 아님)
    const r2 = await confirmCheckout(q.data.quote_token, A, "ui-077-dup");
    assert.ok(r2.ok);
    assert.equal(r2.replayed, true);
    assert.equal(r2.data.order_id, r1.data.order_id);
    assert.equal((await testOrders()).length, ordersBefore.length);
    assert.equal(await stockOf("v-b-27"), stockBefore);

    // 응답 유실 복구 — 새 실행 없이 기존 action 조회로 주문을 되찾는다
    const rec = await getActionResult(A, {
      kind: "CHECKOUT",
      idempotency_key: "ui-077-dup",
    });
    assert.ok(rec.ok);
    assert.equal(rec.data.status, "SUCCEEDED");
    assert.equal(
      (rec.data.result as { order_id: string }).order_id,
      r1.data.order_id,
    );

    // 같은 키에 다른 견적 — payload 해시 충돌
    const q2 = await checkoutQuote(A, {
      kind: "DIRECT",
      variant_id: "v-b-27",
      quantity: 2,
    });
    assert.ok(q2.ok);
    const r3 = await confirmCheckout(q2.data.quote_token, A, "ui-077-dup");
    assert.ok(!r3.ok);
    if (!r3.ok) assert.equal(r3.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("DIRECT — 비정형 입력은 견적에서 거절된다", async () => {
    for (const bad of [
      { kind: "DIRECT", variant_id: "v-a-24", quantity: "2" }, // 문자열 수량
      { kind: "DIRECT", variant_id: "v-a-24", quantity: 0 },
      { kind: "DIRECT", variant_id: "", quantity: 1 },
      { kind: "DIRECT" }, // 필드 누락
      { kind: "UNKNOWN_KIND", variant_id: "v-a-24" }, // 알 수 없는 source
    ]) {
      const r = await checkoutQuote(A, bad as never);
      assert.ok(!r.ok, JSON.stringify(bad));
      if (!r.ok) assert.equal(r.error.code, "VALIDATION", JSON.stringify(bad));
    }
    const nf = await checkoutQuote(A, {
      kind: "DIRECT",
      variant_id: "v-none",
      quantity: 1,
    });
    assert.ok(!nf.ok);
    if (!nf.ok) assert.equal(nf.error.code, "NOT_FOUND");
  });

  test("CART_SELECTED — 견적 후 미선택 항목 변경은 주문을 무효화하지 않는다", async () => {
    await putInCart(A, "v-a-24", 1, "077-sel-add-a");
    await putInCart(A, "v-b-24", 1, "077-sel-add-b");
    const a = await cartItemOf(A, "v-a-24");
    const b = await cartItemOf(A, "v-b-24");

    const q = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [a.cart_item_id],
    });
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(q.data.source, "CART_SELECTED");
    assert.equal(q.data.items.length, 1);
    assert.equal(q.data.items[0].variant_id, "v-a-24");
    assert.equal(q.data.total_won, 183000);

    // 견적 이후 실제 카트 mutator가 미선택 행 수량을 바꾼다 — 선택 주문은 유효해야 한다
    const cartNow = await getCart(A);
    assert.ok(cartNow.ok);
    const up = await updateCartQuantity(
      {
        cart_item_id: b.cart_item_id,
        quantity: 2,
        expected_cart_version: cartNow.data.version,
        expected_variant_version: b.variant_version,
      },
      A,
      "077-sel-upd-b",
    );
    assert.ok(up.ok, JSON.stringify(up));

    const r = await confirmCheckout(q.data.quote_token, A, "ui-077-sel-1");
    assert.ok(r.ok, JSON.stringify(r));
    // 주문은 선택 행만 포함한다
    const items = await sql.unsafe<{ variant_id: string; quantity: number }[]>(
      "SELECT variant_id, quantity FROM order_items WHERE order_id=$1",
      [r.data.order_id],
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].variant_id, "v-a-24");

    // 선택 행만 삭제 — 미선택 행의 id·수량은 그대로, 버전은 confirm의 +1만
    const cartAfter = await getCart(A);
    assert.ok(cartAfter.ok);
    assert.equal(cartAfter.data.items.length, 1);
    assert.equal(cartAfter.data.items[0].cart_item_id, b.cart_item_id);
    assert.equal(cartAfter.data.items[0].quantity, 2);
    assert.equal(cartAfter.data.version, up.data.cart.version + 1);
  });

  test("CART_SELECTED — 빈 선택·중복·타인 행은 견적에서 거절된다", async () => {
    const empty = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [],
    });
    assert.ok(!empty.ok);
    if (!empty.ok) assert.equal(empty.error.code, "VALIDATION");
    const nonArray = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: "x" as never,
    });
    assert.ok(!nonArray.ok);
    if (!nonArray.ok) assert.equal(nonArray.error.code, "VALIDATION");

    await putInCart(A, "v-c-27", 1, "077-dup-c27");
    const c = await cartItemOf(A, "v-c-27");
    const dup = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [c.cart_item_id, c.cart_item_id],
    });
    assert.ok(!dup.ok);
    if (!dup.ok) assert.equal(dup.error.code, "VALIDATION");

    // 타인(u-b) 카트 행 — 소유 카트에서 찾을 수 없어 거절
    await putInCart(B, "v-c-32", 1, "077-b-c32");
    const foreign = await cartItemOf(B, "v-c-32");
    const fr = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [foreign.cart_item_id],
    });
    assert.ok(!fr.ok);
    if (!fr.ok) assert.equal(fr.error.code, "VALIDATION");
  });

  test("CART_SELECTED — confirm 시점에 선택 행의 가격·재고를 다시 검증한다", async () => {
    await putInCart(A, "v-c-32", 1, "077-rev-add");
    const c = await cartItemOf(A, "v-c-32");
    const q = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [c.cart_item_id],
    });
    assert.ok(q.ok);

    // 가격 변경 → STALE_QUOTE (REJECTED로 기록)
    await sql.unsafe(
      "UPDATE product_variants SET unit_price_won=unit_price_won+1000 WHERE id='v-c-32'",
    );
    const r1 = await confirmCheckout(q.data.quote_token, A, "ui-077-rev-1");
    assert.ok(!r1.ok);
    if (!r1.ok) assert.equal(r1.error.code, "STALE_QUOTE");
    assert.equal(r1.action_status, "REJECTED");
    await sql.unsafe(
      "UPDATE product_variants SET unit_price_won=349000 WHERE id='v-c-32'",
    );

    // 재고 0 → OUT_OF_STOCK (version은 건드리지 않는 직접 조정이라 version 검사는 통과)
    const q2 = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [c.cart_item_id],
    });
    assert.ok(q2.ok);
    await sql.unsafe(
      "UPDATE product_variants SET stock_qty=0 WHERE id='v-c-32'",
    );
    const r2 = await confirmCheckout(q2.data.quote_token, A, "ui-077-rev-2");
    assert.ok(!r2.ok);
    if (!r2.ok) assert.equal(r2.error.code, "OUT_OF_STOCK");
    await sql.unsafe(
      "UPDATE product_variants SET stock_qty=2 WHERE id='v-c-32'",
    );

    // 선택 행 자체를 견적 후 실제 mutator로 변경 — 수량 불일치로 confirm은
    // STALE_QUOTE 거절되고, 거절은 업무 상태를 바꾸지 않는다.
    const q3 = await checkoutQuote(A, {
      kind: "CART_SELECTED",
      cart_item_ids: [c.cart_item_id],
    });
    assert.ok(q3.ok);
    const cartV3 = await getCart(A);
    assert.ok(cartV3.ok);
    const upQty = await updateCartQuantity(
      {
        cart_item_id: c.cart_item_id,
        quantity: 2,
        expected_cart_version: cartV3.data.version,
        expected_variant_version: c.variant_version,
      },
      A,
      "077-rev-qty",
    );
    assert.ok(upQty.ok, JSON.stringify(upQty));
    // mutator 적용 후 상태가 거절 불변 비교의 baseline이다 — REJECTED 기록은
    // 정상이므로 bizSnap 대상(action_requests 제외)에 넣지 않는다
    const snapBeforeReject = await bizSnap(A, ["v-c-32"]);
    const r3 = await confirmCheckout(q3.data.quote_token, A, "ui-077-rev-3");
    assert.ok(!r3.ok);
    if (!r3.ok) assert.equal(r3.error.code, "STALE_QUOTE");
    assert.equal(r3.action_status, "REJECTED");
    assert.deepEqual(await bizSnap(A, ["v-c-32"]), snapBeforeReject);
    // fixture 원복 — 변경한 카트 행 수량을 되돌린다
    await sql.unsafe("UPDATE cart_items SET quantity=1 WHERE id=$1", [
      c.cart_item_id,
    ]);
  });

  test("토큰 위변조 — 구 서명은 VALIDATION, 유효 서명+모순 대상은 STALE_QUOTE로 REJECTED 기록", async () => {
    const q = await checkoutQuote(A, {
      kind: "DIRECT",
      variant_id: "v-a-24",
      quantity: 1,
    });
    assert.ok(q.ok);
    const payload = quotePayload(q.data.quote_token);
    // 거절 경로 3건의 업무 불변 비교 baseline — 주문/품목/결제/배송/재고/카트.
    // REJECTED된 action_requests 행은 정상 기록이므로 스냅샷 대상이 아니다.
    const bizBefore = await bizSnap(A, ["v-a-24", "v-b-24"]);

    // (1) 본문만 바꾸고 서명을 재계산하지 않은 위조 — 서명 검증이 거절한다.
    const tampered = {
      ...payload,
      items: payload.items.map((i) => ({ ...i, quantity: 99 })),
    };
    const badBody = Buffer.from(JSON.stringify(tampered)).toString("base64url");
    const forged = badBody + "." + q.data.quote_token.split(".")[1];
    const r1 = await confirmCheckout(forged, A, "ui-077-forge-1");
    assert.ok(!r1.ok);
    if (!r1.ok) assert.equal(r1.error.code, "VALIDATION");

    // (2) 유효 서명이지만 variant만 다른 옵션으로 바꿔 불변을 깬다 —
    // 서버 재검증이 실제 옵션 가격과 비교해 STALE_QUOTE로 거절·REJECTED 기록.
    const swapped = {
      ...payload,
      items: [{ ...payload.items[0], variant_id: "v-b-24" }],
    };
    const r2 = await confirmCheckout(
      signedQuoteToken(swapped),
      A,
      "ui-077-forge-2",
    );
    assert.ok(!r2.ok);
    if (!r2.ok) assert.equal(r2.error.code, "STALE_QUOTE");
    assert.equal(r2.action_status, "REJECTED");
    const rec = await getActionResult(A, {
      kind: "CHECKOUT",
      idempotency_key: "ui-077-forge-2",
    });
    assert.ok(rec.ok);
    assert.equal(rec.data.status, "REJECTED");
    assert.equal(rec.data.error_code, "STALE_QUOTE");

    // (3) 다른 사용자에게 발급된 유효 토큰 — user_id 불일치로 거절된다.
    const r3 = await confirmCheckout(q.data.quote_token, B, "ui-077-forge-3");
    assert.ok(!r3.ok);
    if (!r3.ok) assert.equal(r3.error.code, "VALIDATION");

    // 거절 3건 모두 업무 상태 불변 — 주문/품목/결제/배송 행 수·대상 재고·
    // 카트 내용에 0 변경. 유일한 쓰기는 (2)의 REJECTED action_requests다.
    assert.deepEqual(await bizSnap(A, ["v-a-24", "v-b-24"]), bizBefore);
  });
});

// sql 풀 연결이 남으면 테스트 서브프로세스가 종료하지 않아 --test 러너가 멈춘다.
// setup이 실패해 connectDb가 안 됐을 때는 닫을 pool이 없다 — ?.로 방어한다.
after(() => sql?.end());
