// Phase 3 모의 결제·주문 생성 검증. 핵심: 원자성·중복 차단·동시 재고·Agent 우회 불가.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { addToCart, getCart } from "../../src/cart.ts";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import { getActionResult } from "../../src/actions.ts";
import { executeTool, toolDefs } from "../../src/agent.ts";
import { sql } from "../../src/db.ts";

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
    assert.equal(q.data.cart.total_won, 183000);
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

// sql 풀 연결이 남으면 테스트 서브프로세스가 종료하지 않아 --test 러너가 멈춘다.
after(() => sql.end());
