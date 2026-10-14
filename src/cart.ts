// 카트 서비스. 화면 API와 Agent Tool이 같은 함수를 사용한다.
// 담기는 재고 예약이 아니며, 결제 시 재고를 다시 검증한다(Phase 3).
import { sql, type Q } from "./db.ts";
import {
  ok, fail, err,
  type CartItemView, type CartView, type ToolResult,
} from "./contracts.ts";
import { FLAT_SHIPPING_FEE_WON, variantAvailability } from "./catalog.ts";
import { runAction, type ActionResult } from "./actions.ts";
import type { RequestContext } from "./session.ts";
import { randomUUID } from "node:crypto";

async function getOrCreateCart(userId: string, db: Q = sql): Promise<{ id: string; version: number }> {
  const rows = await db.unsafe<{ id: string; version: number }[]>(
    "INSERT INTO carts (id, user_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET user_id=$2 RETURNING id, version",
    ["cart-" + userId, userId],
  );
  return rows[0];
}

// 카트 뷰 조립. 같은 쿼리/계산을 getCart와 addToCart 커밋 전 미리보기가 공유한다.
// opts.itemIds를 주면 해당 cart_item 행만 뷰로 만든다 — checkout의
// CART_SELECTED 견적이 같은 뷰 계약으로 부분집합을 표시한다 [PMQA-067].
export async function cartView(
  q: Q,
  cart: { id: string; version: number },
  opts?: { itemIds?: string[] },
): Promise<CartView> {
  const rows = opts?.itemIds
    ? await q.unsafe(
        `SELECT ci.id AS cart_item_id, ci.quantity, ci.variant_id,
                v.product_id, v.option_values_json, v.unit_price_won, v.stock_qty,
                v.active AS variant_active, v.version AS variant_version,
                p.name AS product_name, p.image_urls, p.active AS product_active
         FROM cart_items ci
         JOIN product_variants v ON v.id = ci.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE ci.cart_id = $1 AND ci.id = ANY($2) ORDER BY ci.id`,
        [cart.id, opts.itemIds],
      )
    : await q.unsafe(
        `SELECT ci.id AS cart_item_id, ci.quantity, ci.variant_id,
                v.product_id, v.option_values_json, v.unit_price_won, v.stock_qty,
                v.active AS variant_active, v.version AS variant_version,
                p.name AS product_name, p.image_urls, p.active AS product_active
         FROM cart_items ci
         JOIN product_variants v ON v.id = ci.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE ci.cart_id = $1 ORDER BY ci.id`,
        [cart.id],
      );
  const items: CartItemView[] = rows.map((r) => {
    const av = variantAvailability(r.product_active, r.variant_active, r.stock_qty);
    return {
      cart_item_id: r.cart_item_id,
      product_id: r.product_id,
      variant_id: r.variant_id,
      product_name: r.product_name,
      image: r.image_urls?.[0] ?? null,
      option_values: r.option_values_json,
      quantity: r.quantity,
      unit_price_won: r.unit_price_won,
      variant_version: r.variant_version,
      availability: av,
      purchasable: av === "AVAILABLE",
      block_reason:
        av === "AVAILABLE" ? null : av === "SOLD_OUT" ? "품절" : "판매 중단",
    };
  });
  const items_total_won = items.reduce(
    (s, i) => s + i.unit_price_won * i.quantity,
    0,
  );
  const shipping_fee_won = items.length > 0 ? FLAT_SHIPPING_FEE_WON : 0;
  return {
    cart_id: cart.id,
    version: cart.version,
    items,
    items_total_won,
    shipping_fee_won,
    total_won: items_total_won + shipping_fee_won,
    can_checkout: items.length > 0 && items.every((i) => i.purchasable),
  };
}

export async function getCart(ctx: RequestContext, db: Q = sql): Promise<ToolResult<CartView>> {
  const trace_id = crypto.randomUUID();
  const cart = await getOrCreateCart(ctx.actorUserId, db);
  return ok(await cartView(db, cart), trace_id);
}

export type AddToCartInput = {
  variant_id: string;
  quantity: number;
  expected_cart_version: number;
  expected_variant_version: number;
};

// ctx 세션 주체의 카트에만 적용된다. 입력의 user_id 같은 필드는 허용하지 않는다.
export async function addToCart(
  input: AddToCartInput,
  ctx: RequestContext,
  idempotencyKey: string,
): Promise<ActionResult<{ cart: CartView; changed_item_id: string; added_quantity: number }>> {
  return runAction(ctx, "ADD_CART", idempotencyKey, input, async (q) => {
    const trace_id = crypto.randomUUID();
    if (
      !input.variant_id ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1
    )
      return fail(err("VALIDATION", "variant_id와 1 이상의 수량이 필요합니다"), trace_id);

    // 카트 행을 잠그고 카트 기준으로 변경을 직렬화한다.
    const carts = await q.unsafe<{ id: string; version: number }[]>(
      "SELECT id, version FROM carts WHERE user_id=$1 FOR UPDATE",
      [ctx.actorUserId],
    );
    const cart =
      carts[0] ??
      (await q.unsafe<{ id: string; version: number }[]>(
        "INSERT INTO carts (id, user_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET user_id=$2 RETURNING id, version",
        ["cart-" + ctx.actorUserId, ctx.actorUserId],
      ))[0];
    if (cart.version !== input.expected_cart_version)
      return fail(
        err("VERSION_CONFLICT", "카트가 변경되었습니다. 최신 상태를 다시 확인하세요.", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );

    const vs = await q.unsafe<{ id: string; version: number; stock_qty: number; unit_price_won: number; active: boolean; product_active: boolean }[]>(
      `SELECT v.*, p.active AS product_active FROM product_variants v
        JOIN products p ON p.id = v.product_id WHERE v.id = $1 FOR UPDATE OF v`,
      [input.variant_id],
    );
    const v = vs[0];
    if (!v) return fail(err("NOT_FOUND", "옵션을 찾을 수 없습니다"), trace_id);
    if (!v.product_active || !v.active)
      return fail(err("UNAVAILABLE", "판매 중인 옵션이 아닙니다"), trace_id);
    if (v.version !== input.expected_variant_version)
      return fail(
        err("VERSION_CONFLICT", "옵션 정보가 변경되었습니다. 다시 확인하세요.", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );

    const existing = await q.unsafe<{ id: string; quantity: number }[]>(
      "SELECT id, quantity FROM cart_items WHERE cart_id=$1 AND variant_id=$2",
      [cart.id, input.variant_id],
    );
    const mergedQty = (existing[0]?.quantity ?? 0) + input.quantity;
    if (mergedQty > v.stock_qty)
      return fail(
        err("OUT_OF_STOCK", "재고가 부족합니다 (남은 수량 " + v.stock_qty + ")", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );

    let itemId: string;
    if (existing[0]) {
      itemId = existing[0].id;
      await q.unsafe("UPDATE cart_items SET quantity=$2 WHERE id=$1", [
        itemId,
        mergedQty,
      ]);
    } else {
      itemId = randomUUID();
      await q.unsafe(
        "INSERT INTO cart_items (id, cart_id, variant_id, quantity) VALUES ($1,$2,$3,$4)",
        [itemId, cart.id, input.variant_id, input.quantity],
      );
    }
    await q.unsafe(
      "UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1",
      [cart.id],
    );
    return ok(
      {
        cart: await cartView(q, { id: cart.id, version: cart.version + 1 }),
        changed_item_id: itemId,
        added_quantity: input.quantity,
      },
      trace_id,
    );
  });
}

export type UpdateCartQtyInput = {
  cart_item_id: string;
  quantity: number; // 최종 수량
  expected_cart_version: number;
  expected_variant_version: number;
};

export type RemoveCartItemInput = {
  cart_item_id: string;
  expected_cart_version: number;
};

// 카트 행 잠금 + 버전 검사. update/remove가 공유하는 전처리다.
async function lockCartForWrite(
  q: Q,
  ctx: RequestContext,
  expectedVersion: number,
  trace_id: string,
): Promise<ToolResult<{ id: string; version: number }>> {
  const carts = await q.unsafe<{ id: string; version: number }[]>(
    "SELECT id, version FROM carts WHERE user_id=$1 FOR UPDATE",
    [ctx.actorUserId],
  );
  const cart = carts[0];
  if (!cart) return fail(err("NOT_FOUND", "카트가 없습니다"), trace_id);
  if (cart.version !== expectedVersion)
    return fail(
      err("VERSION_CONFLICT", "카트가 변경되었습니다. 최신 상태를 다시 확인하세요.", "REFRESH_AND_RECONFIRM"),
      trace_id,
    );
  return ok(cart, trace_id);
}

// 카트 항목의 최종 수량을 바꾼다. 재고는 건드리지 않는다(주문 시점 검증은 Phase 3).
export async function updateCartQuantity(
  input: UpdateCartQtyInput,
  ctx: RequestContext,
  idempotencyKey: string,
): Promise<ActionResult<{ cart: CartView; changed_item_id: string }>> {
  return runAction(ctx, "UPDATE_CART", idempotencyKey, input, async (q) => {
    const trace_id = crypto.randomUUID();
    if (
      !input.cart_item_id ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1
    )
      return fail(err("VALIDATION", "cart_item_id와 1 이상의 최종 수량이 필요합니다"), trace_id);

    const locked = await lockCartForWrite(q, ctx, input.expected_cart_version, trace_id);
    if (!locked.ok) return locked;
    const cart = locked.data;

    const rows = await q.unsafe<
      {
        id: string; quantity: number; variant_id: string; variant_version: number;
        stock_qty: number; variant_active: boolean; product_active: boolean;
      }[]
    >(
      "SELECT ci.id, ci.quantity, v.id AS variant_id, v.version AS variant_version, v.stock_qty, v.active AS variant_active, p.active AS product_active " +
        "FROM cart_items ci JOIN product_variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id " +
        "WHERE ci.id=$1 AND ci.cart_id=$2 FOR UPDATE OF ci, v",
      [input.cart_item_id, cart.id],
    );
    const item = rows[0];
    if (!item) return fail(err("NOT_FOUND", "카트에 없는 항목입니다"), trace_id);
    if (item.variant_version !== input.expected_variant_version)
      return fail(
        err("VERSION_CONFLICT", "옵션 정보가 변경되었습니다. 다시 확인하세요.", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );
    if (input.quantity > item.stock_qty)
      return fail(
        err("OUT_OF_STOCK", "재고가 부족합니다 (남은 수량 " + item.stock_qty + ")", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );

    await q.unsafe("UPDATE cart_items SET quantity=$2 WHERE id=$1", [
      input.cart_item_id,
      input.quantity,
    ]);
    await q.unsafe(
      "UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1",
      [cart.id],
    );
    return ok(
      {
        cart: await cartView(q, { id: cart.id, version: cart.version + 1 }),
        changed_item_id: input.cart_item_id,
      },
      trace_id,
    );
  });
}

// 카트 항목 삭제. 품절/비활성 항목도 삭제를 막지 않는다.
export async function removeCartItem(
  input: RemoveCartItemInput,
  ctx: RequestContext,
  idempotencyKey: string,
): Promise<ActionResult<{ cart: CartView; removed_item_id: string }>> {
  return runAction(ctx, "REMOVE_CART", idempotencyKey, input, async (q) => {
    const trace_id = crypto.randomUUID();
    if (!input.cart_item_id)
      return fail(err("VALIDATION", "cart_item_id가 필요합니다"), trace_id);

    const locked = await lockCartForWrite(q, ctx, input.expected_cart_version, trace_id);
    if (!locked.ok) return locked;
    const cart = locked.data;

    const deleted = await q.unsafe<{ id: string }[]>(
      "DELETE FROM cart_items WHERE id=$1 AND cart_id=$2 RETURNING id",
      [input.cart_item_id, cart.id],
    );
    if (!deleted[0]) return fail(err("NOT_FOUND", "카트에 없는 항목입니다"), trace_id);

    await q.unsafe(
      "UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1",
      [cart.id],
    );
    return ok(
      {
        cart: await cartView(q, { id: cart.id, version: cart.version + 1 }),
        removed_item_id: input.cart_item_id,
      },
      trace_id,
    );
  });
}
