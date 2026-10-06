// 주문/결제/배송 조회 + 내부 배송 전환. 화면 API와 CS Tool이 같은 함수를 쓴다.
// 소유권: 항상 ctx.actorUserId로 스코프 — 다른 사용자 주문은 NOT_FOUND.
import { sql } from "./db.ts";
import type postgres from "postgres";
import {
  ok, fail, err,
  type OrderListItem, type OrderView, type ShipmentEvent,
  type ShippingStatusResult, type ToolResult,
} from "./contracts.ts";
import type { RequestContext } from "./session.ts";

type OrderRow = {
  id: string; user_id: string; status: "CONFIRMED" | "CANCELLED";
  items_total_won: number; shipping_fee_won: number; total_won: number;
  address_snapshot_json: Record<string, string>;
  version: number; created_at: string; cancelled_at: string | null;
};

const encCursor = (o: number) => Buffer.from(String(o)).toString("base64url");
const decCursor = (c?: string) => {
  if (!c) return 0;
  if (!/^[A-Za-z0-9_-]+$/.test(c)) return -1;
  const s = Buffer.from(c, "base64url").toString();
  return /^[0-9]+$/.test(s) ? Number(s) : -1;
};

export async function listOrders(
  ctx: RequestContext,
  input: { cursor?: string; limit?: number } = {},
): Promise<ToolResult<{ orders: OrderListItem[]; next_cursor: string | null; has_more: boolean }>> {
  const trace_id = crypto.randomUUID();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const offset = decCursor(input.cursor);
  if (offset < 0) return fail(err("VALIDATION", "invalid cursor"), trace_id);

  const rows = await sql.unsafe<
    (OrderRow & { first_name: string; item_count: number })[]
  >(
    "SELECT o.*, i.first_name, i.item_count FROM orders o " +
    "JOIN LATERAL (SELECT (array_agg(product_name_snapshot ORDER BY id))[1] AS first_name, count(*)::int AS item_count " +
    "FROM order_items WHERE order_id = o.id) i ON true " +
    "WHERE o.user_id = $1 ORDER BY o.created_at DESC, o.id LIMIT $2 OFFSET $3",
    [ctx.actorUserId, limit + 1, offset],
  );
  const has_more = rows.length > limit;
  const page = rows.slice(0, limit);

  const ids = page.map((r) => r.id);
  const ships = ids.length
    ? await sql.unsafe<{ order_id: string; status: string }[]>(
        "SELECT order_id, status FROM shipments WHERE order_id = ANY($1)",
        [ids],
      )
    : [];
  const pays = ids.length
    ? await sql.unsafe<{ order_id: string; status: string; refund_status: string }[]>(
        "SELECT order_id, status, refund_status FROM payments WHERE order_id = ANY($1)",
        [ids],
      )
    : [];
  const shipBy = new Map(ships.map((s) => [s.order_id, s.status]));
  const payBy = new Map(pays.map((p) => [p.order_id, p]));

  const orders: OrderListItem[] = page.map((o) => ({
    id: o.id,
    created_at: new Date(o.created_at).toISOString(),
    item_summary:
      o.first_name + (o.item_count > 1 ? " 외 " + (o.item_count - 1) + "건" : ""),
    total_won: o.total_won,
    order_status: o.status,
    payment_status: payBy.get(o.id)?.status ?? null,
    shipping_status: shipBy.get(o.id) ?? null,
    refund_status: payBy.get(o.id)?.refund_status ?? null,
  }));
  return ok(
    {
      orders,
      next_cursor: has_more ? encCursor(offset + limit) : null,
      has_more,
    },
    trace_id,
  );
}

export async function getOrder(
  ctx: RequestContext,
  orderId: string,
): Promise<ToolResult<OrderView>> {
  const trace_id = crypto.randomUUID();
  const [o] = await sql.unsafe<OrderRow[]>(
    "SELECT * FROM orders WHERE id=$1 AND user_id=$2",
    [orderId, ctx.actorUserId],
  );
  if (!o) return fail(err("NOT_FOUND", "주문을 찾을 수 없습니다"), trace_id);

  const items = await sql.unsafe<
    {
      id: string; variant_id: string; product_name_snapshot: string;
      option_snapshot_json: Record<string, string>; unit_price_won: number;
      quantity: number; line_total_won: number;
    }[]
  >("SELECT * FROM order_items WHERE order_id=$1 ORDER BY id", [o.id]);

  const [pay] = await sql.unsafe<
    {
      status: "PAID"; paid_amount_won: number; paid_at: string;
      refund_status: "NONE" | "PENDING" | "REFUNDED";
      refunded_amount_won: number; refunded_at: string | null;
    }[]
  >("SELECT * FROM payments WHERE order_id=$1", [o.id]);

  const [ship] = await sql.unsafe<
    {
      status: ShipmentEvent["status"]; events_json: ShipmentEvent[];
      estimated_arrival_at: string | null; updated_at: string;
    }[]
  >("SELECT * FROM shipments WHERE order_id=$1", [o.id]);

  return ok(
    {
      id: o.id,
      version: o.version,
      status: o.status,
      created_at: new Date(o.created_at).toISOString(),
      cancelled_at: o.cancelled_at ? new Date(o.cancelled_at).toISOString() : null,
      items: items.map((i) => ({
        order_item_id: i.id,
        variant_id: i.variant_id,
        product_name: i.product_name_snapshot,
        option_values: i.option_snapshot_json,
        unit_price_won: i.unit_price_won,
        quantity: i.quantity,
        line_total_won: i.line_total_won,
      })),
      items_total_won: o.items_total_won,
      shipping_fee_won: o.shipping_fee_won,
      total_won: o.total_won,
      address_snapshot: o.address_snapshot_json,
      payment: pay
        ? {
            status: pay.status,
            paid_amount_won: pay.paid_amount_won,
            paid_at: new Date(pay.paid_at).toISOString(),
            refund_status: pay.refund_status,
            refunded_amount_won: pay.refunded_amount_won,
            refunded_at: pay.refunded_at ? new Date(pay.refunded_at).toISOString() : null,
          }
        : null,
      shipping: ship
        ? {
            status: ship.status,
            events: ship.events_json,
            estimated_arrival_at: ship.estimated_arrival_at
              ? new Date(ship.estimated_arrival_at).toISOString()
              : null,
            updated_at: new Date(ship.updated_at).toISOString(),
          }
        : null,
      cancel_request: null, // Phase 4에서 채움
    },
    trace_id,
  );
}

export async function getShippingStatus(
  ctx: RequestContext,
  orderId: string,
): Promise<ToolResult<ShippingStatusResult>> {
  const trace_id = crypto.randomUUID();
  const [o] = await sql.unsafe<{ id: string; version: number }[]>(
    "SELECT id, version FROM orders WHERE id=$1 AND user_id=$2",
    [orderId, ctx.actorUserId],
  );
  if (!o) return fail(err("NOT_FOUND", "주문을 찾을 수 없습니다"), trace_id);
  const [ship] = await sql.unsafe<
    {
      status: ShipmentEvent["status"]; events_json: ShipmentEvent[];
      estimated_arrival_at: string | null; updated_at: string;
    }[]
  >("SELECT * FROM shipments WHERE order_id=$1", [o.id]);

  if (!ship)
    return ok(
      {
        order_id: o.id,
        order_version: o.version,
        information: "NO_INFORMATION",
        status: null,
        events: [],
        estimated_arrival_at: null,
        updated_at: null,
      },
      trace_id,
    );
  return ok(
    {
      order_id: o.id,
      order_version: o.version,
      information: "AVAILABLE",
      status: ship.status,
      events: ship.events_json,
      estimated_arrival_at: ship.estimated_arrival_at
        ? new Date(ship.estimated_arrival_at).toISOString()
        : null,
      updated_at: new Date(ship.updated_at).toISOString(),
    },
    trace_id,
  );
}

// ---- 내부 시뮬레이터용 상태 전환 (Agent Tool·사용자 API에 노출하지 않는다) ----
// 주문 행을 잠그고 공통 규칙으로 검증한다. Phase 4 취소 경합 차단도 같은 잠금을 쓴다.

export async function shipOrder(orderId: string): Promise<ToolResult<{ status: string }>> {
  const trace_id = crypto.randomUUID();
  return sql.begin(async (q) => {
    const [o] = await q.unsafe<{ id: string; status: string }[]>(
      "SELECT id, status FROM orders WHERE id=$1 FOR UPDATE", [orderId],
    );
    if (!o) return fail(err("NOT_FOUND", "주문 없음"), trace_id);
    if (o.status !== "CONFIRMED")
      return fail(err("INVALID_STATE", "주문 상태 " + o.status), trace_id);
    // cancel_requests 테이블은 Phase 4 — 카탈로그 조회로 존재 여부를 확인한다.
    // (tx 안에서 실패 쿼리를 catch로 넘기면 트랜잭션 자체가 abort된다)
    let cancelCount = 0;
    const [reg] = await q.unsafe<{ r: string | null }[]>(
      "SELECT to_regclass('public.cancel_requests') AS r",
    );
    if (reg.r) {
      const [c] = await q.unsafe<{ c: number }[]>(
        "SELECT count(*)::int AS c FROM cancel_requests WHERE order_id=$1",
        [orderId],
      );
      cancelCount = c.c;
    }
    if (cancelCount > 0)
      return fail(err("INVALID_STATE", "취소 접수된 주문은 출고 불가"), trace_id);
    const [s] = await q.unsafe<{ id: string; status: string; events_json: ShipmentEvent[] }[]>(
      "SELECT id, status, events_json FROM shipments WHERE order_id=$1 FOR UPDATE",
      [orderId],
    );
    if (!s || s.status !== "PREPARING")
      return fail(err("INVALID_STATE", "출고 가능 상태가 아님: " + (s?.status ?? "no shipment")), trace_id);
    const ev = [...s.events_json, { status: "IN_TRANSIT" as const, occurred_at: new Date().toISOString(), note: "배송 시작 (모의)" }];
    await q.unsafe(
      "UPDATE shipments SET status='IN_TRANSIT', events_json=$2::jsonb, updated_at=now() WHERE id=$1",
      [s.id, ev as unknown as postgres.JSONValue],
    );
    await q.unsafe("UPDATE orders SET version=version+1 WHERE id=$1", [orderId]);
    return ok({ status: "IN_TRANSIT" }, trace_id);
  });
}

export async function deliverOrder(orderId: string): Promise<ToolResult<{ status: string }>> {
  const trace_id = crypto.randomUUID();
  return sql.begin(async (q) => {
    const [o] = await q.unsafe<{ id: string; status: string }[]>(
      "SELECT id, status FROM orders WHERE id=$1 FOR UPDATE", [orderId],
    );
    if (!o) return fail(err("NOT_FOUND", "주문 없음"), trace_id);
    const [s] = await q.unsafe<{ id: string; status: string; events_json: ShipmentEvent[] }[]>(
      "SELECT id, status, events_json FROM shipments WHERE order_id=$1 FOR UPDATE",
      [orderId],
    );
    if (!s) return fail(err("NO_INFORMATION", "배송 레코드 없음"), trace_id);
    if (s.status !== "IN_TRANSIT")
      return fail(err("INVALID_STATE", "배송 중이 아님: " + s.status), trace_id);
    const ev = [...s.events_json, { status: "DELIVERED" as const, occurred_at: new Date().toISOString(), note: "배송 완료 (모의)" }];
    await q.unsafe(
      "UPDATE shipments SET status='DELIVERED', events_json=$2::jsonb, updated_at=now() WHERE id=$1",
      [s.id, ev as unknown as postgres.JSONValue],
    );
    await q.unsafe("UPDATE orders SET version=version+1 WHERE id=$1", [orderId]);
    return ok({ status: "DELIVERED" }, trace_id);
  });
}
