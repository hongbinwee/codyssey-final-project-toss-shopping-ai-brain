// W04 모의 결제. UI 전용: 견적 발급·확인 실행은 Agent Tool이 아니다.
// 견적 → 서명된 불투명 토큰(5분) → 확인 시 대상/가격/버전/재고를 재검증하고
// 재고 차감·주문/결제/배송 생성·카트 반영·실행 결과를 한 트랜잭션으로 커밋한다.
//
// 구매 대상 source [PMQA-067 — 사용자 C 통합 승인]:
// - CART_FULL: 기존 전체 카트 주문(legacy GET quote 호환). 카트 버전을 서명해
//   견적 후 카트의 어떤 변경이든 견적을 무효화한다.
// - CART_SELECTED: 카트 선택 항목만 주문 — 선택 행만 잠그고 재검증한 뒤 해당
//   행만 삭제, 미선택 ID·수량은 보존한다. 미선택 변경이 견적을 무효화하지
//   않도록 카트 버전은 서명하지 않고 선택 행 자체를 재검증한다.
// - DIRECT: 상품 상세 바로 구매 — getCart/getOrCreateCart·carts/cart_items
//   읽기·쓰기 0. 카트 버전을 임의로 만들어 넣지 않는다.
// 모든 업무 검증은 첫 write(재고 차감) 전에 끝낸다 — runAction은 fail 반환도
// 감사 기록과 함께 정상 커밋하므로 부분 업무 변경이 남지 않게 한다.
import { sql, type Q } from "./db.ts";
import { config } from "./config.ts";
import {
  ok, fail, err,
  type CartItemView, type CartView,
  type CheckoutItemView, type CheckoutQuoteView,
  type ToolResult,
} from "./contracts.ts";
import { FLAT_SHIPPING_FEE_WON } from "./catalog.ts";
import { cartView, getCart } from "./cart.ts";
import { runAction, type ActionResult, type SqlDb } from "./actions.ts";
import type { RequestContext } from "./session.ts";
import { createHmac, randomUUID } from "node:crypto";

const QUOTE_TTL_MS = 5 * 60 * 1000;
const QUOTE_V = 2;

type QuoteSource = "CART_FULL" | "CART_SELECTED" | "DIRECT";

interface QuoteItem {
  variant_id: string;
  cart_item_id?: string; // cart source만 — DIRECT에는 없다
  quantity: number;
  unit_price_won: number;
  variant_version: number;
}

interface QuotePayload {
  v: number;
  user_id: string;
  source: QuoteSource;
  cart_version?: number; // CART_FULL만 서명 — DIRECT는 만들지 않는다
  cart_item_ids?: string[]; // CART_SELECTED만
  items: QuoteItem[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  address: Record<string, string>;
  expires_at: string;
}

const sign = (body: string) =>
  createHmac("sha256", config.sessionSecret).update("checkout:" + body).digest("base64url");

// 견적 입력 — 서버 route가 body를 그대로 넘기고 여기서 형식을 검증·정규화한다.
// 필드는 검증 전까지 모두 unknown — kind 문자열만으로 타입을 좁히지 않는다.
export type CheckoutQuoteInput = {
  kind?: unknown;
  cart_item_ids?: unknown;
  variant_id?: unknown;
  quantity?: unknown;
};

type ResolvedTarget = {
  source: QuoteSource;
  lines: { item: CheckoutItemView; variant_version: number }[];
  cart: CartView | null;
  cart_version?: number;
  cart_item_ids?: string[];
};

const toLine = (
  i: CartItemView,
): { item: CheckoutItemView; variant_version: number } => ({
  item: {
    cart_item_id: i.cart_item_id,
    product_id: i.product_id,
    variant_id: i.variant_id,
    product_name: i.product_name,
    image: i.image,
    option_values: i.option_values,
    quantity: i.quantity,
    unit_price_won: i.unit_price_won,
  },
  variant_version: i.variant_version,
});

// 구매 대상을 서버 권한으로 해석한다 — 클라이언트 금액·선택 주장을 신뢰하지 않는다.
// kind가 알려진 문자열이어도 필드는 런타임 검증 후에만 사용한다.
async function resolveQuoteTarget(
  q: Q,
  ctx: RequestContext,
  source: CheckoutQuoteInput,
  trace_id: string,
): Promise<ToolResult<ResolvedTarget>> {
  // DIRECT — 카트에 접근하지 않는다(getCart/getOrCreateCart 호출 금지).
  if (source.kind === "DIRECT") {
    const vid = typeof source.variant_id === "string" ? source.variant_id : "";
    // 수량은 JSON number만 허용한다 — "2" 같은 문자열을 Number()로 통과시키지
    // 않는다. 쿼리 실행 전 형식 검증이다 [PMQA-067-R2 — string quantity 허점].
    const qty =
      typeof source.quantity === "number" ? source.quantity : Number.NaN;
    if (!vid || !Number.isSafeInteger(qty) || qty < 1)
      return fail(err("VALIDATION", "옵션과 수량을 확인해 주세요"), trace_id);
    const [v] = await q.unsafe<
      {
        id: string; product_id: string; option_values_json: Record<string, string>;
        unit_price_won: number; stock_qty: number; active: boolean; version: number;
        product_name: string; image_urls: string[] | null; product_active: boolean;
      }[]
    >(
      "SELECT v.id, v.product_id, v.option_values_json, v.unit_price_won, v.stock_qty, v.active, v.version, " +
        "p.name AS product_name, p.image_urls, p.active AS product_active " +
        "FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1",
      [vid],
    );
    if (!v) return fail(err("NOT_FOUND", "옵션을 찾을 수 없습니다"), trace_id);
    if (!v.product_active || !v.active)
      return fail(err("UNAVAILABLE", "판매 중인 옵션이 아닙니다", "REFRESH_AND_RECONFIRM"), trace_id);
    if (v.stock_qty < qty)
      return fail(
        err("OUT_OF_STOCK", "재고가 부족합니다 (남은 수량 " + v.stock_qty + ")", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );
    return ok(
      {
        source: "DIRECT",
        lines: [
          {
            item: {
              cart_item_id: null,
              product_id: v.product_id,
              variant_id: v.id,
              product_name: v.product_name,
              image: v.image_urls?.[0] ?? null,
              option_values: v.option_values_json,
              quantity: qty,
              unit_price_won: v.unit_price_won,
            },
            variant_version: v.version,
          },
        ],
        cart: null,
      },
      trace_id,
    );
  }

  // CART_SELECTED — 서버 소유 cart_item ID·현재 수량·옵션 가격으로 해석한다.
  if (source.kind === "CART_SELECTED") {
    const raw = source.cart_item_ids;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.some((i) => typeof i !== "string" || i.length === 0)
    )
      return fail(err("VALIDATION", "주문할 상품을 선택해 주세요"), trace_id);
    const ids = raw as string[];
    if (new Set(ids).size !== ids.length)
      return fail(err("VALIDATION", "같은 상품이 중복 선택되었습니다"), trace_id);
    const [cart] = await q.unsafe<{ id: string; version: number }[]>(
      "SELECT id, version FROM carts WHERE user_id=$1",
      [ctx.actorUserId],
    );
    if (!cart)
      return fail(err("VALIDATION", "카트가 비어 있습니다"), trace_id);
    const view = await cartView(q, cart, { itemIds: ids });
    if (view.items.length !== ids.length)
      return fail(err("VALIDATION", "카트에서 찾을 수 없는 상품이 있습니다"), trace_id);
    if (view.items.some((i) => !i.purchasable))
      return fail(
        err("CART_BLOCKED", "선택한 상품 중 주문할 수 없는 항목이 있습니다", "REFRESH_AND_RECONFIRM"),
        trace_id,
      );
    return ok(
      {
        source: "CART_SELECTED",
        lines: view.items.map(toLine),
        cart: view,
        cart_item_ids: view.items.map((i) => i.cart_item_id), // 소유 행 기준 정규화
      },
      trace_id,
    );
  }

  // CART_FULL — 명시적 legacy 호환. 알 수 없는 source는 거절한다(누락을
  // 전체 카트로 추정하지 않는다).
  if (source.kind !== "CART_FULL")
    return fail(err("VALIDATION", "알 수 없는 주문 대상입니다"), trace_id);
  const cartRes = await getCart(ctx, q);
  if (!cartRes.ok) return cartRes as never;
  const cart = cartRes.data;
  if (cart.items.length === 0)
    return fail(err("VALIDATION", "카트가 비어 있습니다", "STOP"), trace_id);
  if (!cart.can_checkout)
    return fail(
      err("CART_BLOCKED", "품절/판매중단 항목이 있습니다. 삭제 후 다시 시도하세요.", "REFRESH_AND_RECONFIRM"),
      trace_id,
    );
  return ok(
    {
      source: "CART_FULL",
      lines: cart.items.map(toLine),
      cart,
      cart_version: cart.version,
    },
    trace_id,
  );
}

// 견적 발급 — 주문/결제/배송 생성·재고 차감은 없어야 한다. CART_FULL은 기존
// getCart 계약상 카트 행 upsert가 동반된다(주문·재고와 무관한 카트 생성).
export async function checkoutQuote(
  ctx: RequestContext,
  source: CheckoutQuoteInput = { kind: "CART_FULL" },
  q: Q = sql,
): Promise<ToolResult<CheckoutQuoteView>> {
  const trace_id = crypto.randomUUID();
  const target = await resolveQuoteTarget(q, ctx, source, trace_id);
  if (!target.ok) return target as never;
  const t = target.data;

  const [u] = await q.unsafe<{ test_address_json: Record<string, string> }[]>(
    "SELECT test_address_json FROM users WHERE id=$1",
    [ctx.actorUserId],
  );
  if (!u?.test_address_json)
    return fail(err("VALIDATION", "배송지가 없습니다"), trace_id);

  const items_total_won = t.lines.reduce(
    (s, l) => s + l.item.unit_price_won * l.item.quantity,
    0,
  );
  const shipping_fee_won = t.lines.length > 0 ? FLAT_SHIPPING_FEE_WON : 0;
  const total_won = items_total_won + shipping_fee_won;

  const payload: QuotePayload = {
    v: QUOTE_V,
    user_id: ctx.actorUserId,
    source: t.source,
    ...(t.cart_version !== undefined ? { cart_version: t.cart_version } : {}),
    ...(t.cart_item_ids ? { cart_item_ids: t.cart_item_ids } : {}),
    items: t.lines.map((l) => ({
      variant_id: l.item.variant_id,
      ...(l.item.cart_item_id ? { cart_item_id: l.item.cart_item_id } : {}),
      quantity: l.item.quantity,
      unit_price_won: l.item.unit_price_won,
      variant_version: l.variant_version,
    })),
    items_total_won,
    shipping_fee_won,
    total_won,
    address: u.test_address_json,
    expires_at: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return ok(
    {
      quote_token: body + "." + sign(body),
      expires_at: payload.expires_at,
      source: t.source,
      items: t.lines.map((l) => l.item),
      items_total_won,
      shipping_fee_won,
      total_won,
      address: payload.address,
      cart: t.cart,
    },
    trace_id,
  );
}

// 서명·구조·source를 검증한다. v2 필드 누락을 legacy로 추정하지 않는다 —
// payload 전체가 v1 형식(cart_version 보유·source/v 부재)과 정확히 일치할
// 때만 명시적 legacy 전체 카트로 받아들인다.
function readQuoteToken(token: string, userId: string): QuotePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || sign(body) !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as QuotePayload;
    if (!p || p.user_id !== userId) return null;
    if (!Array.isArray(p.items) || p.items.length === 0) return null;
    if (!Number.isFinite(Date.parse(p.expires_at))) return null;
    if (p.v === QUOTE_V) {
      if (p.source !== "CART_FULL" && p.source !== "CART_SELECTED" && p.source !== "DIRECT")
        return null;
      if (p.source === "CART_FULL" && !Number.isInteger(p.cart_version)) return null;
      if (
        p.source === "CART_SELECTED" &&
        (!Array.isArray(p.cart_item_ids) ||
          p.cart_item_ids.length === 0 ||
          p.cart_item_ids.some((i) => typeof i !== "string" || i.length === 0))
      )
        return null;
    } else if (p.v === undefined && p.source === undefined) {
      // 명시적 legacy v1 — source/v가 없고 전체 카트 버전을 가진 기존 형식만 허용.
      // v2 토큰의 필드 누락은 여기에 해당하지 않는다(v 존재 → 위 분기에서 거절).
      if (!Number.isInteger(p.cart_version)) return null;
      p.source = "CART_FULL";
    } else {
      return null; // v 불일치·형식 혼합은 거절
    }
    for (const it of p.items) {
      if (
        !it ||
        typeof it.variant_id !== "string" ||
        !it.variant_id ||
        !Number.isInteger(it.quantity) ||
        it.quantity < 1 ||
        !Number.isInteger(it.unit_price_won) ||
        it.unit_price_won < 0 ||
        !Number.isInteger(it.variant_version)
      )
        return null;
      if (p.source === "CART_SELECTED" && (typeof it.cart_item_id !== "string" || !it.cart_item_id))
        return null;
    }
    // 서명 내용과 재계산의 정합 — 총액 위조를 걸러낸다.
    const itemsTotal = p.items.reduce((s, i) => s + i.unit_price_won * i.quantity, 0);
    if (
      itemsTotal !== p.items_total_won ||
      p.items_total_won + p.shipping_fee_won !== p.total_won
    )
      return null;
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
  db: SqlDb = sql,
): Promise<ActionResult<{ order_id: string; total_won: number }>> {
  return runAction(
    ctx,
    "CHECKOUT",
    idempotencyKey,
    { quote_token_hash: createHmac("sha256", config.sessionSecret).update("hash:" + quoteToken).digest("hex") },
    async (q) => {
      const trace_id = crypto.randomUUID();
      const quote = readQuoteToken(quoteToken, ctx.actorUserId);
      if (!quote)
        return fail(err("VALIDATION", "견적 토큰이 유효하지 않습니다", "STOP"), trace_id);
      if (!(Date.parse(quote.expires_at) > Date.now()))
        return fail(err("STALE_QUOTE", "견적이 만료되었습니다. 다시 견적을 받아주세요.", "REFRESH_AND_RECONFIRM"), trace_id);

      // 구매 대상 해석 — 모든 업무 검증은 첫 write(재고 차감) 전에 끝낸다.
      type Line = { cart_item_id: string | null; variant_id: string; quantity: number };
      let lines: Line[] = [];
      let cartId: string | null = null;
      let selectedIds: string[] | null = null;

      if (quote.source === "DIRECT") {
        // 카트 완전 무변경 — carts/cart_items SQL을 아예 실행하지 않는다.
        lines = quote.items.map((i) => ({
          cart_item_id: null,
          variant_id: i.variant_id,
          quantity: i.quantity,
        }));
      } else {
        const [cart] = await q.unsafe<{ id: string; version: number }[]>(
          "SELECT id, version FROM carts WHERE user_id=$1 FOR UPDATE",
          [ctx.actorUserId],
        );
        if (!cart)
          return fail(err("STALE_QUOTE", "카트를 찾을 수 없습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
        cartId = cart.id;

        if (quote.source === "CART_FULL") {
          // legacy — 카트 버전 + 전체 구성을 견적 시점과 비교한다.
          if (cart.version !== quote.cart_version)
            return fail(err("STALE_QUOTE", "카트가 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);
          const rows = await q.unsafe<{ id: string; variant_id: string; quantity: number }[]>(
            "SELECT id, variant_id, quantity FROM cart_items WHERE cart_id=$1 FOR UPDATE",
            [cart.id],
          );
          if (rows.length !== quote.items.length)
            return fail(err("STALE_QUOTE", "카트 구성이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
          const byVariant = new Map(rows.map((r) => [r.variant_id, r]));
          for (const it of quote.items) {
            const row = byVariant.get(it.variant_id);
            if (!row || row.quantity !== it.quantity)
              return fail(err("STALE_QUOTE", "수량이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
            lines.push({ cart_item_id: row.id, variant_id: it.variant_id, quantity: it.quantity });
          }
        } else {
          // CART_SELECTED — 카트 버전은 보지 않고 선택 행만 잠궈 재검증한다.
          // 미선택 행의 수량/삭제는 이 주문을 무효화하지 않는다.
          selectedIds = quote.cart_item_ids!;
          const rows = await q.unsafe<{ id: string; variant_id: string; quantity: number }[]>(
            "SELECT id, variant_id, quantity FROM cart_items WHERE cart_id=$1 AND id = ANY($2) FOR UPDATE",
            [cart.id, selectedIds],
          );
          if (rows.length !== selectedIds.length)
            return fail(err("STALE_QUOTE", "카트 구성이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
          const byId = new Map(rows.map((r) => [r.id, r]));
          for (const it of quote.items) {
            const row = it.cart_item_id ? byId.get(it.cart_item_id) : undefined;
            if (!row || row.variant_id !== it.variant_id || row.quantity !== it.quantity)
              return fail(err("STALE_QUOTE", "수량이 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
            lines.push({ cart_item_id: row.id, variant_id: it.variant_id, quantity: it.quantity });
          }
        }
      }

      // 옵션 잠금 + 가격/버전/재고 재검증 → 차감 (결정적 순서로 잠근다)
      const variantIds = [...new Set(lines.map((l) => l.variant_id))].sort();
      const variants = await q.unsafe<
        { id: string; version: number; stock_qty: number; unit_price_won: number; active: boolean; product_active: boolean; product_name: string; option_values_json: Record<string, string> }[]
      >(
        "SELECT v.id, v.version, v.stock_qty, v.unit_price_won, v.active, p.active AS product_active, p.name AS product_name, v.option_values_json " +
          "FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id = ANY($1) ORDER BY v.id FOR UPDATE OF v",
        [variantIds],
      );
      const byV = new Map(variants.map((v) => [v.id, v]));
      const quoted = new Map(quote.items.map((i) => [i.variant_id, i]));
      for (const l of lines) {
        const expect_ = quoted.get(l.variant_id)!;
        const v = byV.get(l.variant_id);
        if (!v)
          return fail(err("STALE_QUOTE", "상품 정보가 변경되었습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
        if (!v.product_active || !v.active)
          return fail(err("UNAVAILABLE", "판매 중이 아닌 옵션이 있습니다.", "REFRESH_AND_RECONFIRM"), trace_id);
        if (v.version !== expect_.variant_version || v.unit_price_won !== expect_.unit_price_won)
          return fail(err("STALE_QUOTE", "가격/옵션 정보가 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);
        if (v.stock_qty < l.quantity)
          return fail(err("OUT_OF_STOCK", "재고가 부족합니다 (남은 수량 " + v.stock_qty + ")", "REFRESH_AND_RECONFIRM"), trace_id);
      }

      // 첫 write — 재고 차감. 이후 오류는 예외로 rollback된다.
      for (const l of lines)
        await q.unsafe(
          "UPDATE product_variants SET stock_qty=stock_qty-$2, version=version+1 WHERE id=$1",
          [l.variant_id, l.quantity],
        );

      // 주문/주문항목(스냅샷)/결제/배송 생성
      const orderId = "ord-" + randomUUID().slice(0, 8);
      await q.unsafe(
        "INSERT INTO orders (id, user_id, status, items_total_won, shipping_fee_won, total_won, address_snapshot_json) " +
          "VALUES ($1,$2,'CONFIRMED',$3,$4,$5,$6::jsonb)",
        [orderId, ctx.actorUserId, quote.items_total_won, quote.shipping_fee_won, quote.total_won, quote.address],
      );
      for (const l of lines) {
        const v = byV.get(l.variant_id)!;
        await q.unsafe(
          "INSERT INTO order_items (id, order_id, variant_id, product_name_snapshot, option_snapshot_json, unit_price_won, quantity, line_total_won) " +
            "VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
          [randomUUID(), orderId, l.variant_id, v.product_name, v.option_values_json, v.unit_price_won, l.quantity, v.unit_price_won * l.quantity],
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

      // 카트 반영 — source별 범위. DIRECT는 cartId 자체가 없다(쓰기 0).
      if (cartId) {
        if (selectedIds)
          // 선택 행만 삭제 — 미선택 ID·수량은 그대로 남는다.
          await q.unsafe("DELETE FROM cart_items WHERE cart_id=$1 AND id = ANY($2)", [cartId, selectedIds]);
        else
          await q.unsafe("DELETE FROM cart_items WHERE cart_id=$1", [cartId]);
        await q.unsafe("UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1", [cartId]);
      }

      return ok({ order_id: orderId, total_won: quote.total_won }, trace_id);
    },
    db,
  );
}
