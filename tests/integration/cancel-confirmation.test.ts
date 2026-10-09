// Phase 4 취소 승인·확인 경계: 승인 없이는 접수되지 않고, 위조/만료/변경은 전부 거절된다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { addToCart, getCart } from "../../src/cart.ts";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import {
  approveCancel, checkCancelEligibility, getCancelQuote,
  issueCancelToken, requestCancelOrder, POLICY_VERSION,
} from "../../src/cancellation.ts";
import { executeTool, toolDefs } from "../../src/agent.ts";
import { sql } from "../../src/db.ts";

const A_UI = { actorUserId: "u-a", origin: "UI" as const };
const A_AGT = { actorUserId: "u-a", origin: "AGENT" as const };
const B_UI = { actorUserId: "u-b", origin: "UI" as const };
const C_UI = { actorUserId: "u-c", origin: "UI" as const };

const vver = async (id: string) =>
  (await sql.unsafe<{ version: number }[]>(
    "SELECT version FROM product_variants WHERE id=$1", [id]))[0].version;

// u-c 전용 주문 생성 (시나리오 seed를 건드리지 않는다)
async function createOrder(variantId = "v-b-24") {
  const c = await getCart(C_UI);
  assert.ok(c.ok);
  const add = await addToCart(
    { variant_id: variantId, quantity: 1, expected_cart_version: c.data.version, expected_variant_version: await vver(variantId) },
    C_UI, "cxl-add-" + crypto.randomUUID().slice(0, 8),
  );
  assert.ok(add.ok, JSON.stringify(add));
  const q = await checkoutQuote(C_UI);
  assert.ok(q.ok);
  const co = await confirmCheckout(q.data.quote_token, C_UI, "cxl-co-" + crypto.randomUUID().slice(0, 8));
  assert.ok(co.ok, JSON.stringify(co));
  return co.data.order_id;
}

async function approve(ctx: { actorUserId: string; origin: "UI" }, orderId: string, reason = "CHANGE_OF_MIND", key?: string) {
  const q = await getCancelQuote(ctx, orderId, reason);
  assert.ok(q.ok && q.data.quote, JSON.stringify(q));
  const ap = await approveCancel(ctx, orderId, {
    quote_token: q.data.quote.quote_token,
    reason_code: reason,
    action_key: key ?? "cxl-ap-" + crypto.randomUUID().slice(0, 8),
  });
  return { ap, quote: q.data.quote };
}

const cancelCount = async (orderId: string) =>
  (await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM cancel_requests WHERE order_id=$1", [orderId]))[0].c;

describe("phase4 cancel confirmation", () => {
  before(async () => {
    await ensureTestDb(4);
    await cleanUserData();
  });

  test("read tools: 자격/견적은 서버 판정, 불가 사유 코드 포함", async () => {
    const okRes = await checkCancelEligibility(A_UI, "ord-a-pre");
    assert.ok(okRes.ok && okRes.data.eligible, JSON.stringify(okRes));
    assert.equal(okRes.data.policy_version, POLICY_VERSION);

    const shipped = await checkCancelEligibility(A_UI, "ord-a-ship");
    assert.ok(shipped.ok && !shipped.data.eligible);
    assert.ok(shipped.data.reasons.some((r) => r.code === "ALREADY_SHIPPED"));

    const none = await checkCancelEligibility(B_UI, "ord-b-none");
    assert.ok(none.ok && !none.data.eligible);
    assert.ok(none.data.reasons.some((r) => r.code === "SHIPPING_UNVERIFIED"));

    const q = await getCancelQuote(A_UI, "ord-a-pre", "ORDER_MISTAKE");
    assert.ok(q.ok && q.data.quote);
    assert.equal(q.data.quote.refund_amount_won, 183000); // 실결제액 전액(배송비 포함)
    assert.equal(q.data.quote.policy_version, POLICY_VERSION);
    // 불가 주문은 견적 null
    const qx = await getCancelQuote(A_UI, "ord-a-ship", "ORDER_MISTAKE");
    assert.ok(qx.ok && qx.data.quote === null && !qx.data.eligible);
  });

  test("confirmation_required: 승인 없는 실행은 거절되고 취소 신청이 생기지 않는다", async () => {
    const orderId = await createOrder();
    const viaTool = await executeTool(
      "request_cancel_order", { order_id: orderId }, { actorUserId: "u-c", origin: "AGENT" }, "k1", "cs");
    assert.ok(!viaTool.ok);
    assert.equal((viaTool as { error: { code: string } }).error.code, "CONFIRMATION_REQUIRED");
    const viaUi = await requestCancelOrder(C_UI, { order_id: orderId });
    assert.ok(!viaUi.ok && viaUi.error.code === "CONFIRMATION_REQUIRED");
    assert.equal(await cancelCount(orderId), 0);
  });

  test("approval_api_not_agent_accessible: 승인은 UI 경로만 만든다", async () => {
    const orderId = await createOrder();
    const q = await getCancelQuote(C_UI, orderId, "OTHER");
    assert.ok(q.ok && q.data.quote);
    // Agent origin으로 approve 호출 → FORBIDDEN
    const ap = await approveCancel({ actorUserId: "u-c", origin: "AGENT" }, orderId, {
      quote_token: q.data.quote.quote_token, reason_code: "OTHER", action_key: "cxl-ap-agt",
    });
    assert.ok(!ap.ok && ap.error.code === "FORBIDDEN");
    // 승인 생성은 Tool registry에 없다
    const names = new Set([...toolDefs("shopping"), ...toolDefs("cs")].map((t) => t.function.name));
    assert.ok(![...names].some((n) => n.includes("approve") || n.includes("confirm")));
    const x = await executeTool("approve_cancel", {}, A_AGT, "k2", "cs");
    assert.ok(!x.ok && x.error.code === "TOOL_NOT_ALLOWED");
  });

  test("forged_actor_denied: 타인 주문·타인 승인·위조 토큰은 전부 차단", async () => {
    // u-b는 u-a 주문에 접근 못한다 (NOT_FOUND로 동일 응답)
    const el = await checkCancelEligibility(B_UI, "ord-a-pre");
    assert.ok(!el.ok && el.error.code === "NOT_FOUND");
    const qt = await getCancelQuote(B_UI, "ord-a-pre", "OTHER");
    assert.ok(!qt.ok && qt.error.code === "NOT_FOUND");

    // u-a가 만든 유효 견적 토큰을 u-b가 approve에 사용 → 토큰의 user_id 불일치
    const qa = await getCancelQuote(A_UI, "ord-a-pre", "OTHER");
    assert.ok(qa.ok && qa.data.quote);
    const ap = await approveCancel(B_UI, "ord-a-pre", {
      quote_token: qa.data.quote.quote_token, reason_code: "OTHER", action_key: "cxl-ap-forge",
    });
    assert.ok(!ap.ok && (ap.error.code === "VALIDATION" || ap.error.code === "CONFIRMATION_STALE" || ap.error.code === "NOT_FOUND"));

    // 위조 토큰
    const ap2 = await approveCancel(A_UI, "ord-a-pre", {
      quote_token: "forged.token", reason_code: "OTHER", action_key: "cxl-ap-forge2",
    });
    assert.ok(!ap2.ok && ap2.error.code === "VALIDATION");

    // u-a의 confirmation_id를 u-b가 실행 → 행이 actor 스코프라 NOT_FOUND
    const { ap: apA } = await approve(A_UI, "ord-a-pre");
    assert.ok(apA.ok);
    const ex = await requestCancelOrder(B_UI, { confirmation_id: apA.data.confirmation_id });
    assert.ok(!ex.ok && ex.error.code === "NOT_FOUND");
    // 방금 만든 승인을 정리하기 위해 실행해 둔다
    const done = await requestCancelOrder(A_UI, { confirmation_id: apA.data.confirmation_id });
    assert.ok(done.ok, JSON.stringify(done));
  });

  test("expired_or_changed_quote: 만료 토큰·버전 변경·사유 불일치는 거절", async () => {
    const orderId = await createOrder();
    // 만료된 견적 토큰 (서명은 유효)
    const expired = issueCancelToken({
      user_id: "u-c", order_id: orderId, order_version: 1,
      reason_code: "OTHER", refund_amount_won: 152000,
      policy_version: POLICY_VERSION, expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const ap0 = await approveCancel(C_UI, orderId, {
      quote_token: expired, reason_code: "OTHER", action_key: "cxl-ap-exp",
    });
    assert.ok(!ap0.ok && ap0.error.code === "CONFIRMATION_EXPIRED");

    // 정상 승인 후 주문 버전이 바뀌면 CONFIRMATION_STALE
    const { ap: ap1 } = await approve(C_UI, orderId, "OTHER", "cxl-ap-stale1");
    assert.ok(ap1.ok);
    await sql.unsafe("UPDATE orders SET version=version+1 WHERE id=$1", [orderId]);
    const ex1 = await requestCancelOrder(C_UI, { confirmation_id: ap1.data.confirmation_id });
    assert.ok(!ex1.ok && ex1.error.code === "CONFIRMATION_STALE");
    assert.equal(await cancelCount(orderId), 0);

    // 승인 사유와 다른 사유로 실행 → CONFIRMATION_STALE
    const { ap: ap2 } = await approve(C_UI, orderId, "OTHER", "cxl-ap-stale2");
    assert.ok(ap2.ok);
    const ex2 = await requestCancelOrder(C_UI, {
      confirmation_id: ap2.data.confirmation_id, reason_code: "ORDER_MISTAKE",
    });
    assert.ok(!ex2.ok && ex2.error.code === "CONFIRMATION_STALE");

    // 만료된 승인(READY) → CONFIRMATION_EXPIRED + 승인 무효화
    const { ap: ap3 } = await approve(C_UI, orderId, "OTHER", "cxl-ap-exp2");
    assert.ok(ap3.ok);
    await sql.unsafe(
      "UPDATE action_requests SET expires_at = now() - interval '1 second' WHERE id=$1",
      [ap3.data.confirmation_id]);
    const ex3 = await requestCancelOrder(C_UI, { confirmation_id: ap3.data.confirmation_id });
    assert.ok(!ex3.ok && ex3.error.code === "CONFIRMATION_EXPIRED");
    const [row] = await sql.unsafe<{ status: string; error_code: string }[]>(
      "SELECT status, error_code FROM action_requests WHERE id=$1", [ap3.data.confirmation_id]);
    assert.equal(row.status, "REJECTED");
    assert.equal(row.error_code, "CONFIRMATION_EXPIRED");
  });

  test("happy path: 승인 READY → 실행 → REQUESTED, 주문은 CONFIRMED 유지", async () => {
    const orderId = await createOrder();
    const { ap } = await approve(C_UI, orderId, "ORDER_MISTAKE", "cxl-ap-ok");
    assert.ok(ap.ok);
    const ex = await requestCancelOrder(C_UI, {
      order_id: orderId,
      confirmation_id: ap.data.confirmation_id,
    });
    assert.ok(ex.ok, JSON.stringify(ex));
    assert.equal(ex.action_status, "SUCCEEDED");
    assert.equal(ex.data.status, "REQUESTED");
    assert.equal(ex.data.refund_amount_won, 152000);
    assert.ok(ex.data.order && ex.data.order.cancel_request);
    assert.equal(ex.data.order?.status, "CONFIRMED"); // 접수는 주문 취소가 아니다
    assert.equal(await cancelCount(orderId), 1);
    const [row] = await sql.unsafe<{ status: string; reason_code: string }[]>(
      "SELECT status, reason_code FROM cancel_requests WHERE order_id=$1", [orderId]);
    assert.equal(row.status, "REQUESTED");
    assert.equal(row.reason_code, "ORDER_MISTAKE");
  });

  test("same_key_replays: 같은 승인/실행은 한 번만 반영된다", async () => {
    const orderId = await createOrder();
    const q = await getCancelQuote(C_UI, orderId, "OTHER");
    assert.ok(q.ok && q.data.quote);
    const a1 = await approveCancel(C_UI, orderId, {
      quote_token: q.data.quote.quote_token, reason_code: "OTHER", action_key: "cxl-ap-same",
    });
    const a2 = await approveCancel(C_UI, orderId, {
      quote_token: q.data.quote.quote_token, reason_code: "OTHER", action_key: "cxl-ap-same",
    });
    assert.ok(a1.ok && a2.ok);
    assert.equal(a1.data.confirmation_id, a2.data.confirmation_id);

    const e1 = await requestCancelOrder(C_UI, { confirmation_id: a1.data.confirmation_id });
    assert.ok(e1.ok);
    const e2 = await requestCancelOrder(C_UI, { confirmation_id: a1.data.confirmation_id });
    assert.ok(e2.ok && e2.replayed === true);
    assert.equal(e2.data.cancel_request_id, e1.data.cancel_request_id);
    assert.equal(await cancelCount(orderId), 1);
  });

  test("agent_executes_after_ui_approval: UI 승인만 CS Tool이 소비할 수 있다", async () => {
    const orderId = await createOrder();
    const { ap } = await approve(C_UI, orderId, "OTHER", "cxl-ap-agt-exec");
    assert.ok(ap.ok);
    // Agent는 confirmation_id 없이도 소유 주문의 READY 승인을 찾아 실행한다
    const ex = await executeTool(
      "request_cancel_order", { order_id: orderId },
      { actorUserId: "u-c", origin: "AGENT" }, "agt-cxl-1", "cs");
    assert.ok(ex.ok, JSON.stringify(ex));
    assert.equal((ex.data as { status: string }).status, "REQUESTED");
    assert.equal(await cancelCount(orderId), 1);
    // 추측한 confirmation_id는 안 통한다
    const bad = await executeTool(
      "request_cancel_order", { order_id: orderId, confirmation_id: "fake-id" },
      { actorUserId: "u-c", origin: "AGENT" }, "agt-cxl-2", "cs");
    assert.ok(!bad.ok && bad.error.code === "NOT_FOUND");
    // shopping brain에는 cs Tool이 없다
    const w = await executeTool("request_cancel_order", { order_id: orderId }, A_AGT, "agt-cxl-3", "shopping");
    assert.ok(!w.ok && w.error.code === "TOOL_NOT_ALLOWED");
  });

  test("double_cancel_blocked: 요청 접수 후 새 견적/승인/실행은 막힌다", async () => {
    const orderId = await createOrder();
    const { ap } = await approve(C_UI, orderId, "OTHER", "cxl-ap-dup");
    assert.ok(ap.ok);
    const e1 = await requestCancelOrder(C_UI, { confirmation_id: ap.data.confirmation_id });
    assert.ok(e1.ok);
    const el = await checkCancelEligibility(C_UI, orderId);
    assert.ok(el.ok && !el.data.eligible);
    assert.ok(el.data.reasons.some((r) => r.code === "CANCEL_ALREADY_REQUESTED"));
    const q = await getCancelQuote(C_UI, orderId, "OTHER");
    assert.ok(q.ok && q.data.quote === null);
    const { ap: ap2 } = await approve(C_UI, orderId, "OTHER", "cxl-ap-dup2")
      .catch(() => ({ ap: null }));
    assert.equal(ap2, null); // approve 자체가 CANCEL_NOT_ELIGIBLE로 거절
  });
});

// sql 풀 연결을 닫아야 서브프로세스가 종료하고 다음 파일로 진행된다.
// setup이 실패해 connectDb가 안 됐을 때는 닫을 pool이 없다 — ?.로 방어한다.
after(() => sql?.end());
