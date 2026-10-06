// W04 모의 결제. UI 전용: 견적 발급·확인 실행은 Agent Tool이 아니다.
// 견적 → 서명된 불투명 토큰(5분) → 확인 시 카트/옵션 버전·가격·재고를 재검증하고
// 재고 차감·주문/결제/배송 생성·카트 비우기·실행 결과를 한 트랜잭션으로 커밋한다.
import { sql } from "./db.ts";
import { config } from "./config.ts";
import { ok, fail, err, type CheckoutQuoteView, type ToolResult } from "./contracts.ts";
import { FLAT_SHIPPING_FEE_WON } from "./catalog.ts";
import { getCart } from "./cart.ts";
import { runAction, type ActionResult } from "./actions.ts";
import type { RequestContext } from "./session.ts";
import { createHmac, randomUUID } from "node:crypto";

const QUOTE_TTL_MS = 5 * 60 * 1000;

interface QuotePayload {
  user_id: string;
  cart_version: number;
  items: { variant_id: string; quantity: number; unit_price_won: number; variant_version: number }[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  address: Record<string, string>;
  expires_at: string;
}

const sign = (body: string) =>
  createHmac("sha256", config.sessionSecret).update("checkout:" + body).digest("base64url");

export async function checkoutQuote(
  ctx: RequestContext,
): Promise<ToolResult<CheckoutQuoteView>> {
  const trace_id = crypto.randomUUID();
  const cartRes = await getCart(ctx);
  if (!cartRes.ok) return cartRes as never;
  const cart = cartRes.data;
  if (cart.items.length === 0)
    return fail(err("VALIDATION", "카트가 비어 있습니다", "STOP"), trace_id);
  if (!cart.can_checkout)
    return fail(
      err("CART_BLOCKED", "품절/판매중단 항목이 있습니다. 삭제 후 다시 시도하세요.", "REFRESH_AND_RECONFIRM"),
      trace_id,
    );
  const [u] = await sql.unsafe<{ test_address_json: Record<string, string> }[]>(
    "SELECT test_address_json FROM users WHERE id=$1",
    [ctx.actorUserId],
  );
  if (!u?.test_address_json)
    return fail(err("VALIDATION", "배송지가 없습니다"), trace_id);

  const payload: QuotePayload = {
    user_id: ctx.actorUserId,
    cart_version: cart.version,
    items: cart.items.map((i) => ({
      variant_id: i.variant_id,
      quantity: i.quantity,
      unit_price_won: i.unit_price_won,
      variant_version: i.variant_version,
    })),
    items_total_won: cart.items_total_won,
    shipping_fee_won: cart.shipping_fee_won,
    total_won: cart.total_won,
    address: u.test_address_json,
    expires_at: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return ok(
    {
      quote_token: body + "." + sign(body),
      expires_at: payload.expires_at,
      cart,
      address: payload.address,
    },
    trace_id,
  );
}

function readQuoteToken(token: string, userId: string): QuotePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || sign(body) !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as QuotePayload;
    if (p.user_id !== userId) return null;
    return p;
  } catch {
    return null;
  }
}

// 사용자 확인 후의 최종 실행. 같은 키 재전송은 저장된 주문 결과를 복원한다.
export async function confirmCheckout(
  quoteToken: string,
  ctx: RequestContext,
  idempotencyKey: string,
): Promise<ActionResult<{ order_id: string; total_won: number }>> {
  return runAction(ctx, "CHECKOUT", idempotencyKey, { quote_token_hash: createHmac("sha256", config.sessionSecret).update("hash:" + quoteToken).digest("hex") }, async (q) => {
    const trace_id = crypto.randomUUID();
    const quote = readQuoteToken(quoteToken, ctx.actorUserId);
    if (!quote)
      return fail(err("VALIDATION", "견적 토큰이 유효하지 않습니다", "STOP"), trace_id);
    if (new Date(quote.expires_at).getTime() < Date.now())
      return fail(err("STALE_QUOTE", "견적이 만료되었습니다. 다시 견적을 받아주세요.", "REFRESH_AND_RECONFIRM"), trace_id);

    // 카트 잠금 → 견적 시점 버전 검증
    const [cart] = await q.unsafe<{ id: string; version: number }[]>(
      "SELECT id, version FROM carts WHERE user_id=$1 FOR UPDATE",
      [ctx.actorUserId],
    );
    if (!cart || cart.version !== quote.cart_version)
      return fail(err("STALE_QUOTE", "카트가 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);

    const cartItems = await q.unsafe<{ id: string; variant_id: string; quantity: number }[]>(
      "SELECT id, variant_id, quantity FROM cart_items WHERE cart_id=$1 FOR UPDATE",
      [cart.id],
    );
    const quoted = new Map(quote.items.map((i) => [i.variant_id, i]));
    if (cartItems.length !== quote.items.length)
      return fail(err("STALE_QUOTE", "카트 구성이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);

    // 옵션 잠금 + 가격/버전/재고 재검증 → 차감 (결정적 순서로 잠근다)
    const variantIds = [...new Set(quote.items.map((i) => i.variant_id))].sort();
    const variants = await q.unsafe<
      { id: string; version: number; stock_qty: number; unit_price_won: number; active: boolean; product_active: boolean; product_name: string; option_values_json: Record<string, string> }[]
    >(
      "SELECT v.id, v.version, v.stock_qty, v.unit_price_won, v.active, p.active AS product_active, p.name AS product_name, v.option_values_json " +
        "FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id = ANY($1) ORDER BY v.id FOR UPDATE OF v",
      [variantIds],
    );
    const byV = new Map(variants.map((v) => [v.id, v]));
    for (const it of cartItems) {
      const expect_ = quoted.get(it.variant_id);
      const v = byV.get(it.variant_id);
      if (!expect_ || !v)
        return fail(err("STALE_QUOTE", "카트 구성이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
      if (it.quantity !== expect_.quantity)
        return fail(err("STALE_QUOTE", "수량이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
      if (!v.product_active || !v.active)
        return fail(err("UNAVAILABLE", "판매 중이 아닌 옵션이 있습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
      if (v.version !== expect_.variant_version || v.unit_price_won !== expect_.unit_price_won)
        return fail(err("STALE_QUOTE", "가격/옵션 정보가 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);
      if (v.stock_qty < it.quantity)
        return fail(err("OUT_OF_STOCK", "재고가 부족합니다 (남은 수량 " + v.stock_qty + ")", "REFRESH_AND_RECONFIRM"), trace_id);
    }
    for (const it of cartItems)
      await q.unsafe(
        "UPDATE product_variants SET stock_qty=stock_qty-$2, version=version+1 WHERE id=$1",
        [it.variant_id, it.quantity],
      );

    // 주문/주문항목(스냅샷)/결제/배송 생성
    const orderId = "ord-" + randomUUID().slice(0, 8);
    await q.unsafe(
      "INSERT INTO orders (id, user_id, status, items_total_won, shipping_fee_won, total_won, address_snapshot_json) " +
        "VALUES ($1,$2,'CONFIRMED',$3,$4,$5,$6::jsonb)",
      [orderId, ctx.actorUserId, quote.items_total_won, quote.shipping_fee_won, quote.total_won, quote.address],
    );
    for (const it of cartItems) {
      const v = byV.get(it.variant_id)!;
      await q.unsafe(
          "INSERT INTO order_items (id, order_id, variant_id, product_name_snapshot, option_snapshot_json, unit_price_won, quantity, line_total_won) " +
            "VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
          [randomUUID(), orderId, it.variant_id, v.product_name, v.option_values_json, v.unit_price_won, it.quantity, v.unit_price_won * it.quantity],
      );
    }
    await q.unsafe(
      "INSERT INTO payments (id, order_id, method, status, paid_amount_won) VALUES ($1,$2,'SIMULATED','PAID',$3)",
      [randomUUID(), orderId, quote.total_won],
    );
    const firstEvent = [{ status: "PREPARING", occurred_at: new Date().toISOString(), note: "주문 접수 (모의)" }];
    await q.unsafe(
      "INSERT INTO shipments (id, order_id, status, events_json) VALUES ($1,$2,'PREPARING',$3::jsonb)",
      [randomUUID(), orderId, firstEvent],
    );

    // 카트 비우기 + 버전 증가 — 모두 같은 트랜잭션
    await q.unsafe("DELETE FROM cart_items WHERE cart_id=$1", [cart.id]);
    await q.unsafe("UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1", [cart.id]);

    return ok({ order_id: orderId, total_won: quote.total_won }, trace_id);
  });
}
