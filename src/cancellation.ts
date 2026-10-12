// T3 취소 서비스. DATA_TOOL_DESIGN 4.3~4.4, 8.1 계약.
// - 자격·환불액·상태 전환은 여기서만 판정한다 (LLM 추정 금지).
// - 실행은 A02 최종 확인이 만든 action_requests(READY)가 있어야 한다.
//   승인 id와 실행 operation_id는 같은 행이다.
// - 최종 취소(completeCancellation)·모의 환불(completeRefund)은 내부 시뮬레이터만 호출한다.
import { sql, type Q } from "./db.ts";
import { config } from "./config.ts";
import {
  ok, fail, err,
  type CancelEligibilityResult, type CancelQuoteResult, type CancelReasonCode,
  type CancelRequestResult, type ShipmentEvent, type ToolError, type ToolResult,
} from "./contracts.ts";
import { payloadHash } from "./actions.ts";
import { getOrder } from "./orders.ts";
import type { RequestContext } from "./session.ts";
import { createHmac, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { evaluateCancelFacts, type CancelFacts } from "./cancel-policy.ts";

// 정책 자체는 cancel-policy.ts가 단일 Source다 — 여기서는 기존 import 경로를 위해
// 그대로 재export한다 [PMQA-06B-053 MJ053-1].
export { evaluateCancelFacts, type CancelFacts } from "./cancel-policy.ts";

export const POLICY_VERSION = "p0-v1"; // 프로젝트 정책 버전 — 실제 토스 정책이 아니다.
export const REASON_CODES: CancelReasonCode[] = ["ORDER_MISTAKE", "CHANGE_OF_MIND", "OTHER"];
const QUOTE_TTL_MS = 5 * 60 * 1000;

// ---- 자격 판정 (pure — 테스트 표의 대상)은 cancel-policy.ts로 이동했다 ----

type OrderLite = { id: string; status: string; total_won: number; version: number };

// 소유권 스코프로 주문+결제+배송+취소 여부를 함께 읽는다. forUpdate로 잠글 수 있다.
async function loadCancelFacts(
  q: Q,
  orderId: string,
  userId: string,
  forUpdate = false,
): Promise<{ order: OrderLite; facts: CancelFacts } | null> {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const os = await q.unsafe<OrderLite[]>(
    "SELECT id, status, total_won, version FROM orders WHERE id=$1 AND user_id=$2" + lock,
    [orderId, userId],
  );
  const o = os[0];
  if (!o) return null;
  const pays = await q.unsafe<{ status: string; refund_status: string; paid_amount_won: number }[]>(
    "SELECT status, refund_status, paid_amount_won FROM payments WHERE order_id=$1" + lock,
    [orderId],
  );
  const ships = await q.unsafe<{ status: string }[]>(
    "SELECT status FROM shipments WHERE order_id=$1" + lock,
    [orderId],
  );
  const cs = await q.unsafe<{ c: number }[]>(
    "SELECT 1 AS c FROM cancel_requests WHERE order_id=$1 LIMIT 1" + lock,
    [orderId],
  );
  return {
    order: o,
    facts: {
      order_status: o.status,
      order_total_won: o.total_won,
      payment: pays[0] ?? null,
      has_cancel_request: cs.length > 0,
      shipment_status: ships[0]?.status ?? null,
    },
  };
}

// ---- READ Tool: 자격 조회 / 견적 ----

export async function checkCancelEligibility(
  ctx: RequestContext,
  orderId: string,
): Promise<ToolResult<CancelEligibilityResult>> {
  const trace_id = crypto.randomUUID();
  const f = await loadCancelFacts(sql, orderId, ctx.actorUserId);
  if (!f) return fail(err("NOT_FOUND", "주문을 찾을 수 없습니다"), trace_id);
  const ev = evaluateCancelFacts(f.facts);
  return ok(
    {
      order_id: orderId,
      order_version: f.order.version,
      eligible: ev.eligible,
      reasons: ev.reasons,
      policy_version: POLICY_VERSION,
    },
    trace_id,
  );
}

interface CancelQuotePayload {
  user_id: string;
  order_id: string;
  order_version: number;
  reason_code: CancelReasonCode;
  refund_amount_won: number;
  policy_version: string;
  expires_at: string;
}

const signQuote = (body: string) =>
  createHmac("sha256", config.sessionSecret).update("cancel:" + body).digest("base64url");

// 서명된 불투명 견적 토큰 발급. 사용자·주문·버전·사유·금액·정책에 묶인다.
// export 이유: 테스트가 만료/위조 토큰을 만들 수 있어야 한다.
export function issueCancelToken(p: CancelQuotePayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return body + "." + signQuote(body);
}

function readCancelToken(token: string, userId: string): CancelQuotePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || signQuote(body) !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as CancelQuotePayload;
    if (p.user_id !== userId) return null;
    return p;
  } catch {
    return null;
  }
}

export async function getCancelQuote(
  ctx: RequestContext,
  orderId: string,
  reasonCode: string,
): Promise<ToolResult<CancelQuoteResult>> {
  const trace_id = crypto.randomUUID();
  if (!REASON_CODES.includes(reasonCode as CancelReasonCode))
    return fail(err("VALIDATION", "reason_code는 ORDER_MISTAKE/CHANGE_OF_MIND/OTHER 중 하나입니다"), trace_id);
  const f = await loadCancelFacts(sql, orderId, ctx.actorUserId);
  if (!f) return fail(err("NOT_FOUND", "주문을 찾을 수 없습니다"), trace_id);
  const ev = evaluateCancelFacts(f.facts);
  const base = {
    order_id: orderId,
    order_version: f.order.version,
    eligible: ev.eligible,
    reasons: ev.reasons,
  };
  if (!ev.eligible) return ok({ ...base, quote: null }, trace_id);

  const refund = f.facts.payment!.paid_amount_won; // 저장된 실결제액 전액 — 현재 상품가와 무관
  const expires_at = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
  const token = issueCancelToken({
    user_id: ctx.actorUserId,
    order_id: orderId,
    order_version: f.order.version,
    reason_code: reasonCode as CancelReasonCode,
    refund_amount_won: refund,
    policy_version: POLICY_VERSION,
    expires_at,
  });
  return ok(
    {
      ...base,
      quote: {
        order_id: orderId,
        order_version: f.order.version,
        reason_code: reasonCode as CancelReasonCode,
        refund_amount_won: refund,
        currency: "KRW",
        policy_version: POLICY_VERSION,
        expires_at,
        quote_token: token,
      },
    },
    trace_id,
  );
}

// ---- A02 승인 등록 (UI 전용 — Agent Tool이 아니다) ----

type ApprovalRow = {
  id: string;
  status: "READY" | "SUCCEEDED" | "REJECTED";
  payload_json: { order_id: string; reason_code: CancelReasonCode; expected_order_version: number; refund_amount_won: number };
  payload_hash: string;
  expires_at: string | null;
  result_json: unknown;
  error_code: string | null;
};

// 견적 토큰·최신 상태를 검증하고 승인 행동 요청(READY)을 저장한다.
// 같은 행동 키는 같은 승인을 돌려준다 — 승인 응답 유실은 kind+key로 복구된다.
export async function approveCancel(
  ctx: RequestContext,
  orderId: string,
  input: { quote_token?: string; reason_code?: string; action_key?: string },
): Promise<ToolResult<{ confirmation_id: string; status: string; expires_at: string }>> {
  const trace_id = crypto.randomUUID();
  // 승인은 인증된 UI 요청에만 만들어진다. Agent origin은 어떤 경로로든 승인을 만들 수 없다.
  if (ctx.origin !== "UI")
    return fail(err("FORBIDDEN", "취소 확인은 인증된 사용자 화면에서만 등록할 수 있습니다"), trace_id);
  if (!input.action_key || !input.quote_token || !input.reason_code)
    return fail(err("VALIDATION", "quote_token·reason_code·action_key가 필요합니다"), trace_id);
  if (!REASON_CODES.includes(input.reason_code as CancelReasonCode))
    return fail(err("VALIDATION", "reason_code가 올바르지 않습니다"), trace_id);

  const quote = readCancelToken(input.quote_token, ctx.actorUserId);
  if (!quote)
    return fail(err("VALIDATION", "취소 확인 정보가 유효하지 않습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);
  if (quote.order_id !== orderId || quote.reason_code !== input.reason_code)
    return fail(err("CONFIRMATION_STALE", "확인한 대상/사유와 다릅니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);
  if (new Date(quote.expires_at).getTime() < Date.now())
    return fail(err("CONFIRMATION_EXPIRED", "취소 확인 정보가 만료되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);

  // 승인 시점에도 최신 자격·버전을 검증한다 — 승인 후 상태가 바뀌면 실행 단계에서 한 번 더 걸러진다.
  const f = await loadCancelFacts(sql, orderId, ctx.actorUserId);
  if (!f) return fail(err("NOT_FOUND", "주문을 찾을 수 없습니다"), trace_id);
  const ev = evaluateCancelFacts(f.facts);
  if (!ev.eligible)
    return fail(
      err("CANCEL_NOT_ELIGIBLE", ev.reasons.map((r) => r.message).join(" ")),
      trace_id,
    );
  if (f.order.version !== quote.order_version)
    return fail(err("CONFIRMATION_STALE", "주문 상태가 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM"), trace_id);

  const payload = {
    order_id: orderId,
    reason_code: input.reason_code,
    expected_order_version: quote.order_version,
    refund_amount_won: quote.refund_amount_won,
    policy_version: POLICY_VERSION,
  };
  const hash = payloadHash(payload);

  // 멱등 승인: 같은 키 + 같은 내용 → 기존 승인, 같은 키 + 다른 내용 → 충돌.
  const existing = await sql.unsafe<ApprovalRow[]>(
    "SELECT * FROM action_requests WHERE actor_user_id=$1 AND kind='CANCEL_ORDER' AND idempotency_key=$2",
    [ctx.actorUserId, input.action_key],
  );
  if (existing[0]) {
    if (existing[0].payload_hash !== hash)
      return fail(err("IDEMPOTENCY_CONFLICT", "같은 키에 다른 요청 내용입니다"), trace_id);
    return ok(
      { confirmation_id: existing[0].id, status: existing[0].status, expires_at: quote.expires_at },
      trace_id,
    );
  }
  try {
    const rows = await sql.unsafe<{ id: string }[]>(
      "INSERT INTO action_requests (id, actor_user_id, kind, idempotency_key, payload_json, payload_hash, status, confirmed_at, expires_at) " +
        "VALUES ($1,$2,'CANCEL_ORDER',$3,$4::jsonb,$5,'READY',now(),$6) RETURNING id",
      [randomUUID(), ctx.actorUserId, input.action_key, payload as unknown as postgres.JSONValue, hash, quote.expires_at],
    );
    return ok({ confirmation_id: rows[0].id, status: "READY", expires_at: quote.expires_at }, trace_id);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      const again = await sql.unsafe<ApprovalRow[]>(
        "SELECT * FROM action_requests WHERE actor_user_id=$1 AND kind='CANCEL_ORDER' AND idempotency_key=$2",
        [ctx.actorUserId, input.action_key],
      );
      if (again[0])
        return ok(
          { confirmation_id: again[0].id, status: again[0].status, expires_at: quote.expires_at },
          trace_id,
        );
    }
    throw e;
  }
}

// ---- 공통 취소 실행: UI execute 경로와 Agent request_cancel_order가 같은 함수를 쓴다 ----

interface StoredCancelResult {
  cancel_request_id: string;
  status: "REQUESTED";
  refund_amount_won: number;
  order_id: string;
}

export type CancelExecuteResult = ToolResult<CancelRequestResult> & {
  operation_id?: string;
  action_status?: "SUCCEEDED" | "REJECTED";
  replayed?: boolean;
};

export async function requestCancelOrder(
  ctx: RequestContext,
  input: { order_id?: string; reason_code?: string; confirmation_id?: string },
): Promise<CancelExecuteResult> {
  const trace_id = crypto.randomUUID();

  // tx는 승인 행을 잠그고 READY → SUCCEEDED/REJECTED로 확정한다.
  // 반환: 실행 결과 + 확정된 행 id/상태 (결과 복원은 같은 행에서만).
  const r = await sql.begin(async (q): Promise<{
    res: ToolResult<StoredCancelResult>;
    rowId?: string;
    status?: "SUCCEEDED" | "REJECTED";
    replayed?: boolean;
  }> => {
    let rows: ApprovalRow[];
    if (input.confirmation_id) {
      rows = await q.unsafe<ApprovalRow[]>(
        "SELECT * FROM action_requests WHERE id=$1 AND actor_user_id=$2 AND kind='CANCEL_ORDER' FOR UPDATE",
        [input.confirmation_id, ctx.actorUserId],
      );
      if (!rows[0])
        return { res: fail(err("NOT_FOUND", "취소 확인을 찾을 수 없습니다"), trace_id) };
    } else if (input.order_id) {
      // 소유권을 상세 정보 반환보다 먼저 검사한다.
      const own = await q.unsafe<{ id: string }[]>(
        "SELECT id FROM orders WHERE id=$1 AND user_id=$2",
        [input.order_id, ctx.actorUserId],
      );
      if (!own[0])
        return { res: fail(err("NOT_FOUND", "주문을 찾을 수 없습니다"), trace_id) };
      rows = await q.unsafe<ApprovalRow[]>(
        "SELECT * FROM action_requests WHERE actor_user_id=$1 AND kind='CANCEL_ORDER' AND status='READY' " +
          "AND payload_json->>'order_id'=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [ctx.actorUserId, input.order_id],
      );
      if (!rows[0])
        return {
          res: fail(
            err("CONFIRMATION_REQUIRED", "사용자 최종 확인이 필요합니다. 주문 상세의 취소 확인을 눌러 주세요.", "STOP"),
            trace_id,
          ),
        };
    } else {
      return { res: fail(err("VALIDATION", "order_id 또는 confirmation_id가 필요합니다"), trace_id) };
    }

    const row = rows[0];
    const p = row.payload_json;

    if (row.status === "SUCCEEDED")
      return {
        res: ok(row.result_json as StoredCancelResult, trace_id),
        rowId: row.id, status: "SUCCEEDED", replayed: true,
      };
    if (row.status === "REJECTED")
      return {
        res: fail(
          (row.result_json as ToolError) ??
            err(row.error_code ?? "REJECTED", "이전에 거절된 요청입니다"),
          trace_id,
        ),
        rowId: row.id, status: "REJECTED", replayed: true,
      };

    // READY: 거절은 업무 변경 없이 같은 행을 REJECTED로 확정한다.
    const reject = async (code: string, message: string, recovery: "RETRY_READ" | "REFRESH_AND_RECONFIRM" | "CHECK_OPERATION" | "STOP" = "STOP") => {
      const e = err(code, message, recovery);
      await q.unsafe(
        "UPDATE action_requests SET status='REJECTED', error_code=$2, result_json=$3::jsonb, completed_at=now() WHERE id=$1",
        [row.id, code, e as unknown as postgres.JSONValue],
      );
      return { res: fail<StoredCancelResult>(e, trace_id), rowId: row.id, status: "REJECTED" as const };
    };

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now())
      return reject("CONFIRMATION_EXPIRED", "취소 확인이 만료되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM");
    if (input.order_id && input.order_id !== p.order_id)
      return reject("CONFIRMATION_STALE", "확인한 주문과 다른 주문입니다", "REFRESH_AND_RECONFIRM");
    if (input.reason_code && input.reason_code !== p.reason_code)
      return reject("CONFIRMATION_STALE", "확인한 사유와 다릅니다", "REFRESH_AND_RECONFIRM");

    // 주문 행 잠금 — 출고(shipOrder)와 같은 잠금으로 직렬화된다.
    const f = await loadCancelFacts(q, p.order_id, ctx.actorUserId, true);
    if (!f) return reject("NOT_FOUND", "주문을 찾을 수 없습니다");
    if (f.order.version !== p.expected_order_version)
      return reject("CONFIRMATION_STALE", "주문 상태가 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM");
    const ev = evaluateCancelFacts(f.facts);
    if (!ev.eligible)
      return reject("CANCEL_NOT_ELIGIBLE", ev.reasons.map((x) => x.message).join(" "));
    if (f.facts.payment!.paid_amount_won !== p.refund_amount_won)
      return reject("CONFIRMATION_STALE", "환불 금액이 변경되었습니다. 다시 확인해 주세요.", "REFRESH_AND_RECONFIRM");

    const cancelId = "cxl-" + randomUUID().slice(0, 8);
    await q.unsafe(
      "INSERT INTO cancel_requests (id, order_id, action_request_id, reason_code, status, refund_amount_won) " +
        "VALUES ($1,$2,$3,$4,'REQUESTED',$5)",
      [cancelId, p.order_id, row.id, p.reason_code, f.facts.payment!.paid_amount_won],
    );
    await q.unsafe("UPDATE orders SET version=version+1 WHERE id=$1", [p.order_id]);
    const result: StoredCancelResult = {
      cancel_request_id: cancelId,
      status: "REQUESTED",
      refund_amount_won: f.facts.payment!.paid_amount_won,
      order_id: p.order_id,
    };
    await q.unsafe(
      "UPDATE action_requests SET status='SUCCEEDED', result_json=$2::jsonb, completed_at=now() WHERE id=$1",
      [row.id, result as unknown as postgres.JSONValue],
    );
    return { res: ok(result, trace_id), rowId: row.id, status: "SUCCEEDED" as const };
  });

  const base = { operation_id: r.rowId, action_status: r.status, replayed: r.replayed };
  if (!r.res.ok) return { ...r.res, ...base };
  // 최초 접수 결과 + 현재 주문 상태는 따로 재조회한다 (DTD 8.1/178행).
  const ord = await getOrder(ctx, r.res.data.order_id);
  const data: CancelRequestResult = {
    cancel_request_id: r.res.data.cancel_request_id,
    status: "REQUESTED",
    refund_amount_won: r.res.data.refund_amount_won,
    order: ord.ok ? ord.data : null,
  };
  return { ok: true, data, observed_at: new Date().toISOString(), trace_id, ...base };
}

// ---- 내부 시뮬레이터: 최종 취소 처리 / 모의 환불 (Tool·사용자 API에 노출하지 않는다) ----

// REQUESTED → 주문/배송 CANCELLED + 취소 COMPLETED + 재고 1회 복원 + 환불 PENDING.
// 한 트랜잭션이라 중간 실패는 이전 단계에 남고, 재실행해도 재고·금액이 늘지 않는다.
export async function completeCancellation(
  orderId: string,
): Promise<ToolResult<{ status: string }>> {
  const trace_id = crypto.randomUUID();
  return sql.begin(async (q) => {
    const os = await q.unsafe<{ id: string; status: string }[]>(
      "SELECT id, status FROM orders WHERE id=$1 FOR UPDATE", [orderId],
    );
    const o = os[0];
    if (!o) return fail(err("NOT_FOUND", "주문 없음"), trace_id);
    const cs = await q.unsafe<{ id: string; status: string }[]>(
      "SELECT id, status FROM cancel_requests WHERE order_id=$1 FOR UPDATE", [orderId],
    );
    const c = cs[0];
    if (!c) return fail(err("INVALID_STATE", "취소 요청이 없습니다"), trace_id);
    if (c.status === "COMPLETED") return ok({ status: "COMPLETED" }, trace_id); // 재실행 안전
    if (o.status !== "CONFIRMED")
      return fail(err("INVALID_STATE", "주문 상태가 CONFIRMED가 아님: " + o.status), trace_id);

    const ss = await q.unsafe<{ id: string; status: string; events_json: ShipmentEvent[] }[]>(
      "SELECT id, status, events_json FROM shipments WHERE order_id=$1 FOR UPDATE", [orderId],
    );
    const s = ss[0];
    if (s && s.status !== "PREPARING" && s.status !== "CANCELLED")
      return fail(err("INVALID_STATE", "출고된 주문은 취소 처리 불가: " + s.status), trace_id);
    if (s && s.status === "PREPARING") {
      const ev = [
        ...s.events_json,
        { status: "CANCELLED" as const, occurred_at: new Date().toISOString(), note: "주문 취소로 배송 종료 (모의)" },
      ];
      await q.unsafe(
        "UPDATE shipments SET status='CANCELLED', events_json=$2::jsonb, updated_at=now() WHERE id=$1",
        [s.id, ev as unknown as postgres.JSONValue],
      );
    }

    // 재고 복원은 REQUESTED→COMPLETED 전환 안에서만 일어나므로 정확히 1회다.
    const items = await q.unsafe<{ variant_id: string; quantity: number }[]>(
      "SELECT variant_id, quantity FROM order_items WHERE order_id=$1", [orderId],
    );
    for (const it of items)
      await q.unsafe(
        "UPDATE product_variants SET stock_qty=stock_qty+$2, version=version+1 WHERE id=$1",
        [it.variant_id, it.quantity],
      );

    await q.unsafe(
      "UPDATE payments SET refund_status='PENDING' WHERE order_id=$1 AND refund_status='NONE'",
      [orderId],
    );
    await q.unsafe(
      "UPDATE orders SET status='CANCELLED', cancelled_at=now(), version=version+1 WHERE id=$1",
      [orderId],
    );
    await q.unsafe(
      "UPDATE cancel_requests SET status='COMPLETED', completed_at=now() WHERE id=$1",
      [c.id],
    );
    return ok({ status: "COMPLETED" }, trace_id);
  });
}

// 모의 환불: 주문 CANCELLED + 취소 COMPLETED + 환불 PENDING일 때 전액 1회만.
export async function completeRefund(
  orderId: string,
): Promise<ToolResult<{ status: string; refunded_amount_won: number }>> {
  const trace_id = crypto.randomUUID();
  return sql.begin(async (q) => {
    const os = await q.unsafe<{ id: string; status: string }[]>(
      "SELECT id, status FROM orders WHERE id=$1 FOR UPDATE", [orderId],
    );
    const o = os[0];
    if (!o) return fail(err("NOT_FOUND", "주문 없음"), trace_id);
    const ps = await q.unsafe<
      { id: string; refund_status: string; paid_amount_won: number; refunded_amount_won: number }[]
    >("SELECT id, refund_status, paid_amount_won, refunded_amount_won FROM payments WHERE order_id=$1 FOR UPDATE", [orderId]);
    const p = ps[0];
    if (!p) return fail(err("INVALID_STATE", "결제 정보가 없습니다"), trace_id);
    if (p.refund_status === "REFUNDED")
      return ok({ status: "REFUNDED", refunded_amount_won: p.refunded_amount_won }, trace_id); // 멱등

    const cs = await q.unsafe<{ status: string }[]>(
      "SELECT status FROM cancel_requests WHERE order_id=$1", [orderId],
    );
    if (o.status !== "CANCELLED" || cs[0]?.status !== "COMPLETED" || p.refund_status !== "PENDING")
      return fail(
        err("INVALID_STATE", "환불 가능 상태가 아님 (주문 " + o.status + ", 취소 " + (cs[0]?.status ?? "없음") + ", 환불 " + p.refund_status + ")"),
        trace_id,
      );
    await q.unsafe(
      "UPDATE payments SET refund_status='REFUNDED', refunded_amount_won=paid_amount_won, refunded_at=now() WHERE id=$1",
      [p.id],
    );
    await q.unsafe("UPDATE orders SET version=version+1 WHERE id=$1", [orderId]);
    return ok({ status: "REFUNDED", refunded_amount_won: p.paid_amount_won }, trace_id);
  });
}
